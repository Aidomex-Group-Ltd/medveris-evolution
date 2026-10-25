import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { loadLocalEnv } from "./lib.js";

loadLocalEnv();

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL is required");

const dir = resolve(process.cwd(), "packages/db/migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const client = new Client({ connectionString: url });
await client.connect();
await client.query(`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
for (const file of files) {
  const exists = await client.query("select 1 from schema_migrations where version = $1", [file]);
  if (exists.rowCount) {
    console.log(`skip ${file}`);
    continue;
  }
  const sql = await readFile(resolve(dir, file), "utf8");
  try {
    await client.query(sql);
    await client.query("insert into schema_migrations(version) values ($1) on conflict do nothing", [file]);
    console.log(`applied ${file}`);
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* transaction may already be closed */
    }
    console.error(`migration failed: ${file}`);
    throw error;
  }
}
await client.end();
console.log("migrations complete");
