import { Client } from "pg";
import { databaseName, loadLocalEnv, sqlLiteral } from "./lib.js";

loadLocalEnv();

const adminUrl = process.env.PGADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? "postgres://medveris_migrator:medveris_migrator_dev@localhost:5432/medveris_dev";
const targetDatabase = databaseName(migrationUrl);
const roleSpecs = [
  {
    name: "medveris_migrator",
    password: process.env.MIGRATOR_PASSWORD ?? "medveris_migrator_dev",
    options: "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
  },
  {
    name: "medveris_runtime",
    password: process.env.RUNTIME_PASSWORD ?? "medveris_runtime_dev",
    options: "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
  },
  {
    name: "medveris_jobs",
    password: process.env.JOBS_PASSWORD ?? "medveris_jobs_dev",
    options: "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
  },
  {
    name: "medveris_exchange",
    password: null,
    options: "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS",
  },
];

if (!/^[a-z][a-z0-9_]+$/.test(targetDatabase)) throw new Error("Unsafe database name");

const admin = new Client({ connectionString: adminUrl });
await admin.connect();

for (const role of roleSpecs) {
  const existing = await admin.query("select 1 from pg_roles where rolname = $1", [role.name]);
  if (existing.rowCount === 0) {
    const passwordClause = role.password ? ` PASSWORD ${sqlLiteral(role.password)}` : "";
    await admin.query(`CREATE ROLE ${role.name} ${role.options}${passwordClause}`);
    console.log(`created role ${role.name}`);
  } else {
    console.log(`role ${role.name} already exists (left unchanged)`);
  }
}

await admin.query("GRANT medveris_exchange TO medveris_migrator");
console.log("granted medveris_exchange to medveris_migrator for SECURITY DEFINER ownership");

const db = await admin.query("select 1 from pg_database where datname = $1", [targetDatabase]);
if (db.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${targetDatabase} OWNER medveris_migrator`);
  console.log(`created database ${targetDatabase}`);
} else {
  console.log(`database ${targetDatabase} already exists (not reset)`);
}

await admin.query(`GRANT CONNECT ON DATABASE ${targetDatabase} TO medveris_migrator, medveris_runtime, medveris_jobs`);
try {
  await admin.query(`ALTER DATABASE ${targetDatabase} OWNER TO medveris_migrator`);
} catch (error) {
  console.warn(`could not change database owner: ${(error as Error).message}`);
}
await admin.end();
console.log("database roles and database are ready");
