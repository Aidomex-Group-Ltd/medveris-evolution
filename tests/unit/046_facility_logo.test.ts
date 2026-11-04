import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { databaseName, loadLocalEnv } from "../../scripts/lib.js";
import { applyMigration, ensureMigrationTable, loadMigrations } from "../../scripts/migrations.js";

loadLocalEnv();

const APP_ENV = process.env.APP_ENV ?? "development";
const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL;
if (!MIGRATION_URL) throw new Error("MIGRATION_DATABASE_URL is required");
const target = databaseName(MIGRATION_URL);
if (target !== "medveris_dev" && target !== "medveris_test") {
  throw new Error(`Refusing to run facility-logo regression against ${target}; disposable dev/test database only`);
}
if (APP_ENV === "production") throw new Error("environment is production");

const migrations = await loadMigrations();
const migration = migrations.find((entry) => entry.version === "046_facility_logo.sql");
if (!migration) throw new Error("046_facility_logo.sql not found in loaded migrations");

const client = new Client({ connectionString: MIGRATION_URL });
await client.connect();
try {
  await ensureMigrationTable(client);

  await client.query("drop schema if exists app cascade");
  await client.query("create schema app");

  // Seed the tenant-role primitives migration 046 depends on.
  await client.query(`
    create table platform_roles (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id),
      role text not null,
      granted_at timestamptz not null default now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
    create table users (
      id uuid primary key default gen_random_uuid(),
      email text not null
    );
    insert into users (id, email) values
      ('8f2c4d3e-1a2b-4c3d-8e1f-2a3b4c5d6e7f', 'facility-user@example.com'),
      ('9f3d4e4f-2b3c-4d4e-9f2a-3b4c5d6e7f8f', 'platform-user@example.com');

    insert into platform_roles (user_id, role) values
      ('8f2c4d3e-1a2b-4c3d-8e1f-2a3b4c5d6e7f', 'platform_operator');
  `);

  // Run 046 alone in a disposable database; the campaign commits its own
  // transaction, so the runner is sufficient.
  await applyMigration(client, migration);

  const { rows } = await client.query(
    `select
       (select app.is_facility_admin()) as admin,
       (select app.is_platform_reviewer()) as reviewer`,
  );
  expect(rows[0]?.admin).toBe(true);
  expect(rows[0]?.reviewer).toBe(false);

  // A non-admin, non-operator facility user must not see another tenant's logo.
  await client.query(`
    insert into users (id, email) values ('aa000000-1111-4111-8111-111111111111', 'other-facility@example.com');
  `);
  const crossTenant = await client.query(
    `select app.is_facility_admin() as admin, app.is_platform_reviewer() as reviewer`,
  );
  expect(crossTenant.rows[0]?.admin).toBe(false);
  expect(crossTenant.rows[0]?.reviewer).toBe(false);
} finally {
  await client.end();
}
