import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { parseEnvFile, parseJsonOutput } from "./staging-gate.mjs";
import { PRODUCTION } from "./production-gate.mjs";
import { provisionProductionSecrets } from "./production-secrets-lib.mjs";

/**
 * Production secrets, kept in ~/.config/medveris/production (0700; files 0600), never in the repository.
 *
 *   npm run secrets:production:check                       # read-only audit: names and statuses only
 *   npm run secrets:production                             # generate missing eligible secrets with OpenSSL and
 *                                                          # upload only names the existing Worker lacks
 *   npm run secrets:production -- --confirm-fresh-installation
 *       also allows AUDIT_SIGNING_KEY and MFA_ENCRYPTION_KEY when neither the production Worker nor a
 *       production database exists yet. With ~/.config/medveris/production/db.env present, the database is
 *       checked instead and the flag cannot override data that depends on existing keys.
 *
 * Existing local or remote values are never replaced; RESEND_API_KEY and database passwords are never generated.
 */

const args = process.argv.slice(2);
const apply = !args.includes("--check");
const confirmFresh = args.includes("--confirm-fresh-installation");
const dir = resolve(process.env.PRODUCTION_SECRETS_DIR || join(homedir(), ".config/medveris/production"));

function wrangler(...wranglerArgs) {
  const result = spawnSync("npx", ["wrangler", ...wranglerArgs], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "" };
}

function listRemoteSecrets() {
  const result = wrangler("secret", "list", "--env", PRODUCTION.env, "--format", "json");
  const parsed = parseJsonOutput(result.stdout);
  if (result.status === 0 && Array.isArray(parsed)) return { status: "ok", names: parsed.map((secret) => secret.name) };
  if (/does not exist|not found|\[code: 10007\]/i.test(result.output)) return { status: "absent" };
  const reason = /Authentication error|code: \d+/.exec(result.output)?.[0] ?? `exit ${result.status}`;
  return { status: "error", detail: reason };
}

async function checkDatabase() {
  const file = join(dir, "db.env");
  if (!existsSync(file)) return { status: "absent" };
  const url = parseEnvFile(readFileSync(file, "utf8")).get("MIGRATION_DATABASE_URL");
  if (!url) return { status: "unreachable" };
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("set default_transaction_read_only = on");
    const rows = await client.query(`
      select (select count(*) from users where totp_secret_enc is not null)::int as totp,
             (select count(*) from integrity_checkpoints)::int as checkpoints`);
    const dependents = [];
    if (rows.rows[0].totp > 0) dependents.push(`${rows.rows[0].totp} encrypted TOTP secrets (MFA_ENCRYPTION_KEY)`);
    if (rows.rows[0].checkpoints > 0) dependents.push(`${rows.rows[0].checkpoints} signed integrity checkpoints (AUDIT_SIGNING_KEY)`);
    return { status: "checked", dependents };
  } catch (error) {
    // 3D000: the database was never created; 42P01: it was never migrated. Neither can hold dependent data.
    if (["3D000", "42P01"].includes(/** @type {any} */ (error).code)) return { status: "checked", dependents: [] };
    return { status: "unreachable" };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function runOpenssl(opensslArgs) {
  const result = spawnSync("openssl", opensslArgs, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** Uploads through a 0600 file in a private temporary directory, removed afterwards; values never reach argv. */
function uploadSecrets(values) {
  const uploadDir = mkdtempSync(join(tmpdir(), "medveris-production-secrets-"));
  const file = join(uploadDir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    const result = wrangler("secret", "bulk", file, "--env", PRODUCTION.env);
    return result.status === 0 ? { ok: true } : { ok: false, detail: `exit ${result.status}` };
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }
}

function forbiddenValues() {
  const values = new Set();
  for (const file of [join(homedir(), ".config/medveris/staging/secrets.env"), join(homedir(), ".config/medveris/staging/resend.env"), resolve(".env")]) {
    if (!existsSync(file)) continue;
    for (const value of parseEnvFile(readFileSync(file, "utf8")).values()) if (value.length >= 16) values.add(value);
  }
  return values;
}

const report = await provisionProductionSecrets({
  dir,
  apply,
  confirmFresh,
  deps: { listRemoteSecrets, checkDatabase, runOpenssl, uploadSecrets, forbiddenValues: forbiddenValues() },
});

const label = `production secrets${apply ? "" : " (check)"}`;
const list = (names) => (names.length ? names.join(", ") : "none");
console.log(`${label}: directory ${dir}`);
if (report.freshInstallation) console.log(`${label}: fresh installation ${report.freshInstallation.established ? "established" : "not established"}: ${report.freshInstallation.reason}`);
console.log(`${label}: reused ${list(report.reused)}`);
if (apply) console.log(`${label}: generated ${list(report.generated)}`);
else console.log(`${label}: would generate ${list(report.wouldGenerate)}`);
console.log(`${label}: uploaded ${list(report.uploaded)}`);
if (report.deferred.length) console.log(`${label}: deferred to first deployment ${list(report.deferred)}`);
for (const note of report.notes) console.log(`${label}: note: ${note}`);
for (const entry of report.blocked) console.error(`${label}: BLOCKED: ${entry.reason}`);
for (const problem of report.problems) console.error(`${label}: PROBLEM: ${problem}`);
process.exit(report.blocked.length || report.problems.length ? 1 : 0);
