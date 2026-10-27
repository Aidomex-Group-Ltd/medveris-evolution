import { Client } from "pg";
import { databaseName, loadLocalEnv } from "./lib.js";
import { applyMigration, ensureMigrationTable, loadMigrations, schemaIntegrityProblems } from "./migrations.js";

loadLocalEnv();

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
const target = databaseName(url);
const host = new URL(url).hostname;
const hostClass = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) ? "local" : "hosted";
const confirmed = process.argv.find((arg) => arg.startsWith("--confirm-database="))?.split("=")[1];
const routine = (/^medveris_(dev|test)$/.test(target) && appEnv !== "production")
  || (target === "medveris_staging" && appEnv === "staging");
if (!routine && confirmed !== target) {
  throw new Error(`Refusing to migrate ${target} (APP_ENV=${appEnv}, ${hostClass} host) without --confirm-database=${target}`);
}
console.log(`migration target: database=${target} host=${hostClass} app_env=${appEnv}`);

const migrations = await loadMigrations();
const client = new Client({ connectionString: url });
await client.connect();
try {
  const [session] = (await client.query<{ db: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "select current_database() as db, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user",
  )).rows;
  if (session?.db !== target) throw new Error(`Connected to ${session?.db}, expected ${target}`);
  if (session.rolsuper || session.rolbypassrls) throw new Error("The migration role must not be SUPERUSER or BYPASSRLS");
  await ensureMigrationTable(client);
  for (const migration of migrations) {
    const exists = await client.query("select 1 from schema_migrations where version = $1", [migration.version]);
    if (exists.rowCount) {
      console.log(`skip ${migration.version}`);
      continue;
    }
    await client.query("begin");
    try {
      await applyMigration(client, migration);
      await client.query("commit");
      console.log(`applied ${migration.version}`);
    } catch (error) {
      await client.query("rollback");
      console.error(`migration failed (rolled back): ${migration.version}`);
      throw error;
    }
  }
  const problems = await schemaIntegrityProblems(client);
  if (problems.length) {
    throw new Error(
      `schema_migrations is up to date but the schema is damaged: ${problems.join("; ")}. `
      + "Recreate the synthetic schema; see docs/LOCAL_DEVELOPMENT.md (Database reset).",
    );
  }
} finally {
  await client.end();
}
console.log("migrations complete");
