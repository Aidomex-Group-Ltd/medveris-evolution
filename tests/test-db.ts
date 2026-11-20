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

export async function assertNoOtherTestSessions(): Promise<void> {
  const sql = migrationSql();
  try {
    const sessions = await sql`
      select coalesce(usename, '?') as usename, count(*)::int as count
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
      group by 1 order by 1
    `;
    const total = sessions.reduce((sum, row) => sum + Number(row.count), 0);
    if (total > 0) {
      const detail = sessions.map((row) => `${row.usename}=${row.count}`).join(", ");
      throw new Error(
        `Refusing to run tests: ${total} other session(s) on the test database (${detail}); stop orphaned vitest/API workers or run node scripts/test-process-guard.mjs --check`,
      );
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
