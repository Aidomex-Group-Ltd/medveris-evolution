import { afterAll, describe, expect, it } from "vitest";
import { createSql, withContext, type Tx } from "@medveris/db";

/**
 * Regression tests for migration 145: forgeable platform-role GUC gates are removed.
 *
 * Before migration 145, app.is_content_editor(), app.platform_roles_bootstrap(),
 * and app.legacy_elevate_available() read mutable GUCs directly, so any session able
 * to SET app.platform_role (or the bootstrap flags) could escalate privileges.
 * After migration 145, those gates are bound to DB-backed platform_roles state or a
 * migrator-only session guard.
 */

const url = process.env.DATABASE_URL;
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!url || !migrationUrl) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL are required");

const sql = createSql(url, { max: 2 });
const migrationSql = createSql(migrationUrl, { max: 2 });

const TEST_USER = "844f0ccb-7cb2-491e-875a-35b55b6820f5";
const OPERATOR_USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
  await migrationSql.end({ timeout: 5 });
});

async function cleanup(): Promise<void> {
  await asBootstrap(async (tx) => {
    await tx`
      delete from platform_roles where user_id in (${TEST_USER}, ${OPERATOR_USER}) and role = 'platform_operator'
    `;
    await tx`
      delete from platform_role_requests where target_user_id in (${TEST_USER}, ${OPERATOR_USER}) and reason like 'guc-hardening%'
    `;
  });
}

/** Bootstrap grant writes for the test operator via the migrator role. */
async function asBootstrap<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return migrationSql.begin(async (tx) => {
    await tx`select set_config('app.platform_roles_bootstrap', 'true', true)`;
    return fn(tx as unknown as Tx);
  }) as Promise<T>;
}

// ── Forgeability tests ─────────────────────────────────────────────────────

describe("migration 145 removes forgeable platform-role GUC gates", () => {
  it("denies app.is_content_editor for a runtime session that sets app.platform_role", async () => {
    // Ensure no platform_roles row exists for the test user.
    await cleanup();

    // A runtime session (medveris_runtime) must NOT be able to forge content-editorship
    // by setting app.platform_role. The 145 function checks platform_roles for the
    // 'platform_operator' role, and the migrator-only fallback only applies to
    // session_user = 'medveris_migrator'.
    const rows = await withContext(sql, {
      userId: TEST_USER,
      actorKind: "staff",
      platformRole: "content_editor",
    }, async (tx) => tx`select app.is_content_editor() as ok`);
    expect(rows[0]?.ok).toBe(false);
  });

  it("denies app.platform_roles_bootstrap for a runtime session", async () => {
    // After migration 145, platform_roles_bootstrap() requires session_user = 'medveris_migrator'.
    // A runtime session setting the GUC must still get false.
    const rows = await withContext(sql, {
      userId: TEST_USER,
      actorKind: "staff",
      platformRole: "platform_operator",
    }, async (tx) => {
      await tx`select set_config('app.platform_roles_bootstrap', 'true', true)`;
      return tx`select app.platform_roles_bootstrap() as ok`;
    });
    expect(rows[0]?.ok).toBe(false);
  });

  it("denies app.legacy_elevate_available for a runtime session", async () => {
    // After migration 145, legacy_elevate_available() requires session_user = 'medveris_migrator'.
    const rows = await withContext(sql, {
      userId: TEST_USER,
      actorKind: "staff",
    }, async (tx) => {
      await tx`select set_config('app.platform_roles_legacy_elevate', 'true', true)`;
      return tx`select app.legacy_elevate_available() as ok`;
    });
    expect(rows[0]?.ok).toBe(false);
  });

  it("allows the migrator role to bootstrap via the guarded flag", async () => {
    // The migrator-only guard should still work when the flag is set in a migrator session.
    const rows = await asBootstrap((tx) =>
      tx`
        select app.platform_roles_bootstrap() as ok
      `
    );
    expect(rows[0]?.ok).toBe(true);
  });

  it("reports zero active operators when no platform_roles rows exist", async () => {
    await cleanup();
    // Read the count from a normal runtime session (not the migrator/ bootstrap session),
    // because the bootstrap guard is migrator-only and the seeded operator may have been
    // restored by the seed script between test runs.
    const rows = await sql`
      select count(*)::int as cnt
      from platform_roles
      where role = 'platform_operator'
        and revoked_at is null
        and (expires_at is null or expires_at > now())
    `;
    expect(rows).toBeTruthy();
    expect(Object.keys(rows[0] ?? {})).toContain("cnt");
    expect(rows[0]?.cnt).toBe(0);
  });

  it("support_tickets policy uses DB-backed operator check, not a forgeable GUC", async () => {
    // Insert an operator grant so we can test the policy from a real operator session.
    await cleanup();
    await asBootstrap((tx) =>
      tx`
        insert into platform_roles (user_id, role, granted_at, expires_at)
        values (${OPERATOR_USER}, 'platform_operator', now(), now() + interval '1 hour')
      `
    );

    // A non-operator session must be denied by the policy even if app.platform_role is set
    // to 'platform_operator'. The policy calls app.is_platform_operator(), which reads
    // platform_roles, not the GUC.
    await expect(
      withContext(sql, {
        userId: TEST_USER,
        actorKind: "staff",
        platformRole: "platform_operator",
      }, async (tx) => tx`insert into support_tickets (id, title, status) values (gen_random_uuid(), 'guc test', 'open')`)
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});
