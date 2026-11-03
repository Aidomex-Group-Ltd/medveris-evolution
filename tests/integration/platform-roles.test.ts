import { afterAll, describe, expect, it } from "vitest";
import { createSql, withContext, type Tx } from "@medveris/db";
import {
  approvePlatformRoleRequest,
  createPlatformRoleRequest,
  revokePlatformRoleGrant,
  activePlatformOperatorCount,
} from "../../apps/api/src/lib/platform-roles.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createHarness } from "./support.js";

/**
 * Regression tests for the four-eyes platform operator workflow and the identity-bound
 * app.is_platform_operator() helper (migration 045).
 *
 * The seeded Independent Reviewer is the only active operator; every test that needs to
 * create or remove a grant restores state in a finally block so the seeded database keeps
 * working for the other integration files.
 */

const url = process.env.DATABASE_URL;
const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!url || !migrationUrl) throw new Error("DATABASE_URL and MIGRATION_DATABASE_URL are required");

const sql = createSql(url, { max: 4 });
const bootstrapSql = createSql(migrationUrl, { max: 2 });
const config = loadConfig({ ...process.env, APP_ENV: "test" });

const OPERATOR = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CLINICIAN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLINICIAN_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ADMIN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REASON = "Synthetic regression test for the platform operator workflow";

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
  await bootstrapSql.end({ timeout: 5 });
});

/** Runs as the migration role with the CLI-only bootstrap flag, the same path the CLI uses. */
async function asBootstrap<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return bootstrapSql.begin(async (tx) => {
    await tx`select set_config('app.platform_roles_bootstrap', 'true', true)`;
    return fn(tx as unknown as Tx);
  }) as Promise<T>;
}

/** Actor context is required: the request table has no bootstrap policy, only operators may write it. */
async function cleanup(): Promise<void> {
  await asUser(OPERATOR, async (tx) => {
    await tx`delete from platform_role_requests where target_user_id in (${CLINICIAN}, ${CLINICIAN_B}, ${ADMIN_A}) and reason like 'Synthetic%'`;
    await tx`delete from platform_roles where user_id in (${CLINICIAN}, ${CLINICIAN_B}, ${ADMIN_A}) and role = 'platform_operator'`;
  }, "platform_operator");
}

function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>, platformRole?: string): Promise<T> {
  return withContext(sql, { userId, actorKind: "staff", platformRole: platformRole ?? null }, fn);
}

