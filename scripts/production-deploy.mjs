import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { blueVersion, parseEnvFile, parseJsonOutput, parseWranglerConfig, planSecretUpload, requiredQueues, uploadedVersionId } from "./staging-gate.mjs";
import {
  PRODUCTION,
  PRODUCTION_SECRETS,
  checkBackupAttestation,
  requiredProductionSecrets,
  checkDomainState,
  checkMigrationState,
  checkProductionConfig,
  checkProductionHyperdrive,
  checkProductionIsolation,
  checkSmokeResponses,
  declaredDomains,
  migrationSetDigest,
  verificationOrigin,
} from "./production-gate.mjs";
import { secretFormatProblems } from "./production-secrets-lib.mjs";
import { ACCOUNT_ID, attachedDomains } from "./cloudflare-api.mjs";
import { createRelease } from "./release.mjs";

/**
 * Production deployment gate. Both modes fail closed (exit 1) when any prerequisite is unmet.
 *
 *   npm run deploy:production:check   # config, read-only remote checks (account, Hyperdrive isolation, R2, secrets,
 *                                     # migration state, backup verification, domain state), quality gates, build and
 *                                     # a Wrangler packaging dry run; creates, uploads, migrates and deploys nothing
 *   npm run deploy:production         # the same checks, then a blue-green release verified with health, readiness,
 *                                     # version metadata, current assets and production smoke checks
 *
 * Never runs migrations, resets data or attaches the domain (`npm run domain:production` does that after
 * verification). Every run writes release evidence without secret values to .wrangler/release-evidence/.
 */

const dryRun = process.argv.includes("--dry-run");
const secretDir = resolve(process.env.PRODUCTION_SECRETS_DIR || join(homedir(), ".config/medveris/production"));
const problems = [];
const notes = [];
const evidence = { environment: PRODUCTION.env, worker: PRODUCTION.worker, startedAt: new Date().toISOString(), dryRun, checks: {} };

