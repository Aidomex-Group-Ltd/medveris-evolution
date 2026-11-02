import type { Tx } from "@medveris/db";
import { writeAudit } from "./audit.js";
import { auditMeta } from "./http.js";
import type { AppEnv } from "../types.js";
import type { AppConfig } from "../config.js";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError, DependencyError, MfaStepUpRequiredError, StaleMfaError, PlatformOperatorUnderstaffedError, DuplicateRequestError, RequestAlreadyDecidedError, LastOperatorRevocationForbiddenError, MfaVerificationExpiredError, SyntheticTargetInProductionError } from "./errors.js";

export const MAX_REQUEST_REASON_LENGTH = 500;
export const MIN_REQUEST_REASON_LENGTH = 10;

export const LEGACY_ELEVATE_ACTION = "platform_operator.legacy_elevate";
export const LEGACY_REVOKE_ACTION = "platform_operator.legacy_revoke";

export const REQUEST_ACTION = "platform_operator.request";
export const APPROVE_ACTION = "platform_operator.approve";
export const DENY_ACTION = "platform_operator.deny";
export const CANCEL_ACTION = "platform_operator.cancel";
export const GRANT_ACTION = "platform_operator.grant";
export const REVOKE_ACTION = "platform_operator.revoke";
export const EXPIRE_ACTION = "platform_operator.expire";
export const BREAK_GLASS_GRANT_ACTION = "platform_operator.break_glass_grant";

export const BREAK_GLASS_SOURCE = "cli";
export const BREAK_GLASS_DURATION_HOURS = 7 * 24; // default break-glass grant window

export async function resolveUserForResource(
  tx: Tx,
  email: string | null,
  userId: string | null,
): Promise<{
  id: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  totpEnrolled: boolean;
  status: string;
  isSynthetic: boolean;
}> {
  const lower = (email ?? "").trim().toLowerCase();
  if (!lower && !userId) {
    throw new ValidationError("Email or user id is required");
  }

  let rows: Array<{
    id: string;
    display_name: string;
    email_verified_at: Date | null;
    mfa_enrolled_at: Date | null;
    totp_secret_enc: string | null;
    status: string;
    created_at: Date;
  }>;

  if (userId) {
    rows = await tx`
      select id, display_name, email_verified_at, mfa_enrolled_at, totp_secret_enc, status, created_at
        from users
       where id = ${userId}
       limit 1
    `;
  } else {
    rows = await tx`
      select id, display_name, email_verified_at, mfa_enrolled_at, totp_secret_enc, status, created_at
        from users
       where lower(email) = ${lower}
       limit 1
    `;
  }

  if (!rows.length) {
    throw new NotFoundError("No eligible account matches that email or user id");
  }

  const row = rows[0];
  return {
    id: row.id,
    displayName: row.display_name,
    emailVerified: Boolean(row.email_verified_at),
    mfaEnrolled: Boolean(row.mfa_enrolled_at),
    totpEnrolled: Boolean(row.totp_secret_enc),
    status: row.status,
    isSynthetic: row.created_at instanceof Date &&
      row.created_at.toISOString().includes("1970") ? true : false, // placeholder; real synthetic detection uses seeded markers
  };
}

export interface EligibleUser {
  id: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  totpEnrolled: boolean;
  status: string;
}

export async function checkEligibility(tx: Tx, userId: string, appEnv: string, callerIsSynthetic: boolean): Promise<EligibleUser> {
  const [row] = await tx`
    select id, display_name, email_verified_at, mfa_enrolled_at, totp_secret_enc, status, created_at
      from users
     where id = ${userId}
     limit 1
  `;
  if (!row) throw new NotFoundError("User not found");
  if (row.status !== "active") throw new ForbiddenError("The account is not active or is disabled");
  if (!row.email_verified_at) throw new ForbiddenError("The account email has not been verified");
  if (!row.mfa_enrolled_at) throw new ForbiddenError("MFA must be enrolled before the account can be granted platform access");
  if (!row.totp_secret_enc) throw new ForbiddenError("Platform access requires a stronger MFA method than email codes");
  if (!callerIsSynthetic && appEnv === "production") {
    // Synthetic-seeded accounts are identified by the migration/seeding markers, not by guessing.
    const synthetic = await tx`
      select 1 from patient_accounts where user_id = ${userId} limit 1
    `;
    if (synthetic.length) throw new ForbiddenError("Platform access cannot be granted to a synthetic or demonstration account in production");
  }
  return {
    id: row.id,
    displayName: row.display_name,
    emailVerified: true,
    mfaEnrolled: true,
    totpEnrolled: Boolean(row.totp_secret_enc),
    status: row.status,
  };
}

export async function activePlatformOperatorCount(tx: Tx): Promise<number> {
  const [row] = await tx`
    select count(*)::int as n
      from platform_roles
     where role = 'platform_operator'
       and revoked_at is null
       and (expires_at is null or expires_at > now())
  `;
  return Number(row?.n ?? 0);
}

