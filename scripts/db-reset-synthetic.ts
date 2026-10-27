import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { databaseName, loadLocalEnv } from "./lib.js";
import { applyMigration, ensureMigrationTable, loadMigrations, schemaIntegrityProblems } from "./migrations.js";

loadLocalEnv();

const MIGRATION_ROLE = "medveris_migrator";
const SCHEMA_USAGE_ROLES = ["medveris_runtime", "medveris_jobs", "medveris_exchange"];
const checkOnly = process.argv.includes("--check");

const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
if (appEnv === "production") throw new Error("Synthetic database reset is disabled in production");
const target = databaseName(migrationUrl);
if (!/^medveris_(dev|test)$/.test(target)) {
  throw new Error(`Refusing to reset ${target}: only medveris_dev and medveris_test are permitted`);
}
if (!checkOnly && !process.argv.includes("--yes") && process.env.MEDVERIS_ALLOW_RESET !== "1") {
  throw new Error("Refusing to erase synthetic data without --yes (or MEDVERIS_ALLOW_RESET=1)");
}
const runtimeRoles = [process.env.DATABASE_URL, process.env.JOBS_DATABASE_URL]
  .filter((value): value is string => Boolean(value))
  .map((value) => {
    const parsed = new URL(value);
    if (databaseName(value) !== target) throw new Error(`Runtime URL targets ${databaseName(value)}, expected ${target}`);
    return decodeURIComponent(parsed.username);
  });

const migrations = await loadMigrations();

interface RoleRow { rolname: string; rolsuper: boolean; rolbypassrls: boolean }

class CheckOnly extends Error {}

async function preflight(client: Client): Promise<void> {
  const failures: string[] = [];
  const session = await client.query<{ db: string; usr: string; can_create: boolean }>(
    "select current_database() as db, current_user as usr, has_database_privilege(current_database(), 'CREATE') as can_create",
  );
  const { db, usr, can_create: canCreate } = session.rows[0]!;
  if (db !== target) failures.push(`connected to ${db}, expected ${target}`);
  if (usr !== MIGRATION_ROLE) failures.push(`connected as ${usr}, expected ${MIGRATION_ROLE}`);
  if (!canCreate) failures.push(`${usr} lacks CREATE on database ${db}`);

  const roles = await client.query<RoleRow>(
    "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = any($1::text[])",
    [[usr, ...runtimeRoles]],
  );
  for (const role of roles.rows) {
    if (role.rolsuper || role.rolbypassrls) failures.push(`role ${role.rolname} must not be SUPERUSER or BYPASSRLS`);
  }
  for (const name of runtimeRoles) {
    if (name === usr) failures.push(`runtime role ${name} must differ from the migration role`);
    if (!roles.rows.some((role) => role.rolname === name)) failures.push(`runtime role ${name} does not exist`);
  }
  const missingGrantees = await client.query<{ name: string }>(
    "select r as name from unnest($1::text[]) r where not exists (select 1 from pg_roles where rolname = r)",
    [SCHEMA_USAGE_ROLES],
  );
  for (const row of missingGrantees.rows) failures.push(`role ${row.name} does not exist; run npm run db:setup`);

  const schemas = await client.query<{ nspname: string; owner: string }>(
    "select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname in ('app','public')",
  );
  for (const schema of schemas.rows) {
    if (schema.owner !== usr) {
      failures.push(`schema ${schema.nspname} is owned by ${schema.owner}, not ${usr}; run npm run db:setup to transfer ownership`);
    }
  }

  const sessions = await client.query<{ usename: string; count: number }>(
    `select coalesce(usename, '?') as usename, count(*)::int as count from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() group by 1`,
  );
  for (const row of sessions.rows) {
    failures.push(`${row.count} other session(s) as ${row.usename} are connected; stop the API, worker, tests and psql first`);
  }

  console.log(`preflight: database=${db} migration_role=${usr} runtime_roles=${runtimeRoles.join(",") || "(none)"} migrations=${migrations.length}`);
  if (failures.length) {
    throw new Error(`Reset preflight failed; nothing was changed:\n  - ${failures.join("\n  - ")}`);
  }
  console.log("preflight: all safety checks passed");
}

const client = new Client({ connectionString: migrationUrl });
await client.connect();
try {
  await client.query("begin");
  try {
    await preflight(client);
    if (checkOnly) throw new CheckOnly();
    console.warn(`Resetting synthetic database ${target} in a single transaction.`);
    await client.query("set local lock_timeout = '5s'");
    await client.query("drop schema if exists app cascade");
    await client.query("drop schema if exists public cascade");
    await client.query(`create schema public authorization ${MIGRATION_ROLE}`);
    await client.query("revoke all on schema public from public");
    await client.query(`grant usage on schema public to ${SCHEMA_USAGE_ROLES.join(", ")}`);
    await ensureMigrationTable(client);
    for (const migration of migrations) {
      await applyMigration(client, migration);
      console.log(`applied ${migration.version}`);
    }
    const problems = await schemaIntegrityProblems(client);
    if (problems.length) throw new Error(`schema integrity check failed: ${problems.join("; ")}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (!(error instanceof CheckOnly)) {
      console.error("Reset rolled back; the database is unchanged.");
      throw error;
    }
  }
} finally {
  await client.end();
}
if (checkOnly) {
  console.log("--check: no changes made");
  process.exit(0);
}

console.log(`Synthetic database ${target} schema recreated and migrated. Seeding...`);
const seed = spawnSync("npm", ["run", "db:seed"], { stdio: "inherit", env: process.env });
if (seed.status !== 0) {
  throw new Error(`db:seed failed with exit code ${seed.status}; the schema is migrated and empty. Fix the cause and rerun npm run db:seed.`);
}
console.log(`Synthetic database ${target} reset, migrated and seeded.`);