function capture(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const wrangler = (...args) => capture("npx", ["wrangler", ...args]);

function step(label, command, args) {
  console.log(`\nproduction gate: ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  evidence.checks[label] = result.status === 0 ? "pass" : `fail (exit ${result.status})`;
  if (result.status !== 0) problems.push(`${label} failed (exit ${result.status})`);
}

function readProtectedEnv(path) {
  if (!existsSync(path)) return new Map();
  if ((statSync(path).mode & 0o077) !== 0) problems.push(`${path.split("/").pop()} must be mode 0600`);
  return parseEnvFile(readFileSync(path, "utf8"));
}

function writeEvidence() {
  const dir = resolve(".wrangler/release-evidence");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `production-${evidence.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`production gate: release evidence written to ${file}`);
}

function block() {
  console.log("");
  for (const note of notes) console.log(`production gate: note: ${note}`);
  console.error(`production gate: BLOCKED with ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("production gate: no deployment occurred and nothing was uploaded, migrated or attached");
  evidence.outcome = "blocked";
  evidence.problems = problems;
  writeEvidence();
  process.exit(1);
}

// 1. Configuration and account.
const config = parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
const production = config.env?.production ?? {};
problems.push(...checkProductionConfig(config));
if (config.account_id !== ACCOUNT_ID || (production.account_id && production.account_id !== ACCOUNT_ID)) {
  problems.push(`account_id must pin the MedVeris Cloudflare account (${ACCOUNT_ID})`);
}
const whoami = wrangler("whoami");
if (whoami.status !== 0 || !whoami.stdout.includes(ACCOUNT_ID)) problems.push("the Wrangler session cannot access the MedVeris Cloudflare account");
const commit = capture("git", ["rev-parse", "HEAD"]).stdout.trim() || "unknown";
const dirty = capture("git", ["status", "--porcelain"]).stdout.trim() !== "";
Object.assign(evidence, {
  commit,
  dirty,
  configDigest: createHash("sha256").update(JSON.stringify(production)).digest("hex"),
});
if (dirty && !dryRun) problems.push("the working tree has uncommitted changes; production releases are built from a commit");

// 2. Database: Hyperdrive bindings, isolation from staging, migration state and recovery.
const remoteHyperdrive = {};
for (const binding of production.hyperdrive ?? []) {
  if (!/^[0-9a-f]{32}$/.test(binding.id ?? "")) continue;
  const result = wrangler("hyperdrive", "get", binding.id);
  remoteHyperdrive[binding.binding] = result.status === 0 ? parseJsonOutput(result.stdout) : null;
  problems.push(...checkProductionHyperdrive(binding.binding, remoteHyperdrive[binding.binding]));
}
const stagingHyperdrive = (config.env?.staging?.hyperdrive ?? [])
  .map((binding) => parseJsonOutput(wrangler("hyperdrive", "get", binding.id).stdout))
  .filter(Boolean);
problems.push(...checkProductionIsolation({ runtime: remoteHyperdrive.HYPERDRIVE, jobs: remoteHyperdrive.HYPERDRIVE_JOBS }, stagingHyperdrive));

const migrationDir = resolve("packages/db/migrations");
const migrationFiles = await Promise.all((await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort()
  .map(async (version) => ({ version, body: readFileSync(join(migrationDir, version), "utf8") })));
evidence.migrations = { count: migrationFiles.length, latest: migrationFiles.at(-1)?.version, digest: migrationSetDigest(migrationFiles) };

let applied = null;
const dbEnvFile = join(secretDir, "db.env");
const migrationUrl = readProtectedEnv(dbEnvFile).get("MIGRATION_DATABASE_URL");
if (!migrationUrl) {
  problems.push(`production database credentials are not configured (${dbEnvFile} with MIGRATION_DATABASE_URL); migration state cannot be verified`);
} else {
  const client = new pg.Client({ connectionString: migrationUrl });
  try {
    await client.connect();
    await client.query("set default_transaction_read_only = on");
    const database = (await client.query("select current_database() as name")).rows[0].name;
    if (database !== PRODUCTION.database) problems.push(`db.env points at ${database}, not ${PRODUCTION.database}`);
    applied = (await client.query("select version from schema_migrations order by version")).rows.map((row) => row.version);
  } catch {
    applied = null;
  } finally {
    await client.end().catch(() => undefined);
  }
  problems.push(...checkMigrationState({ files: migrationFiles, applied }));
}
const backupFile = join(secretDir, "backup-verification.json");
const backup = existsSync(backupFile) ? parseJsonOutput(readFileSync(backupFile, "utf8")) : null;
problems.push(...checkBackupAttestation(backup, new Date()));
evidence.backupVerification = backup ? { provider: backup.provider, restoreDrillAt: backup.restoreDrillAt } : null;

// 3. Private R2 bucket.
for (const queue of requiredQueues(production)) {
  if (wrangler("queues", "info", queue).status !== 0) problems.push(`queue ${queue} does not exist; create it with \`npx wrangler queues create ${queue}\``);
}
const bucketInfo = wrangler("r2", "bucket", "info", PRODUCTION.bucket, "--json");
if (bucketInfo.status !== 0 || parseJsonOutput(bucketInfo.stdout)?.name !== PRODUCTION.bucket) {
  problems.push(`R2 bucket ${PRODUCTION.bucket} was not found`);
} else {
  if (!/public access via the r2\.dev url is disabled/i.test(wrangler("r2", "bucket", "dev-url", "get", PRODUCTION.bucket).stdout)) {
    problems.push(`could not confirm that public r2.dev access is disabled for ${PRODUCTION.bucket}`);
  }
  if (!/there are no custom domains/i.test(wrangler("r2", "bucket", "domain", "list", PRODUCTION.bucket).stdout)) {
    problems.push(`could not confirm that ${PRODUCTION.bucket} has no public custom domains`);
  }
}

// 4. Domain state: a deploy never attaches the domain.
const declared = declaredDomains(production);
const attached = await attachedDomains(PRODUCTION.worker).catch(() => null);
if (!attached) problems.push("Worker custom domains could not be listed");
problems.push(...checkDomainState({ declared, attached: attached ?? [], workersDev: production.workers_dev === true }));
const origin = verificationOrigin({ declared, attached: attached ?? [] });
evidence.verificationOrigin = origin;

// 5. Secrets: names only; values come from the protected production files and only missing names are uploaded.
const secretList = wrangler("secret", "list", "--env", PRODUCTION.env, "--format", "json");
let remoteSecretNames;
if (secretList.status === 0 && Array.isArray(parseJsonOutput(secretList.stdout))) {
  remoteSecretNames = parseJsonOutput(secretList.stdout).map((secret) => secret.name);
} else if (/does not exist|not found|code: 10007/i.test(secretList.stdout + secretList.stderr)) {
  remoteSecretNames = null;
  notes.push(`Worker ${PRODUCTION.worker} does not exist yet; this would be its first deployment`);
} else {
  problems.push("could not list the production Worker secrets");
}
const available = new Map([
  ...readProtectedEnv(join(secretDir, "secrets.env")),
  ...[...readProtectedEnv(join(secretDir, "resend.env"))].filter(([name]) => name === "RESEND_API_KEY"),
]);
const secretPlan = remoteSecretNames === undefined
  ? { upload: [], problems: [], notes: [] }
  : planSecretUpload({ remoteNames: remoteSecretNames, availableNames: [...available.keys()], required: requiredProductionSecrets(production) });
problems.push(...secretPlan.problems);
notes.push(...secretPlan.notes);
for (const name of secretPlan.upload) {
  if (PRODUCTION_SECRETS.includes(name)) problems.push(...secretFormatProblems(name, available.get(name) ?? "", new Set()));
}
evidence.secrets = { present: remoteSecretNames ?? [], toUpload: secretPlan.upload };

const live = remoteSecretNames ? blueVersion(parseJsonOutput(wrangler("deployments", "status", "--env", PRODUCTION.env, "--json").stdout), PRODUCTION.env) : { blue: null, problems: [] };
problems.push(...live.problems);
if (live.blue) notes.push(`blue (live) version is ${live.blue}`);
evidence.blue = live.blue;

// 6. Quality gates and Worker packaging.
step("lint", "npm", ["run", "lint"]);
step("typecheck", "npm", ["run", "typecheck"]);
step("tests (unit and PostgreSQL integration)", "npm", ["test"]);
step("dependency audit (runtime, high and critical)", "npm", ["audit", "--omit=dev", "--audit-level=high"]);
step("build", "npm", ["run", "build"]);
console.log("\nproduction gate: wrangler packaging dry run (no upload)");
const packaging = wrangler("deploy", "--env", PRODUCTION.env, "--dry-run", "--outdir", ".wrangler/dry-run-production");
process.stdout.write(packaging.stdout);
process.stderr.write(packaging.stderr);
evidence.checks["wrangler packaging dry run"] = packaging.status === 0 ? "pass" : `fail (exit ${packaging.status})`;
if (packaging.status !== 0) problems.push(`wrangler deploy --dry-run failed (exit ${packaging.status})`);
if (/REPLACE_WITH|local-only|staging/.test(packaging.stdout)) problems.push("the packaged production bindings contain placeholders or staging resources");
const expectedEntry = existsSync("apps/web/dist/index.html")
  ? /src="(\/assets\/index-[^"]+\.js)"/.exec(readFileSync("apps/web/dist/index.html", "utf8"))?.[1]
  : undefined;
