import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  EXPECTED,
  REQUIRED_SECRETS,
  blueVersion,
  checkHyperdrivePair,
  checkHyperdriveRemote,
  checkResendKey,
  checkSecretValues,
  checkStagingConfig,
  parseEnvFile,
  parseJsonOutput,
  parseWranglerConfig,
  pendingMigrationTag,
  planSecretUpload,
  requiredQueues,
  requiredSecrets,
  uploadedVersionId,
} from "./staging-gate.mjs";
import { cloudflare } from "./cloudflare-api.mjs";
import { probeHealth, verifyVersion, versionsDeploy } from "./staging-release.mjs";

/**
 * Staging deployment gate. Both modes fail closed (exit 1) when any prerequisite is unmet.
 *
 *   node scripts/staging-deploy.mjs --dry-run   # config + read-only remote checks + lint/typecheck/test/build
 *                                               # + wrangler packaging dry run; creates, uploads and migrates nothing
 *   node scripts/staging-deploy.mjs             # the same checks, then a blue-green release:
 *       1. blue = the version serving 100% of traffic; green = a new version uploaded with `wrangler versions upload`
 *       2. green is staged at 0% next to blue and verified through the Cloudflare-Workers-Version-Overrides header
 *       3. green is promoted to 100% in one step, then re-verified on live traffic; any failure restores blue
 *   The first deployment of a new Worker has no blue and uses `wrangler deploy` instead.
 *   `npm run deploy:staging:rollback` switches traffic back to the previous version.
 *
 * Blue and green share the staging database, so migrations must stay backward compatible with blue
 * (expand first, contract in a later release).
 *
 * STAGING_SECRETS_FILE defaults to ~/.config/medveris/staging/secrets.env and STAGING_RESEND_FILE to
 * ~/.config/medveris/staging/resend.env. Only secrets the Worker lacks are uploaded, so existing values are
 * never overwritten. This script never runs database migrations.
 */

const dryRun = process.argv.includes("--dry-run");
// Gradual uploads cannot apply Durable Object migrations; this flag allows one full `wrangler deploy` for them.
const applyDurableObjectMigrations = process.argv.includes("--apply-durable-object-migrations");
const ACCOUNT_ID = "6337ed24a5f8ff4ec3f74517a55a7e6b";
const DEFAULT_SECRETS_FILE = resolve(homedir(), ".config/medveris/staging/secrets.env");
const DEFAULT_RESEND_FILE = resolve(homedir(), ".config/medveris/staging/resend.env");
const problems = [];
const notes = [];

function capture(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function wrangler(...args) {
  return capture("npx", ["wrangler", ...args]);
}

function step(label, command, args) {
  console.log(`\nstaging gate: ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) problems.push(`${label} failed (exit ${result.status})`);
}

function insideRepo(path) {
  const rel = relative(process.cwd(), path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// 1. Effective staging configuration.
const config = parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
const staging = config.env?.staging ?? {};
problems.push(...checkStagingConfig(config));
if (config.account_id !== ACCOUNT_ID || (staging.account_id && staging.account_id !== ACCOUNT_ID)) {
  problems.push(`account_id must pin the MedVeris Cloudflare account (${ACCOUNT_ID})`);
}

// 2. Read-only remote verification.
const hyperdriveIds = Object.fromEntries((staging.hyperdrive ?? []).map((binding) => [binding.binding, binding.id]));
const remoteHyperdrive = {};
for (const binding of ["HYPERDRIVE", "HYPERDRIVE_JOBS"]) {
  const id = hyperdriveIds[binding];
  if (!/^[0-9a-f]{32}$/.test(id ?? "")) continue;
  const result = wrangler("hyperdrive", "get", id);
  remoteHyperdrive[binding] = result.status === 0 ? parseJsonOutput(result.stdout) : null;
  problems.push(...checkHyperdriveRemote(binding, remoteHyperdrive[binding]));
}
problems.push(...checkHyperdrivePair(remoteHyperdrive.HYPERDRIVE, remoteHyperdrive.HYPERDRIVE_JOBS));

const bucket = EXPECTED.bucket;
const bucketInfo = wrangler("r2", "bucket", "info", bucket, "--json");
if (bucketInfo.status !== 0 || parseJsonOutput(bucketInfo.stdout)?.name !== bucket) {
  problems.push(`R2 bucket ${bucket} was not found`);
} else {
  if (!/public access via the r2\.dev url is disabled/i.test(wrangler("r2", "bucket", "dev-url", "get", bucket).stdout)) {
    problems.push(`could not confirm that public r2.dev access is disabled for ${bucket}`);
  }
  if (!/there are no custom domains/i.test(wrangler("r2", "bucket", "domain", "list", bucket).stdout)) {
    problems.push(`could not confirm that ${bucket} has no public custom domains`);
  }
}

const secretList = wrangler("secret", "list", "--env", "staging", "--format", "json");
let remoteSecretNames;
if (secretList.status === 0 && Array.isArray(parseJsonOutput(secretList.stdout))) {
  remoteSecretNames = parseJsonOutput(secretList.stdout).map((secret) => secret.name);
} else if (/not found/i.test(secretList.stdout + secretList.stderr)) {
  remoteSecretNames = null;
  notes.push(`Worker ${EXPECTED.worker} does not exist yet, so no stored data depends on existing keys`);
} else {
  problems.push("could not list the staging Worker secrets");
}

for (const queue of requiredQueues(staging)) {
  if (wrangler("queues", "info", queue).status !== 0) {
    problems.push(`queue ${queue} does not exist; create it with \`npx wrangler queues create ${queue}\``);
  }
}

