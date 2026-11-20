import { createSql } from "@medveris/db";
import { assertTestDatabase } from "./assert-test-database.js";

export const SYNTHETIC_OPERATOR_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const syntheticGrantHolders = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
];

function migrationSql() {
  assertTestDatabase("MIGRATION_DATABASE_URL");
  return createSql(process.env.MIGRATION_DATABASE_URL!, { max: 1 });
}

/**
 * Refuses to start tests when another **active** session on the test database indicates a runaway
 * worker (a crashed vitest/API process holding a transaction or running a query). Idle pool
 * connections from a previous worker that is shutting down, autovacuum and the test runner's own
 * warmup connections are harmless and self-resolving, so they are not treated as blockers.
 *
 * The guard looks only at sessions authenticated as the migration role used by tests, and only at
 * states that indicate real work or a stuck transaction. It retries once after a short pause so a
 * worker that is tearing down its pool does not falsely block the next run.
 */
export async function assertNoOtherTestSessions(): Promise<void> {
  /** @param {any} sql */
  function blockerQuery(sql: any) {
    return sql`
      select coalesce(usename, '?') as usename,
             count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and usename = current_user
        and state in ('active', 'idle in transaction', 'idle in transaction (aborted)')
      group by 1
      order by 1
    `;
  }
  const sql = migrationSql();
  try {
    const blockers = await blockerQuery(sql);
    const total = blockers.reduce((sum: any, row: any) => sum + Number(row.count), 0);
    if (total > 0) {
      const detail = blockers.map((row: any) => `${row.usename}=${row.count}`).join(", ");
      throw new Error(
        `Refusing to run tests: ${total} active test-role session(s) on the test database (${detail}); stop orphaned vitest/API workers or run node scripts/test-process-guard.mjs --check`,
      );
    }
    // Idle pool connections from a worker that is shutting down are harmless; give them a moment to
    // clear, then re-check once in case a worker was mid-teardown when we first looked.
    const idleRows = await sql`
      select coalesce(usename, '?') as usename,
             count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and usename = current_user
        and state = 'idle'
      group by 1
    `;
    const idleTotal = idleRows.reduce((sum: any, row: any) => sum + Number(row.count), 0);
    if (idleTotal > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const recheck = await blockerQuery(sql);
      const recheckTotal = recheck.reduce((sum: any, row: any) => sum + Number(row.count), 0);
      if (recheckTotal > 0) {
        const rdetail = recheck.map((row: any) => `${row.usename}=${row.count}`).join(", ");
        throw new Error(
          `Refusing to run tests: after a short pause, ${recheckTotal} active test-role session(s) still remain on the test database (${rdetail}); stop orphaned vitest/API workers or run node scripts/test-process-guard.mjs --check`,
        );
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function refreshSyntheticOperatorGrant(): Promise<void> {
  const sql = migrationSql();
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.platform_roles_bootstrap', 'true', true)`;
      await tx`delete from platform_roles where user_id = any(${syntheticGrantHolders}) and role = 'platform_operator'`;
      await tx`insert into platform_roles (user_id, role) values (${SYNTHETIC_OPERATOR_ID}, 'credential_reviewer') on conflict (user_id, role) do nothing`;
      await tx`
        insert into platform_roles (user_id, role, granted_by, approved_by, request_id, granted_at, expires_at)
        values (${SYNTHETIC_OPERATOR_ID}, 'platform_operator', null, null, null, now(), now() + interval '24 hours')
        on conflict (user_id, role) do update set
          granted_at = excluded.granted_at,
          expires_at = excluded.expires_at,
          revoked_at = null,
          revoked_by = null,
          revoked_reason = null
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
