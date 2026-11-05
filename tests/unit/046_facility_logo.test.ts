import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseName, loadLocalEnv } from "../../scripts/lib.js";

loadLocalEnv();

const APP_ENV = process.env.APP_ENV ?? "development";
const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL;
if (!MIGRATION_URL) throw new Error("MIGRATION_DATABASE_URL is required");
const target = databaseName(MIGRATION_URL);
if (target !== "medveris_dev" && target !== "medveris_test") {
  throw new Error(`Refusing to run facility-logo regression against ${target}; disposable dev/test database only`);
}
if (APP_ENV === "production") throw new Error("environment is production");

/**
 * Migration 046 is applied by `db:migrate` before this suite runs, so the helpers and
 * policies under test are already on a migrated schema. Re-applying the migration here
 * would need the whole schema it depends on, and dropping the `app` schema would cascade
 * to every RLS policy in the database, so the regression checks the installed objects
 * and the identity rules they enforce instead.
 *
 * The two identities below are throwaway rows: one holds an active credential_reviewer
 * grant, the other holds none. Both are removed again afterwards.
 */
const REVIEWER = "8f2c4d3e-1a2b-4c3d-8e1f-2a3b4c5d6e7f";
const ORDINARY = "9f3d4e4f-2b3c-4d4e-9f2a-3b4c5d6e7f8f";

const client = new Client({ connectionString: MIGRATION_URL });

async function setIdentity(identity: { userId?: string; tenantId?: string }): Promise<void> {
  await client.query("select set_config('app.user_id', $1, false), set_config('app.tenant_id', $2, false)", [
    identity.userId ?? "",
    identity.tenantId ?? "",
  ]);
}

beforeAll(async () => {
  await client.connect();
  // `users` is not row-level secured, so the identities are seeded directly. `platform_roles`
  // is FORCE RLS, so the grant is written under the same break-glass variable that
  // scripts/platform-operator.ts uses for the first operator: no API route sets it.
  await client.query(
    `insert into users (id, email, password_hash, display_name, given_name, family_name)
     values ($1, 'facility-user@example.com', 'x', 'Facility User', 'Facility', 'User'),
            ($2, 'platform-user@example.com', 'x', 'Platform User', 'Platform', 'User')
     on conflict (id) do nothing`,
    [REVIEWER, ORDINARY],
  );
  await client.query("select set_config('app.platform_roles_bootstrap', 'true', false)");
  try {
    await client.query("insert into platform_roles (user_id, role) values ($1, 'credential_reviewer') on conflict do nothing", [REVIEWER]);
  } finally {
    await client.query("select set_config('app.platform_roles_bootstrap', 'false', false)");
  }
});

afterAll(async () => {
  await client.query("select set_config('app.platform_roles_bootstrap', 'true', false)").catch(() => undefined);
  await client.query("delete from platform_roles where user_id = any($1::uuid[])", [[REVIEWER, ORDINARY]]).catch(() => undefined);
  await client.query("delete from users where id = any($1::uuid[])", [[REVIEWER, ORDINARY]]).catch(() => undefined);
  await client.query("select set_config('app.platform_roles_bootstrap', 'false', false)").catch(() => undefined);
  await client.end();
});

describe("facility logo (migration 046)", () => {
  it("adds a nullable uploads reference on tenants and never replaces the global asset", async () => {
    const { rows } = await client.query<{ is_nullable: string; data_type: string; delete_rule: string }>(
      `select c.is_nullable, c.data_type, rc.delete_rule
         from information_schema.columns c
         join pg_constraint k on k.conrelid = 'public.tenants'::regclass and k.contype = 'f'
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
         join pg_class rt on rt.oid = k.confrelid
         join information_schema.referential_constraints rc on rc.constraint_name = k.conname
        where c.table_schema = 'public' and c.table_name = 'tenants' and c.column_name = 'logo_upload_id'
          and rt.relname = 'uploads' and a.attname = 'logo_upload_id'`,
    );
    expect(rows[0]).toMatchObject({ is_nullable: "YES", data_type: "uuid", delete_rule: "SET NULL" });
  });

  it("installs the facility-logo read and update policies on tenants", async () => {
    const { rows } = await client.query<{ policyname: string; cmd: string }>(
      "select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'tenants' and policyname like 'tenants_logo_%' order by policyname",
    );
    expect(rows).toEqual([
      { policyname: "tenants_logo_read", cmd: "SELECT" },
      { policyname: "tenants_logo_update", cmd: "UPDATE" },
    ]);
  });

  it("keeps both identity helpers SECURITY DEFINER with a fixed search path", async () => {
    const { rows } = await client.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select proname, prosecdef, proconfig from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app' and proname in ('is_facility_admin', 'is_platform_reviewer')
        order by proname`,
    );
    expect(rows.map((row) => row.proname)).toEqual(["is_facility_admin", "is_platform_reviewer"]);
    for (const row of rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig ?? []).toContain("search_path=public, pg_temp");
    }
  });

  it("reports a platform reviewer only for the caller's own active grant", async () => {
    const reviewer = async (userId: string) => {
      await setIdentity({ userId });
      const { rows } = await client.query<{ reviewer: boolean }>("select app.is_platform_reviewer() as reviewer");
      return rows[0]!.reviewer;
    };
    expect(await reviewer(REVIEWER)).toBe(true);
    expect(await reviewer(ORDINARY)).toBe(false);

    await setIdentity({});
    const anonymous = await client.query<{ reviewer: boolean }>("select app.is_platform_reviewer() as reviewer");
    expect(anonymous.rows[0]!.reviewer).toBe(false);
  });

  it("refuses facility admin without an active tenant claim and a caller identity", async () => {
    await setIdentity({ userId: ORDINARY });
    const withoutTenant = await client.query<{ admin: boolean }>("select app.is_facility_admin() as admin");
    expect(withoutTenant.rows[0]!.admin).toBe(false);

    await setIdentity({ tenantId: "11111111-1111-4111-8111-111111111111" });
    const withoutUser = await client.query<{ admin: boolean }>("select app.is_facility_admin() as admin");
    expect(withoutUser.rows[0]!.admin).toBe(false);

    await setIdentity({});
    const anonymous = await client.query<{ admin: boolean }>("select app.is_facility_admin() as admin");
    expect(anonymous.rows[0]!.admin).toBe(false);
  });
});