let pendingMigration = null;
if (remoteSecretNames) {
  const scripts = await cloudflare(`/accounts/${ACCOUNT_ID}/workers/scripts`).catch(() => null);
  const script = scripts?.success ? scripts.result.find((item) => item.id === EXPECTED.worker) : undefined;
  if (!script) problems.push("could not read the staging Worker's Durable Object migration state");
  else pendingMigration = pendingMigrationTag(staging, script.migration_tag ?? null);
  if (pendingMigration && !applyDurableObjectMigrations) {
    problems.push(`Durable Object migration ${pendingMigration} is not applied; gradual releases cannot apply it. Re-run with --apply-durable-object-migrations to release with \`wrangler deploy\` (all traffic moves at once, then health is verified and the previous version is restored on failure)`);
  }
  if (pendingMigration) notes.push(`Durable Object migration ${pendingMigration} will be applied by this release`);
}

const live = remoteSecretNames ? blueVersion(parseJsonOutput(wrangler("deployments", "status", "--env", "staging", "--json").stdout)) : { blue: null, problems: [] };
problems.push(...live.problems);
if (live.blue) notes.push(`blue (live) version is ${live.blue}`);

function readProtectedFile(path, label) {
  if (!existsSync(path)) return null;
  if (insideRepo(path)) problems.push(`the ${label} must be stored outside the repository`);
  if ((statSync(path).mode & 0o077) !== 0) problems.push(`the ${label} must be mode 0600`);
  return parseEnvFile(readFileSync(path, "utf8"));
}

const secretsFile = resolve(process.env.STAGING_SECRETS_FILE || DEFAULT_SECRETS_FILE);
const resendFile = resolve(process.env.STAGING_RESEND_FILE || DEFAULT_RESEND_FILE);
if (process.env.STAGING_SECRETS_FILE && !existsSync(secretsFile)) problems.push("STAGING_SECRETS_FILE does not exist");
if (process.env.STAGING_RESEND_FILE && !existsSync(resendFile)) problems.push("STAGING_RESEND_FILE does not exist");
const coreValues = readProtectedFile(secretsFile, "staging secrets file") ?? new Map();
const resendValues = readProtectedFile(resendFile, "Resend secrets file") ?? new Map();
const available = new Map([...coreValues, ...[...resendValues].filter(([name]) => name === "RESEND_API_KEY")]);
const secretPlan = remoteSecretNames === undefined
  ? { upload: [], problems: [], notes: [] }
  : planSecretUpload({ remoteNames: remoteSecretNames, availableNames: [...available.keys()], required: requiredSecrets(staging) });
problems.push(...secretPlan.problems);
notes.push(...secretPlan.notes);
if (secretPlan.upload.some((name) => REQUIRED_SECRETS.includes(name))) {
  const localValues = existsSync(".env") ? parseEnvFile(readFileSync(".env", "utf8")) : new Map();
  problems.push(...checkSecretValues(coreValues, localValues, staging.secrets?.required ?? requiredSecrets(staging)));
}
if (secretPlan.upload.includes("RESEND_API_KEY")) problems.push(...checkResendKey(available.get("RESEND_API_KEY")));

// 3. Quality gates and Worker packaging.
step("lint", "npm", ["run", "lint"]);
step("typecheck", "npm", ["run", "typecheck"]);
step("tests", "npm", ["test"]);
step("build", "npm", ["run", "build"]);
console.log("\nstaging gate: wrangler packaging dry run (no upload)");
const packaging = wrangler("deploy", "--env", "staging", "--dry-run", "--outdir", ".wrangler/dry-run");
process.stdout.write(packaging.stdout);
process.stderr.write(packaging.stderr);
if (packaging.status !== 0) problems.push(`wrangler deploy --dry-run failed (exit ${packaging.status})`);
if (/REPLACE_WITH|local-only/.test(packaging.stdout)) problems.push("the packaged staging bindings still contain placeholders");

