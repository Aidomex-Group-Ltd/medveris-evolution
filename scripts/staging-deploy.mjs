import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  EXPECTED,
  REQUIRED_SECRETS,
  checkHyperdrivePair,
  checkHyperdriveRemote,
  checkSecretValues,
  checkStagingConfig,
  parseEnvFile,
  parseJsonOutput,
  parseWranglerConfig,
  planSecretUpload,
} from "./staging-gate.mjs";

/**
 * Staging deployment gate. Both modes fail closed (exit 1) when any prerequisite is unmet.
 *
 *   node scripts/staging-deploy.mjs --dry-run   # config + read-only remote checks + lint/typecheck/test/build
 *                                               # + wrangler packaging dry run; creates, uploads and migrates nothing
 *   node scripts/staging-deploy.mjs             # the same checks, then deploy and post-deploy health checks
 *
 * STAGING_SECRETS_FILE defaults to ~/.config/medveris/staging/secrets.env. It is uploaded only to fill
 * secrets the Worker lacks and never overwrites existing ones. This script never runs database migrations.
 */

const dryRun = process.argv.includes("--dry-run");
const ACCOUNT_ID = "6337ed24a5f8ff4ec3f74517a55a7e6b";
const DEFAULT_SECRETS_FILE = resolve(homedir(), ".config/medveris/staging/secrets.env");
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

const explicitFile = Boolean(process.env.STAGING_SECRETS_FILE);
const secretsFile = resolve(process.env.STAGING_SECRETS_FILE || DEFAULT_SECRETS_FILE);
let fileNames = null;
if (existsSync(secretsFile)) {
  const values = parseEnvFile(readFileSync(secretsFile, "utf8"));
  fileNames = [...values.keys()];
  const needed = remoteSecretNames === null || explicitFile || !REQUIRED_SECRETS.every((name) => remoteSecretNames?.includes(name));
  if (needed) {
    if (insideRepo(secretsFile)) problems.push("the staging secrets file must be stored outside the repository");
    if ((statSync(secretsFile).mode & 0o077) !== 0) problems.push("the staging secrets file must be mode 0600");
    const localValues = existsSync(".env") ? parseEnvFile(readFileSync(".env", "utf8")) : new Map();
    problems.push(...checkSecretValues(values, localValues));
  }
} else if (explicitFile) {
  problems.push("STAGING_SECRETS_FILE does not exist");
}
const secretPlan = remoteSecretNames === undefined
  ? { upload: false, problems: [], notes: [] }
  : planSecretUpload({ remoteNames: remoteSecretNames, fileNames, explicitFile });
problems.push(...secretPlan.problems);
notes.push(...secretPlan.notes);

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

const deployArgs = ["wrangler", "deploy", "--env", "staging", "--strict"];
if (secretPlan.upload) deployArgs.push("--secrets-file", secretsFile);
const deploy = spawnSync("npx", deployArgs, { stdio: "inherit" });
if (deploy.status !== 0) {
  console.error(`staging gate: wrangler deploy failed (exit ${deploy.status}); check \`npx wrangler deployments list --env staging\``);
  process.exit(deploy.status ?? 1);
}

async function probe(path) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${EXPECTED.origin}${path}`, { headers: { "cache-control": "no-cache" } });
      if (response.ok) return `${response.status}`;
      if (attempt === 6) return `HTTP ${response.status}`;
    } catch (error) {
      if (attempt === 6) return `unreachable (${error.cause?.code ?? error.name})`;
    }
    await new Promise((done) => setTimeout(done, 10_000));
  }
  return "unreachable";
}

const live = await probe("/api/v1/health/live");
const ready = await probe("/api/v1/health/ready");
console.log(`staging gate: deployed ${EXPECTED.worker}; live=${live} ready=${ready}`);
if (live !== "200" || ready !== "200") {
  console.error("staging gate: the deployment occurred but post-deploy health verification failed; inspect `npx wrangler tail --env staging`");
  process.exit(1);
}
