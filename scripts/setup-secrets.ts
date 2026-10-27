import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Client } from "pg";

/**
 * Generates missing local or staging secrets with OpenSSL without printing their values.
 *
 *   npm run secrets:local                       # fills gaps in .env (0600)
 *   npm run secrets:staging -- --file <path>    # staging-only keys outside the repository (0600)
 */

const SECRET_NAMES = ["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"] as const;
type SecretName = (typeof SECRET_NAMES)[number];
const DATA_BOUND: ReadonlySet<SecretName> = new Set(["AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);

const repoRoot = process.cwd();
const args = process.argv.slice(2);
const mode = args[0];
const fileFlag = args.indexOf("--file");
const assumeNewDatabase = args.includes("--new-database");

function fail(message: string): never {
  console.error(`secrets: ${message}`);
  process.exit(1);
}

function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.replace(/^["']|["']$/g, ""));
  }
  return values;
}

function isUsable(value: string | undefined): boolean {
  return Boolean(value) && value!.length >= 24 && !/replace-with|changeme|placeholder/i.test(value!) && !value!.startsWith("test-");
}

function generate(): string {
  const value = execFileSync("openssl", ["rand", "-base64", "32"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (value.length < 40) fail("openssl returned an unexpectedly short value");
  return value;
}

function upsert(text: string, name: string, value: string): string {
  const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, () => `${name}=${value}`);
  return `${text.replace(/\n?$/, "\n")}${name}=${value}\n`;
}

function insideRepo(path: string): boolean {
  const rel = relative(repoRoot, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function assertNotTracked(path: string): void {
  const rel = relative(repoRoot, path);
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", rel], { stdio: "ignore" });
    fail(`${rel} is tracked by Git; remove it from the index before storing secrets in it`);
  } catch {
    /* not tracked */
  }
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { stdio: "ignore" });
  } catch {
    fail(`${rel} is not ignored by .gitignore`);
  }
}

async function persistedDependencies(databaseUrl: string | undefined): Promise<string[] | null> {
  if (!databaseUrl) return null;
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("set default_transaction_read_only = on");
    const rows = await client.query<{ totp: number; checkpoints: number }>(`
      select (select count(*) from users where totp_secret_enc is not null)::int as totp,
             (select count(*) from integrity_checkpoints)::int as checkpoints`);
    const found: string[] = [];
    if (rows.rows[0]!.totp > 0) found.push(`${rows.rows[0]!.totp} encrypted TOTP secrets (MFA_ENCRYPTION_KEY)`);
    if (rows.rows[0]!.checkpoints > 0) found.push(`${rows.rows[0]!.checkpoints} signed integrity checkpoints (AUDIT_SIGNING_KEY)`);
    return found;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function local(): Promise<void> {
  const target = resolve(repoRoot, ".env");
  if (!existsSync(target)) {
    copyFileSync(resolve(repoRoot, ".env.example"), target);
    console.log("secrets: created .env from .env.example");
  }
  chmodSync(target, 0o600);
  assertNotTracked(target);
  let text = readFileSync(target, "utf8");
  const current = parseEnv(text);
  const missing = SECRET_NAMES.filter((name) => !isUsable(current.get(name)));
  const dataBoundMissing = missing.filter((name) => DATA_BOUND.has(name));
  if (dataBoundMissing.length && !assumeNewDatabase) {
    const dependencies = await persistedDependencies(current.get("MIGRATION_DATABASE_URL"));
    if (dependencies === null) {
      fail(`${dataBoundMissing.join(", ")} missing and the database could not be checked for data that depends on them. `
        + "Restore the original keys, or rerun with --new-database only if the database is empty or will be reset.");
    }
    if (dependencies.length) {
      fail(`${dataBoundMissing.join(", ")} missing but stored data depends on them: ${dependencies.join("; ")}. `
        + "Restore the original keys from backup; generating replacements would break MFA decryption or signature verification.");
    }
  }
  for (const name of missing) text = upsert(text, name, generate());
  const updated = parseEnv(text);
  if (new Set(SECRET_NAMES.map((name) => updated.get(name))).size !== SECRET_NAMES.length) fail("generated secrets are not distinct");
  if (missing.length) writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
  for (const name of SECRET_NAMES) console.log(`secrets: ${name} ${missing.includes(name) ? "generated" : "present (kept)"}`);
  console.log(`secrets: .env mode ${(statSync(target).mode & 0o777).toString(8)}, ignored by Git, not tracked`);
  console.log("secrets: Cloudflare secrets are separate; use npm run secrets:staging and wrangler deploy --secrets-file.");
}

function staging(): void {
  if (fileFlag < 0 || !args[fileFlag + 1]) fail("pass --file <path outside the repository>");
  const target = resolve(args[fileFlag + 1]!);
  if (insideRepo(target)) fail("staging secrets must be stored outside the repository");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let text = existsSync(target) ? readFileSync(target, "utf8") : "";
  const current = parseEnv(text);
  const localValues = existsSync(resolve(repoRoot, ".env")) ? parseEnv(readFileSync(resolve(repoRoot, ".env"), "utf8")) : new Map();
  const reused = SECRET_NAMES.filter((name) => current.get(name) && [...localValues.values()].includes(current.get(name)));
  if (reused.length) fail(`${reused.join(", ")} in the staging file match local values; staging keys must be unique`);
  const missing = SECRET_NAMES.filter((name) => !isUsable(current.get(name)));
  for (const name of missing) text = upsert(text, name, generate());
  writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
  for (const name of SECRET_NAMES) console.log(`secrets: ${name} ${missing.includes(name) ? "generated" : "present (kept)"}`);
  console.log(`secrets: staging file mode ${(statSync(target).mode & 0o777).toString(8)}`);
  console.log("secrets: upload only to a new staging Worker or one that holds no data under other keys:");
  console.log(`secrets:   npx wrangler deploy --env staging --secrets-file ${target}`);
}

if (mode === "local") await local();
else if (mode === "staging") staging();
else fail("usage: setup-secrets.ts local [--new-database] | staging --file <path>");