describe("app.is_platform_operator is bound to the current user", () => {
  it("is false with no user context even while an operator exists", async () => {
    const operators = await asBootstrap((tx) => activePlatformOperatorCount(tx));
    expect(operators).toBeGreaterThan(0);
    const rows = await sql`select app.is_platform_operator() as op`;
    expect(rows[0]?.op).toBe(false);
  });

  it("is false for a non-operator session while another user is an active operator", async () => {
    const rows = await asUser(CLINICIAN, (tx) => tx`select app.is_platform_operator() as op`);
    expect(rows[0]?.op).toBe(false);
  });

  it("is true for the active operator session", async () => {
    const rows = await asUser(OPERATOR, (tx) => tx`select app.is_platform_operator() as op`);
    expect(rows[0]?.op).toBe(true);
  });

  it("is false for revoked and expired grants", async () => {
    await cleanup();
    try {
      await asBootstrap(async (tx) => {
        await tx`
          insert into platform_roles (user_id, role, granted_at, expires_at, revoked_at, revoked_by, revoked_reason)
          values (${CLINICIAN}, 'platform_operator', now() - interval '3 hours', now() + interval '4 hours',
                  now() - interval '1 hour', ${OPERATOR}, 'synthetic-test')
        `;
        await tx`
          insert into platform_roles (user_id, role, granted_at, expires_at)
          values (${CLINICIAN_B}, 'platform_operator', now() - interval '5 hours', now() - interval '1 minute')
        `;
      });
      const revoked = await asUser(CLINICIAN, (tx) => tx`select app.is_platform_operator() as op`);
      const expired = await asUser(CLINICIAN_B, (tx) => tx`select app.is_platform_operator() as op`);
      expect(revoked[0]?.op).toBe(false);
      expect(expired[0]?.op).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("platform role tables are protected by RLS", () => {
  it("hides requests and blocks role writes for a non-operator", async () => {
    const requests = await asUser(CLINICIAN, (tx) => tx`select id from platform_role_requests`);
    expect(requests).toHaveLength(0);
    await expect(asUser(CLINICIAN, (tx) => tx`
      insert into platform_roles (user_id, role) values (${CLINICIAN}, 'platform_operator')
    `)).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("rejects a self-grant even for an operator", async () => {
    await expect(asUser(OPERATOR, (tx) => tx`
      insert into platform_roles (user_id, role) values (${OPERATOR}, 'platform_operator')
    `)).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("rejects malformed rows through CHECK constraints", async () => {
    await expect(asUser(OPERATOR, (tx) => tx`
      insert into platform_role_requests (id, role, target_user_id, requested_by, reason)
      values (gen_random_uuid(), 'platform_operator', ${CLINICIAN}, ${OPERATOR}, 'too short')
    `, "platform_operator")).rejects.toThrow(/check/i);

    await expect(asBootstrap((tx) => tx`
      insert into platform_roles (user_id, role, granted_by, approved_by, request_id, granted_at, expires_at)
      values (${CLINICIAN}, 'platform_operator', ${OPERATOR}, ${OPERATOR}, gen_random_uuid(), now(), now() + interval '1 hour')
    `)).rejects.toThrow(/check/i);

    await expect(asBootstrap((tx) => tx`
      insert into platform_roles (user_id, role, granted_at, revoked_at, revoked_reason)
      values (${CLINICIAN}, 'platform_operator', now() - interval '1 hour', now(), 'not-system-expiry')
    `)).rejects.toThrow(/check/i);
  });
});

describe("four-eyes approval rules", () => {
  it("cannot approve your own request", async () => {
    await cleanup();
    try {
      const created = await asUser(OPERATOR, (tx) => createPlatformRoleRequest(tx, config, {}, {
        userId: CLINICIAN, reason: REASON, durationHours: 2, actorUserId: OPERATOR,
      }), "platform_operator");
      await expect(asUser(OPERATOR, (tx) =>
        approvePlatformRoleRequest(tx, config, {}, created.requestId, OPERATOR, "self approval"),
      "platform_operator")).rejects.toThrow(/own request/i);
    } finally {
      await cleanup();
    }
  });

  it("cannot approve a request that nominates you", async () => {
    await cleanup();
    try {
      const created = await asUser(OPERATOR, (tx) => createPlatformRoleRequest(tx, config, {}, {
        userId: ADMIN_A, reason: REASON, durationHours: 2, actorUserId: OPERATOR,
      }), "platform_operator");
      // The operator context can see the request; the actor is the nominee, which the
      // service must reject before any grant is written.
      await expect(asUser(OPERATOR, (tx) =>
        approvePlatformRoleRequest(tx, config, {}, created.requestId, ADMIN_A, "nominee approval"),
      "platform_operator")).rejects.toThrow(/nominates you/i);
    } finally {
      await cleanup();
    }
  });

  it("cannot revoke the last active operator", async () => {
    await cleanup();
    const active = await asBootstrap((tx) => activePlatformOperatorCount(tx));
    expect(active).toBe(1);
    await expect(asUser(OPERATOR, (tx) =>
      revokePlatformRoleGrant(tx, config, {}, OPERATOR, CLINICIAN, REASON),
    "platform_operator")).rejects.toThrow(/without an active operator|without any active platform operator/i);
  });

  it("two simultaneous approvals produce exactly one grant", async () => {
    await cleanup();
    try {
      // A genuine second operator requests the grant; the seeded reviewer approves it.
      await asBootstrap((tx) => tx`
        insert into platform_roles (user_id, role, granted_at, expires_at)
        values (${ADMIN_A}, 'platform_operator', now(), now() + interval '1 hour')
      `);
      const created = await asUser(ADMIN_A, (tx) => createPlatformRoleRequest(tx, config, {}, {
        userId: CLINICIAN, reason: REASON, durationHours: 3, actorUserId: ADMIN_A,
      }), "platform_operator");

      const results = await Promise.allSettled([
        asUser(OPERATOR, (tx) => approvePlatformRoleRequest(tx, config, {}, created.requestId, OPERATOR, "first"), "platform_operator"),
        asUser(OPERATOR, (tx) => approvePlatformRoleRequest(tx, config, {}, created.requestId, OPERATOR, "second"), "platform_operator"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

      const grants = await asBootstrap((tx) => tx`
        select user_id from platform_roles
         where user_id = ${CLINICIAN} and role = 'platform_operator'
           and revoked_at is null and (expires_at is null or expires_at > now())
      `);
      expect(grants).toHaveLength(1);
      const decided = await asUser(OPERATOR, (tx) => tx`
        select status from platform_role_requests where id = ${created.requestId}
      `, "platform_operator");
      expect(decided[0]?.status).toBe("approved");
    } finally {
      await cleanup();
    }
  });
});

describe("HTTP guards", () => {
  const harness = createHarness("platform-roles");

  it("retires the legacy direct elevate endpoint outside synthetic environments", async () => {
    const session = await harness.login("reviewer@medveris.local");
    const response = await harness.call(session, "/api/v1/admin/platform-operator/elevate", {
      method: "POST",
      body: JSON.stringify({ userId: CLINICIAN }),
    });
    const body = await harness.json(response);
    expect(response.status).toBe(410);
    expect(body.error.code).toBe("legacy_elevate_disabled");
  });

  it("refuses the approval workflow to a non-operator", async () => {
    const session = await harness.login("clinician@medveris.local");
    const response = await harness.call(session, "/api/v1/admin/platform-operator/requests");
    expect(response.status).toBe(403);
  });

  it("rejects a privilege change without a recent step-up", async () => {
    const session = await harness.login("reviewer@medveris.local");
    await harness.sql`update sessions set mfa_verified_at = now() - interval '1 hour'
                        where user_id = ${OPERATOR} and revoked_at is null`;
    const response = await harness.call(session, "/api/v1/admin/platform-operator/requests", {
      method: "POST",
      body: JSON.stringify({ userId: CLINICIAN, reason: REASON }),
    });
    const body = await harness.json(response);
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("mfa_stale");
  });
});

describe("scheduled grant expiry sweep", () => {
  // The sweep is implemented in the jobs package so the worker's scheduled handler can run it
  // as the system actor. It mirrors apps/api/src/lib/platform-roles.ts::expireStaleGrants so the
  // jobs package stays dependency-light.
  const { maybeExpireStaleGrants } = require("../../apps/jobs/src/grants.js");

  it("soft-revokes expired grants and writes a system audit row", async () => {
    await cleanup();
    try {
      await asBootstrap(async (tx) => {
        await tx`
          insert into platform_roles (user_id, role, granted_at, expires_at)
          values (${CLINICIAN}, 'platform_operator', now() - interval '2 hours', now() - interval '1 minute')
        `;
      });
      const before = await asUser(CLINICIAN, (tx) => tx`select app.is_platform_operator() as op`);
      expect(before[0]?.op).toBe(true);

      const result = await maybeExpireStaleGrants(sql, config.auditSigningKey, config.auditSigningKeyId, Date.now());
      expect(result.revoked).toBe(1);
      expect(result.error).toBeNull();

      const after = await asUser(CLINICIAN, (tx) => tx`select app.is_platform_operator() as op`);
      expect(after[0]?.op).toBe(false);

      const rows = await asBootstrap((tx) => tx`
        select action, metadata from audit_events
         where action = 'platform_operator.expire' and metadata->>'revoked' = '1'
         order by occurred_at desc limit 1
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("platform_operator.expire");
      expect(Number(rows[0]?.metadata?.revoked ?? 0)).toBe(1);

      const grant = await asBootstrap((tx) => tx`
        select revoked_reason from platform_roles where user_id = ${CLINICIAN} and role = 'platform_operator'
      `);
      expect(grant[0]?.revokedReason).toBe("grant-expired");
    } finally {
      await cleanup();
    }
  });

  it("is a no-op when no grants have expired", async () => {
    await cleanup();
    try {
      const result = await maybeExpireStaleGrants(sql, config.auditSigningKey, config.auditSigningKeyId, Date.now());
      expect(result.revoked).toBe(0);
      expect(result.error).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