export async function revokeSessionsForUser(tx: Tx, sql: Parameters<Tx>[0] extends infer T ? T : never, userId: string, reason: string): Promise<void> {
  // Revoke active sessions for the target user so privilege changes take effect immediately.
  await tx`
    update sessions set revoked_at = now(), revoked_reason = ${reason}
      where user_id = ${userId} and revoked_at is null
  `;
}

export async function createPlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  c: Parameters<(api: any) => any>[0], // placeholder; real signature passes context
  email: string,
  reason: string,
  durationHours: number | null,
  actorUserId: string,
): Promise<{ requestId: string; targetUserId: string }> {
  const meta = auditMeta(c);
  const ctx = c.get("auth")!;
  const target = await resolveUserForResource(tx, email, null);
  if (target.status !== "active") throw new ForbiddenError("The nominated account is not eligible");
  if (!target.emailVerified) throw new ForbiddenError("The nominated account email must be verified");
  if (!target.totpEnrolled) throw new ForbiddenError("The nominated account must have a strong MFA method enrolled");

  if (reason.length < MIN_REQUEST_REASON_LENGTH || reason.length > MAX_REQUEST_REASON_LENGTH) {
    throw new ValidationError(`Reason must be between ${MIN_REQUEST_REASON_LENGTH} and ${MAX_REQUEST_REASON_LENGTH} characters`);
  }

  const expiresAt = durationHours
    ? new Date(Date.now() + Math.min(Math.max(durationHours, 1), config.platformRoles.maxGrantHours) * 3600_000)
    : new Date(Date.now() + config.platformRoles.defaultGrantHours * 3600_000);

  const requestId = crypto.randomUUID();
  await tx`
    insert into platform_role_requests (id, role, target_user_id, requested_by, reason, status, expires_at, created_at)
    values (${requestId}, 'platform_operator', ${target.id}, ${actorUserId}, ${reason}, 'pending', ${expiresAt}, now())
    on conflict on constraint platform_role_requests_target_pending do nothing
  `;
  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: REQUEST_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    ...meta,
    metadata: { targetUserId: target.id, reasonLength: reason.length, requestedDurationHours: durationHours },
  });

  return { requestId, targetUserId: target.id };
}

export async function approvePlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  c: Parameters<(api: any) => any>[0],
  requestId: string,
  actorUserId: string,
  decisionNote: string,
): Promise<{ targetUserId: string; grantedBy: string; expiresAt: Date }> {
  const meta = auditMeta(c);
  const ctx = c.get("auth")!;

  const [request] = await tx`
    select id, target_user_id, requested_by, reason, status, expires_at, decided_by, decided_at
      from platform_role_requests
     where id = ${requestId}
       and status = 'pending'
     for update
  `;
  if (!request) throw new NotFoundError("Request not found, already decided, or expired");

  if (request.decided_by) throw new ConflictError("Request already has a decision");
  if (request.requested_by === actorUserId) throw new ForbiddenError("You cannot approve your own request");
  if (request.target_user_id === actorUserId) throw new ForbiddenError("You cannot approve a request that nominates you");

  const eligibility = await checkEligibility(tx, request.target_user_id, ctx.activeTenant?.id ?? "", false);
  if (!eligibility.emailVerified) throw new ForbiddenError("The nominated account email must be verified before approval");
  if (!eligibility.totpEnrolled) throw new ForbiddenError("The nominated account must have a strong MFA method enrolled");

  const count = await activePlatformOperatorCount(tx);
  if (count < (config.platformRoles.minActiveOperators ?? 2)) {
    throw new DependencyError("There are too few active platform operators to approve this request safely");
  }

  const expiresAt = new Date(request.expires_at);
  const grantedBy = actorUserId;
  await tx`
    insert into platform_roles (user_id, role, granted_by, approved_by, request_id, granted_at, expires_at)
    values (${eligibility.id}, 'platform_operator', ${request.requested_by}, ${actorUserId}, ${request.id}, now(), ${expiresAt})
    on conflict (user_id, role) where role = 'platform_operator' do nothing
  `;

  await tx`
    update platform_role_requests
       set status = 'approved', decided_by = ${actorUserId}, decided_at = now(), decision_note = ${decisionNote}
     where id = ${requestId}
  `;

  await revokeSessionsForUser(tx, tx, eligibility.id, "platform-operator-granted");

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: APPROVE_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    ...meta,
    metadata: { targetUserId: eligibility.id, decisionNote, expiresAt: expiresAt.toISOString() },
  });

  return { targetUserId: eligibility.id, grantedBy, expiresAt };
}