// 4. Decision.
console.log("");
for (const note of notes) console.log(`staging gate: note: ${note}`);
console.log("staging gate: note: this script never runs database migrations");
if (problems.length) {
  console.error(`staging gate: BLOCKED with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("staging gate: no deployment occurred and nothing was uploaded");
  process.exit(1);
}
if (dryRun) {
  console.log("staging gate: PASS (dry run; nothing was created, uploaded, migrated or deployed)");
  process.exit(0);
}

/** Runs `fn` with a temporary 0600 secrets file holding only the secrets the Worker lacks. */
function withSecretsFile(fn) {
  if (!secretPlan.upload.length) return fn(null);
  const uploadDir = mkdtempSync(join(tmpdir(), "medveris-secrets-"));
  const uploadFile = join(uploadDir, "secrets.json");
  try {
    writeFileSync(uploadFile, JSON.stringify(Object.fromEntries(secretPlan.upload.map((name) => [name, available.get(name)]))), { mode: 0o600 });
    return fn(uploadFile);
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

// 5a. First deployment: there is no blue version yet.
if (remoteSecretNames === null) {
  const deploy = withSecretsFile((file) => spawnSync("npx", ["wrangler", "deploy", "--env", "staging", "--strict", ...(file ? ["--secrets-file", file] : [])], { stdio: "inherit" }));
  if (deploy.status !== 0) {
    console.error(`staging gate: wrangler deploy failed (exit ${deploy.status}); check \`npx wrangler deployments list --env staging\``);
    process.exit(deploy.status ?? 1);
  }
  const health = await probeHealth();
  console.log(`staging gate: first deployment of ${EXPECTED.worker}; live=${health.live} ready=${health.ready}`);
  process.exit(health.ok ? 0 : 1);
}

// 5a'. A Durable Object migration: one `wrangler deploy`, verified, with the previous version restored on failure.
if (pendingMigration) {
  const previous = live.blue;
  const deploy = withSecretsFile((file) => spawnSync("npx", ["wrangler", "deploy", "--env", "staging", "--strict", ...(file ? ["--secrets-file", file] : [])], { stdio: "inherit" }));
  if (deploy.status !== 0) {
    console.error(`staging release: wrangler deploy failed (exit ${deploy.status}); ${previous ? `blue ${previous} should still be live` : "check the deployment list"}`);
    process.exit(deploy.status ?? 1);
  }
  const health = await probeHealth();
  if (!health.ok && previous) {
    console.error(`staging release: health failed after applying ${pendingMigration}; restoring ${previous}`);
    versionsDeploy([`${previous}@100%`], `restore ${previous} after failed migration release`);
    process.exit(1);
  }
  console.log(`staging release: applied Durable Object migration ${pendingMigration}; live=${health.live} ready=${health.ready}`);
  process.exit(health.ok ? 0 : 1);
}

// 5b. Blue-green release. Blue keeps 100% of traffic until green passes its probes.
const blue = live.blue;
if (!blue) {
  console.error("staging gate: BLOCKED: could not determine the blue version");
  process.exit(1);
}
const commit = capture("git", ["rev-parse", "--short", "HEAD"]).stdout.trim() || "unknown";
const subject = capture("git", ["log", "-1", "--format=%s"]).stdout.trim().slice(0, 100);
const dirty = capture("git", ["status", "--porcelain"]).stdout.trim() !== "";
console.log(`\nstaging release: blue=${blue}; uploading green from ${commit}${dirty ? " (uncommitted changes)" : ""}`);

const upload = withSecretsFile((file) => capture("npx", [
  "wrangler", "versions", "upload", "--env", "staging",
  "--tag", `${commit}${dirty ? "-dirty" : ""}`, "--message", subject || "staging release",
  ...(file ? ["--secrets-file", file] : []),
]));
process.stdout.write(upload.stdout);
process.stderr.write(upload.stderr);
const green = uploadedVersionId(upload.stdout);
if (upload.status !== 0 || !green) {
  console.error("staging release: green upload failed; blue still serves all traffic");
  process.exit(1);
}

if (!versionsDeploy([`${blue}@100%`, `${green}@0%`], `stage green ${green} at 0%`)) {
  console.error("staging release: could not stage green; blue still serves all traffic");
  process.exit(1);
}

const expectedEntry = /src="(\/assets\/index-[^"]+\.js)"/.exec(readFileSync("apps/web/dist/index.html", "utf8"))?.[1];
const greenCheck = await verifyVersion(green, { override: true, expectedEntry });
if (!greenCheck.ok) {
  console.error(`staging release: green failed verification (${greenCheck.detail}); removing it`);
  versionsDeploy([`${blue}@100%`], `discard green ${green}`);
  process.exit(1);
}
console.log(`staging release: green verified through version override (${greenCheck.detail})`);

if (!versionsDeploy([`${green}@100%`], `promote green ${green} (${commit})`)) {
  console.error("staging release: promotion failed; restoring blue");
  versionsDeploy([`${blue}@100%`], `restore blue ${blue}`);
  process.exit(1);
}
const triggers = spawnSync("npx", ["wrangler", "triggers", "deploy", "--env", "staging"], { stdio: "inherit" });
if (triggers.status !== 0) console.error("staging release: warning: cron triggers were not updated; run `npx wrangler triggers deploy --env staging`");

const liveCheck = await verifyVersion(green, { override: false, expectedEntry });
if (!liveCheck.ok) {
  console.error(`staging release: green failed after promotion (${liveCheck.detail}); rolling back to blue ${blue}`);
  versionsDeploy([`${blue}@100%`], `automatic rollback to ${blue}`);
  process.exit(1);
}
console.log(`staging release: green ${green} now serves 100% of traffic (${liveCheck.detail})`);
console.log(`staging release: blue ${blue} remains available for instant rollback: npm run deploy:staging:rollback`);
