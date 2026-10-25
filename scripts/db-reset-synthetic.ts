import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { databaseName, loadLocalEnv } from "./lib.js";

loadLocalEnv();

const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
if (appEnv === "production") throw new Error("Synthetic database reset is disabled in production");
const target = databaseName(migrationUrl);
if (!/^medveris_(dev|test)$/.test(target)) {
  throw new Error(`Refusing to reset ${target}: only medveris_dev and medveris_test are permitted`);
}
if (!process.argv.includes("--yes") && process.env.MEDVERIS_ALLOW_RESET !== "1") {
  throw new Error("Refusing to erase synthetic data without --yes (or MEDVERIS_ALLOW_RESET=1)");
}

console.warn(`Resetting synthetic database ${target}. Stop API and worker processes first.`);

const client = new Client({ connectionString: migrationUrl });
await client.connect();
try {
  await client.query("DROP SCHEMA IF EXISTS app CASCADE");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public AUTHORIZATION medveris_migrator");
  await client.query("GRANT USAGE ON SCHEMA public TO medveris_migrator, medveris_runtime, medveris_jobs, medveris_exchange");
  await client.query("GRANT CREATE ON SCHEMA public TO medveris_migrator");
} finally {
  await client.end();
}

for (const script of ["db:migrate", "db:seed"]) {
  const result = spawnSync("npm", ["run", script], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status}`);
}

console.log(`Synthetic database ${target} reset, migrated and seeded.`);