if (!expectedEntry || !existsSync(join("apps/web/dist", expectedEntry))) problems.push("the built web shell or its entry bundle is missing");
evidence.assetsEntry = expectedEntry ?? null;

// 7. Decision.
if (problems.length) block();
for (const note of notes) console.log(`production gate: note: ${note}`);
if (dryRun) {
  evidence.outcome = "dry-run-pass";
  writeEvidence();
  console.log("production gate: PASS (dry run; nothing was created, uploaded, migrated, attached or deployed)");
  process.exit(0);
}

const release = createRelease({ env: PRODUCTION.env, worker: PRODUCTION.worker, origin });
async function smoke(get) {
  const [publicConfig, me, missing] = await Promise.all([get("/api/v1/public/config"), get("/api/v1/me"), get("/api/v1/production-gate-unknown")]);
  return checkSmokeResponses({ config: publicConfig, me, missing });
}

/** Runs `fn` with a private 0600 file holding only the secrets the Worker lacks; the file is always removed. */
function withSecretsFile(fn) {
  if (!secretPlan.upload.length) return fn(null);
  const uploadDir = mkdtempSync(join(tmpdir(), "medveris-production-secrets-"));
  const uploadFile = join(uploadDir, "secrets.json");
  try {
    writeFileSync(uploadFile, JSON.stringify(Object.fromEntries(secretPlan.upload.map((name) => [name, available.get(name)]))), { mode: 0o600 });
    return fn(uploadFile);
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

function finish(outcome, version, detail) {
  evidence.outcome = outcome;
  evidence.version = version;
  evidence.verification = detail;
  evidence.rollback = "npm run deploy:production:rollback (code only; migrations are not reversed)";
  writeEvidence();
}

// 8a. First deployment: there is no blue version.
if (remoteSecretNames === null) {
  const deploy = withSecretsFile((file) => spawnSync("npx", ["wrangler", "deploy", "--env", PRODUCTION.env, "--strict", ...(file ? ["--secrets-file", file] : [])], { stdio: "inherit" }));
  if (deploy.status !== 0) {
    finish("first-deploy-failed", null, `wrangler deploy exit ${deploy.status}`);
    process.exit(deploy.status ?? 1);
  }
  const status = blueVersion(parseJsonOutput(wrangler("deployments", "status", "--env", PRODUCTION.env, "--json").stdout), PRODUCTION.env);
  const check = status.blue ? await release.verifyVersion(status.blue, { override: false, expectedEntry, smoke }) : { ok: false, detail: "no live version" };
  finish(check.ok ? "first-deploy-verified" : "first-deploy-unverified", status.blue, check.detail);
  console.log(`production release: first deployment ${status.blue ?? "unknown"} ${check.ok ? "verified" : "FAILED VERIFICATION"} (${check.detail})`);
  if (!check.ok) console.error("production release: there is no earlier version; fix forward or remove traffic with `npx wrangler deployments list --env production`");
  process.exit(check.ok ? 0 : 1);
}

// 8b. Blue-green release. Blue keeps 100% of traffic until green passes every probe.
const blue = live.blue;
const subject = capture("git", ["log", "-1", "--format=%s"]).stdout.trim().slice(0, 100);
console.log(`\nproduction release: blue=${blue}; uploading green from ${commit.slice(0, 7)}`);
const upload = withSecretsFile((file) => capture("npx", [
  "wrangler", "versions", "upload", "--env", PRODUCTION.env, "--tag", commit.slice(0, 7), "--message", subject || "production release",
  ...(file ? ["--secrets-file", file] : []),
]));
process.stdout.write(upload.stdout);
process.stderr.write(upload.stderr);
const green = uploadedVersionId(upload.stdout);
if (upload.status !== 0 || !green) {
  finish("upload-failed", null, "green upload failed; blue still serves all traffic");
  process.exit(1);
}
if (!release.versionsDeploy([`${blue}@100%`, `${green}@0%`], `stage green ${green} at 0%`)) {
  finish("stage-failed", green, "could not stage green; blue still serves all traffic");
  process.exit(1);
}
const greenCheck = await release.verifyVersion(green, { override: true, expectedEntry, smoke });
if (!greenCheck.ok) {
  release.versionsDeploy([`${blue}@100%`], `discard green ${green}`);
  finish("green-rejected", green, greenCheck.detail);
  console.error(`production release: green failed verification (${greenCheck.detail}); blue still serves all traffic`);
  process.exit(1);
}
console.log(`production release: green verified through version override (${greenCheck.detail})`);
if (!release.versionsDeploy([`${green}@100%`], `promote green ${green} (${commit.slice(0, 7)})`)) {
  release.versionsDeploy([`${blue}@100%`], `restore blue ${blue}`);
  finish("promotion-failed", green, "promotion failed; blue restored");
  process.exit(1);
}
const triggers = spawnSync("npx", ["wrangler", "triggers", "deploy", "--env", PRODUCTION.env], { stdio: "inherit" });
if (triggers.status !== 0) console.error("production release: warning: triggers were not updated; run `npx wrangler triggers deploy --env production`");
const liveCheck = await release.verifyVersion(green, { override: false, expectedEntry, smoke });
if (!liveCheck.ok) {
  release.versionsDeploy([`${blue}@100%`], `automatic rollback to ${blue}`);
  finish("rolled-back", green, liveCheck.detail);
  console.error(`production release: green failed after promotion (${liveCheck.detail}); rolled back to blue ${blue}`);
  process.exit(1);
}
finish("promoted-and-verified", green, liveCheck.detail);
console.log(`production release: green ${green} serves 100% of traffic (${liveCheck.detail})`);
console.log(`production release: blue ${blue} remains available: npm run deploy:production:rollback`);
