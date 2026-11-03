import { hmacHex, randomToken } from "@medveris/auth";
import { canonicalJson, sha256Hex } from "@medveris/domain";
import type { Sql, Tx } from "@medveris/db";
import { withContext } from "@medveris/db";
import { errorFields, logEvent, metric } from "@medveris/platform";

/**
 * Scheduled expiry sweep for platform operator grants.
 *
 * The service layer in apps/api/src/lib/platform-roles.ts implements `expireStaleGrants`, but
 * the sweep was never wired into the jobs runner, so expired grants stayed visible as active
 * until an operator revoked them by hand. This module runs the sweep as the `system` actor so
 * the FORCE RLS policy on platform_roles (migration 045) accepts the update, writes the
 * `platform_operator.expire` audit row with the same hash-chain semantics as every other audit
 * write, and reports the outcome through structured metrics.
 *
 * The sweep is idempotent: a grant that is already revoked is a no-op, and the audit row is
 * written once per cycle regardless of how many grants expired. It is intentionally
 * self-contained (it does not import from apps/api) so the jobs package stays dependency-light.
 */

export interface GrantExpiryResult {
  revoked: number;
  error: string | null;
}

/** A grant expires on a schedule measured in days, so running it every few minutes is enough. */
const GRANT_EXPIRY_INTERVAL_MS = 5 * 60_000;
let lastExpiryRun = 0;

async function writeSystemAudit(
  tx: Tx,
  signingKey: string,
  keyId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const id = crypto.randomUUID();
  const occurredAt = new Date();
  const nonce = randomToken(16);
  const previous = await tx`select event_hash from audit_events where tenant_id is null order by occurred_at desc, id desc limit 1`;
  const previousHash = (previous[0]?.eventHash as string | undefined) ?? null;
  const base = {
    id,
    tenantId: null,
    actorUserId: null,
    actorKind: "system",
    actorRoles: [] as string[],
    action: "platform_operator.expire",
    purpose: null,
    subjectPatientId: null,
    resourceType: "PlatformRole",
    resourceId: null,
    decision: "allow" as const,
    reasonCode: null,
    grantId: null,
    overrideId: null,
    correlationId: null,
    ipAddress: null,
    metadata,
    occurredAt: occurredAt.toISOString(),
    previousHash,
    nonce,
  };
  const eventHash = await sha256Hex(canonicalJson(base));
  const signature = await hmacHex(signingKey, canonicalJson({ ...base, eventHash }));
  await tx`
    insert into audit_events (
      id, tenant_id, actor_user_id, actor_kind, actor_roles, action, purpose, subject_patient_id,
      resource_type, resource_id, decision, reason_code, grant_id, override_id, correlation_id,
      ip_address, metadata, occurred_at, previous_hash, event_hash, nonce, signature_key_id, signature
    ) values (
      ${id}, null, null, ${"system"}, ${[]}, ${"platform_operator.expire"}, null, null,
      ${"PlatformRole"}, null, ${"allow"}, null, null, null, null,
      null, ${tx.json(metadata as never)}, ${occurredAt}, ${previousHash}, ${eventHash}, ${nonce}, ${keyId}, ${signature}
    )
  `;
}

async function expireStaleGrants(tx: Tx, signingKey: string, keyId: string): Promise<number> {
  const beforeRows = await tx`
    select count(*)::int as n from platform_roles
     where role = 'platform_operator' and revoked_at is null
       and (expires_at is null or expires_at > now())
  `;
  const before = Number(beforeRows[0]?.n ?? 0);
  const revoked = await tx`
    update platform_roles
       set revoked_at = now(), revoked_reason = 'grant-expired'
     where role = 'platform_operator'
       and revoked_at is null
       and expires_at is not null
       and expires_at <= now()
    returning user_id
  `;
  const afterRows = await tx`
    select count(*)::int as n from platform_roles
     where role = 'platform_operator' and revoked_at is null
       and (expires_at is null or expires_at > now())
  `;
  const after = Number(afterRows[0]?.n ?? 0);
  if (revoked.length) {
    await writeSystemAudit(tx, signingKey, keyId, {
      activeBefore: before,
      activeAfter: after,
      revoked: revoked.length,
    });
  }
  return revoked.length;
}

export async function maybeExpireStaleGrants(
  sql: Sql,
  signingKey: string,
  keyId: string,
  now = Date.now(),
): Promise<GrantExpiryResult> {
  if (now - lastExpiryRun < GRANT_EXPIRY_INTERVAL_MS) return { revoked: 0, error: null };
  lastExpiryRun = now;
  try {
    const revoked = await withContext(sql, { actorKind: "system" }, async (tx: Tx) =>
      expireStaleGrants(tx as unknown as Tx, signingKey, keyId),
    );
    if (revoked) metric("jobs.grant_expiry", revoked, {});
    return { revoked, error: null };
  } catch (error) {
    logEvent("error", "grant_expiry_failed", errorFields(error, false));
    return { revoked: 0, error: (error as Error).message };
  }
}