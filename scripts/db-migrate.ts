import { Client } from "pg";
import { loadLocalEnv } from "./lib.js";
import { applyMigration, ensureMigrationTable, loadMigrations, schemaIntegrityProblems } from "./migrations.js";

loadLocalEnv();

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

const migrations = await loadMigrations();
const client = new Client({ connectionString: url });
await client.connect();
try {
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
