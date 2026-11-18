import { afterAll, describe, expect, it } from "vitest";
import { createSql, withContext } from "@medveris/db";
import { activePlatformOperatorCount } from "../../apps/api/src/lib/platform-roles.js";
import { SYNTHETIC_OPERATOR_ID } from "../test-db.js";

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
if (!migrationUrl || !runtimeUrl) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL are required");

const migrationSql = createSql(migrationUrl, { max: 1 });
const runtimeSql = createSql(runtimeUrl, { max: 1 });

afterAll(async () => {
  await migrationSql.end({ timeout: 5 });
  await runtimeSql.end({ timeout: 5 });
});

describe("synthetic platform operator seed", () => {
  it("has an active, unexpired grant at test run time", async () => {
    await migrationSql.begin(async (tx) => {
      await tx`select set_config('app.platform_roles_bootstrap', 'true', true)`;
      expect(await activePlatformOperatorCount(tx)).toBeGreaterThan(0);
      const rows = await tx`
        select expires_at, revoked_at from platform_roles
        where user_id = ${SYNTHETIC_OPERATOR_ID} and role = 'platform_operator'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).toBeNull();
      expect(Date.parse(String(rows[0]?.expiresAt))).toBeGreaterThan(Date.now());
    });
  });

  it("is recognised by the identity-bound operator helper for a plain staff session", async () => {
    const rows = await withContext(runtimeSql, { userId: SYNTHETIC_OPERATOR_ID, actorKind: "staff" }, (tx) => tx`
      select app.is_platform_operator() as op
    `);
    expect(rows[0]?.op).toBe(true);
  });
});