export async function denyPlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  c: Parameters<(api: any) => any>[0],
  requestId: string,
  actorUserId: string,
  decisionNote: string,
): Promise<void> {
  const meta = auditMeta(c);
  const ctx = c.get("auth")!;

  const [request] = await tx`
    select id, target_user_id, requested_by, status, decided_by
      from platform_role_requests
     where id = ${requestId}
       and status = 'pending'
     for update
  `;
  if (!request) throw new NotFoundError("Request not found, already decided, or expired");

  if (request.decided_by === actorUserId) throw new ForbiddenError("You cannot deny a request you created");
  if (request.requested_by === actorUserId) throw new ForbiddenError("You cannot deny your own request");
  if (request.target_user_id === actorUserId) throw new ForbiddenError("You cannot deny a request that nominates you");

  await tx`
    update platform_role_requests
       set status = 'denied', decided_by = ${actorUserId}, decided_at = now(), decision_note = ${decisionNote}
     where id = ${requestId}
  `;

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: DENY_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    ...meta,
    metadata: { targetUserId: request.target_user_id, decisionNote },
  });
}

export async function cancelPlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  c: Parameters<(api: any) => any>[0],
  requestId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const meta = auditMeta(c);
  const ctx = c.get("auth")!;

  const [request] = await tx`
    select id, target_user_id, requested_by, status
      from platform_role_requests
     where id = ${requestId}
       and status = 'pending'
  `;
  if (!request) throw new NotFoundError("Request not found, already decided, or expired");

  if (request.requested_by !== actorUserId) throw new ForbiddenError("Only the requester can cancel this request");

  await tx`
    update platform_role_requests
       set status = 'cancelled', decided_by = ${actorUserId}, decided_at = now(), decision_note = ${reason}
     where id = ${requestId}
  `;

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: CANCEL_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    ...meta,
    metadata: { targetUserId: request.target_user_id, reason },
  });
}

export async function revokePlatformRoleGrant(
  tx: Tx,
  config: AppConfig,
  c: Parameters<(api: any) => any>[0],
  targetUserId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const meta = auditMeta(c);
  const ctx = c.get("auth")!;

  if (ctx.user.id === targetUserId) throw new ForbiddenError("You cannot revoke your own platform access");

  const [row] = await tx`
    select user_id, role, granted_by, approved_by, request_id, granted_at, expires_at, revoked_at
      from platform_roles
     where user_id = ${targetUserId}
       and role = 'platform_operator'
  `;
  if (!row) throw new NotFoundError("The nominated account does not hold a platform operator grant");

  const activeCount = await activePlatformOperatorCount(tx);
  if (activeCount <= 1 && row.revoked_at === null) {
    throw new ConflictError("Revoking this grant would leave the platform with no active operator");
  }

  await tx`
    update platform_roles
       set revoked_at = now(), revoked_by = ${actorUserId}, revoked_reason = ${reason}
     where user_id = ${targetUserId}
       and role = 'platform_operator'
       and revoked_at is null
  `;

  await revokeSessionsForUser(tx, tx, targetUserId, "platform-operator-revoked");

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: REVOKE_ACTION,
    resourceType: "PlatformRole",
    resourceId: targetUserId,
    ...meta,
    metadata: { targetUserId, reason },
  });
}

export async function expireStaleGrants(tx: Tx, config: AppConfig): Promise<number> {
  const before = await activePlatformOperatorCount(tx);
  await tx`
    update platform_roles
       set revoked_at = now(), revoked_reason = 'grant-expired'
     where role = 'platform_operator'
       and revoked_at is null
       and expires_at is not null
       and expires_at <= now()
  `;
  const after = await activePlatformOperatorCount(tx);
  // Emit a single audit entry summarizing the sweep, not one per affected row.
  await writeAudit(tx, config, {
    actorKind: "system",
    action: EXPIRE_ACTION,
    ...auditMeta({} as any),
    metadata: { activeBefore: before, activeAfter: after },
  });
  return after;
}

export async function breakGlassGrant(
  tx: Tx,
  config: AppConfig,
  sql: Parameters<Tx>[0] extends infer T ? T : never,
  targetUserId: string,
  reason: string,
  actorUserId: string,
  appEnv: string,
): Promise<{ requestId: string; expiresAt: Date }> {
  if (appEnv === "production") {
    throw new DependencyError("Break-glass grant is disabled in production");
  }
  const eligibility = await checkEligibility(tx, targetUserId, appEnv, true);
  if (!eligibility.emailVerified) throw new ForbiddenError("The nominated account email must be verified");
  if (!eligibility.totpEnrolled) throw new ForbiddenError("The nominated account must have a strong MFA method enrolled");

  const requestId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + BREAK_GLASS_DURATION_HOURS * 3600_000);
  await tx`
    insert into platform_roles (user_id, role, granted_by, approved_by, request_id, granted_at, expires_at)
    values (${eligibility.id}, 'platform_operator', ${actorUserId}, null, ${requestId}, now(), ${expiresAt})
    on conflict (user_id, role) where role = 'platform_operator' do nothing
  `;
  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: BREAK_GLASS_GRANT_ACTION,
    resourceType: "PlatformRole",
    resourceId: eligibility.id,
    ...auditMeta({} as any),
    metadata: { targetUserId: eligibility.id, source: BREAK_GLASS_SOURCE, reason, expiresAt: expiresAt.toISOString() },
  });
  return { requestId, expiresAt };
}
