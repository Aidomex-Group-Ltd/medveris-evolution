import type { Tx } from "@medveris/db";
import { writeAudit } from "./audit.js";
import type { AppConfig } from "../config.js";
import {
  ConflictError,
  DuplicateRequestError,
  ForbiddenError,
  LastOperatorRevocationForbiddenError,
  NotFoundError,
  PlatformOperatorUnderstaffedError,
  RequestAlreadyDecidedError,
  SyntheticTargetInProductionError,
  ValidationError,
} from "./errors.js";

export const MAX_REQUEST_REASON_LENGTH = 500;
export const MIN_REQUEST_REASON_LENGTH = 10;

export const LEGACY_ELEVATE_ACTION = "platform_operator.legacy_elevate";
export const LEGACY_REVOKE_ACTION = "platform_operator.legacy_revoke";
export const REQUEST_ACTION = "platform_operator.request";
export const APPROVE_ACTION = "platform_operator.approve";
export const DENY_ACTION = "platform_operator.deny";
export const CANCEL_ACTION = "platform_operator.cancel";
export const REVOKE_ACTION = "platform_operator.revoke";
export const EXPIRE_ACTION = "platform_operator.expire";
export const BREAK_GLASS_GRANT_ACTION = "platform_operator.break_glass_grant";

export const BREAK_GLASS_SOURCE = "cli";
export const BREAK_GLASS_DURATION_HOURS = 7 * 24;

/** Structured audit context handed in by the route (never a live Hono context). */
export interface PlatformAuditMeta {
  correlationId?: string;
  ipAddress?: string | null;
}

export interface EligibleUser {
  id: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  totpEnrolled: boolean;
  status: string;
}

function reasonLengthError(): ValidationError {
  return new ValidationError(
    `Reason must be between ${MIN_REQUEST_REASON_LENGTH} and ${MAX_REQUEST_REASON_LENGTH} characters`,
  );
}

function assertReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REQUEST_REASON_LENGTH || trimmed.length > MAX_REQUEST_REASON_LENGTH) {
    throw reasonLengthError();
  }
  return trimmed;
}

/**
 * Resolves the nominated account by email or id. Only the columns the workflow needs are
 * selected; email is never returned to the client.
 */
export async function resolveUserForResource(
  tx: Tx,
  email: string | null,
  userId: string | null,
): Promise<EligibleUser> {
  const lower = (email ?? "").trim().toLowerCase();
  if (!lower && !userId) throw new ValidationError("Email or user id is required");

  const rows = userId
    ? await tx`
        select id, display_name, email_verified_at, mfa_enrolled_at, totp_secret_enc, status
          from users where id = ${userId} limit 1
      `
    : await tx`
        select id, display_name, email_verified_at, mfa_enrolled_at, totp_secret_enc, status
          from users where lower(email) = ${lower} limit 1
      `;

  const row = rows[0];
  if (!row) throw new NotFoundError("No eligible account matches that email or user id");

  return {
    id: row.id as string,
    displayName: row.displayName as string,
    emailVerified: Boolean(row.emailVerifiedAt),
    mfaEnrolled: Boolean(row.mfaEnrolledAt),
    totpEnrolled: Boolean(row.totpSecretEnc),
    status: row.status as string,
  };
}

/**
 * A platform operator must be an active, verified account with a strong second factor.
 * Synthetic/demo accounts and patient accounts can never hold platform access in production.
 */
export async function checkEligibility(tx: Tx, userId: string, appEnv: string): Promise<EligibleUser> {
  const rows = await tx`
    select id, display_name, email_verified_at, mfa_enrolled_at, totp_secret_enc, status, email
      from users where id = ${userId} limit 1
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError("User not found");
  if (row.status !== "active") throw new ForbiddenError("The account is not active or is disabled");
  if (!row.emailVerifiedAt) throw new ForbiddenError("The account email has not been verified");
  if (!row.mfaEnrolledAt) {
    throw new ForbiddenError("MFA must be enrolled before the account can be granted platform access");
  }
  if (!row.totpSecretEnc) {
    throw new ForbiddenError("Platform access requires a stronger MFA method than email codes");
  }
  if (appEnv === "production") {
    const email = String(row.email ?? "").toLowerCase();
    if (email.endsWith(".test") || email.endsWith(".local") || email.endsWith(".example")) {
      throw new SyntheticTargetInProductionError();
    }
    const patient = await tx`select 1 from patient_accounts where user_id = ${userId} limit 1`;
    if (patient.length) {
      throw new SyntheticTargetInProductionError("A patient account cannot also hold platform access");
    }
  }
  return {
    id: row.id as string,
    displayName: row.displayName as string,
    emailVerified: true,
    mfaEnrolled: true,
    totpEnrolled: true,
    status: row.status as string,
  };
}

export async function activePlatformOperatorCount(tx: Tx): Promise<number> {
  const rows = await tx`
    select count(*)::int as n
      from platform_roles
     where role = 'platform_operator'
       and revoked_at is null
       and (expires_at is null or expires_at > now())
  `;
  return Number(rows[0]?.n ?? 0);
}

/** Ending a session immediately makes a privilege change take effect. */
export async function revokeSessionsForUser(tx: Tx, userId: string, reason: string): Promise<void> {
  await tx`
    update sessions set revoked_at = now(), revoked_reason = ${reason}
     where user_id = ${userId} and revoked_at is null
  `;
}

async function hasActiveOperatorGrant(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx`
    select 1 from platform_roles
     where user_id = ${userId}
       and role = 'platform_operator'
       and revoked_at is null
       and (expires_at is null or expires_at > now())
     limit 1
  `;
  return rows.length > 0;
}

export interface CreateRequestInput {
  email?: string | null;
  userId?: string | null;
  reason: string;
  durationHours: number | null;
  actorUserId: string;
}

export async function createPlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  input: CreateRequestInput,
): Promise<{ requestId: string; targetUserId: string; expiresAt: Date }> {
  const reason = assertReason(input.reason);
  const target = await resolveUserForResource(tx, input.email ?? null, input.userId ?? null);
  await checkEligibility(tx, target.id, config.appEnv);
  if (await hasActiveOperatorGrant(tx, target.id)) {
    throw new ConflictError("That account already holds an active platform operator grant");
  }

  if (input.durationHours !== null && (!Number.isFinite(input.durationHours) || input.durationHours < 1)) {
    throw new ValidationError("durationHours must be a positive number of hours");
  }
  const hours = input.durationHours === null
    ? config.platformRoles.defaultGrantHours
    : Math.min(input.durationHours, config.platformRoles.maxGrantHours);
  const expiresAt = new Date(Date.now() + hours * 3_600_000);

  const requestId = crypto.randomUUID();
  const inserted = await tx`
    insert into platform_role_requests (id, role, target_user_id, requested_by, reason, status, expires_at, created_at)
    values (${requestId}, 'platform_operator', ${target.id}, ${input.actorUserId}, ${reason}, 'pending', ${expiresAt}, now())
    on conflict (target_user_id, role) where status = 'pending' do nothing
    returning id
  `;
  if (!inserted.length) {
    throw new DuplicateRequestError();
  }

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId: input.actorUserId,
    action: REQUEST_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { targetUserId: target.id, reasonLength: reason.length, requestedDurationHours: input.durationHours },
  });

  return { requestId, targetUserId: target.id, expiresAt };
}

export async function approvePlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  requestId: string,
  actorUserId: string,
  decisionNote: string,
): Promise<{ targetUserId: string; expiresAt: Date }> {
  const rows = await tx`
    select id, target_user_id, requested_by, status, expires_at, decided_by
      from platform_role_requests
     where id = ${requestId} and status = 'pending'
     for update
  `;
  const request = rows[0];
  if (!request) throw new NotFoundError("Request not found, already decided, or expired");
  if (new Date(request.expiresAt as Date).getTime() <= Date.now()) {
    throw new RequestAlreadyDecidedError("That request has expired");
  }
  if (request.requestedBy === actorUserId) {
    throw new ForbiddenError("You cannot approve your own request");
  }
  if (request.targetUserId === actorUserId) {
    throw new ForbiddenError("You cannot approve a request that nominates you");
  }

  const targetUserId = request.targetUserId as string;
  await checkEligibility(tx, targetUserId, config.appEnv);
  if (await hasActiveOperatorGrant(tx, targetUserId)) {
    throw new ConflictError("That account already holds an active platform operator grant");
  }
  if ((await activePlatformOperatorCount(tx)) < 1) {
    throw new PlatformOperatorUnderstaffedError();
  }

  const expiresAt = new Date(request.expiresAt as Date);
  const granted = await tx`
    insert into platform_roles (user_id, role, granted_by, approved_by, request_id, granted_at, expires_at)
    values (${targetUserId}, 'platform_operator', ${request.requestedBy}, ${actorUserId}, ${request.id}, now(), ${expiresAt})
    on conflict (user_id, role) where role = 'platform_operator' do nothing
    returning user_id
  `;
  if (!granted.length) {
    throw new ConflictError("That account already holds a platform operator grant");
  }

  const decided = await tx`
    update platform_role_requests
       set status = 'approved', decided_by = ${actorUserId}, decided_at = now(), decision_note = ${decisionNote}
     where id = ${requestId} and status = 'pending'
    returning id
  `;
  if (!decided.length) throw new RequestAlreadyDecidedError();

  await revokeSessionsForUser(tx, targetUserId, "platform-operator-granted");

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: APPROVE_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { targetUserId, decisionNote, expiresAt: expiresAt.toISOString() },
  });

  return { targetUserId, expiresAt };
}

export async function denyPlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  requestId: string,
  actorUserId: string,
  decisionNote: string,
): Promise<void> {
  const rows = await tx`
    select id, target_user_id, requested_by, status
      from platform_role_requests
     where id = ${requestId} and status = 'pending'
     for update
  `;
  const request = rows[0];
  if (!request) throw new NotFoundError("Request not found, already decided, or expired");
  if (request.requestedBy === actorUserId) throw new ForbiddenError("You cannot deny your own request");
  if (request.targetUserId === actorUserId) {
    throw new ForbiddenError("You cannot deny a request that nominates you");
  }

  const updated = await tx`
    update platform_role_requests
       set status = 'denied', decided_by = ${actorUserId}, decided_at = now(), decision_note = ${decisionNote}
     where id = ${requestId} and status = 'pending'
    returning id
  `;
  if (!updated.length) throw new RequestAlreadyDecidedError();

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: DENY_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { targetUserId: request.targetUserId, decisionNote },
  });
}

export async function cancelPlatformRoleRequest(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  requestId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const rows = await tx`
    select id, target_user_id, requested_by, status
      from platform_role_requests
     where id = ${requestId} and status = 'pending'
     for update
  `;
  const request = rows[0];
  if (!request) throw new NotFoundError("Request not found, already decided, or expired");
  if (request.requestedBy !== actorUserId) {
    throw new ForbiddenError("Only the requester can cancel this request");
  }

  const updated = await tx`
    update platform_role_requests
       set status = 'cancelled', decided_by = ${actorUserId}, decided_at = now(), decision_note = ${reason}
     where id = ${requestId} and status = 'pending'
    returning id
  `;
  if (!updated.length) throw new RequestAlreadyDecidedError();

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: CANCEL_ACTION,
    resourceType: "PlatformRoleRequest",
    resourceId: requestId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { targetUserId: request.targetUserId, reason },
  });
}

export async function revokePlatformRoleGrant(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  targetUserId: string,
  actorUserId: string | null,
  reason: string,
): Promise<void> {
  const trimmed = assertReason(reason);
  if (actorUserId !== null && actorUserId === targetUserId) {
    throw new ForbiddenError("You cannot revoke your own platform access");
  }

  const rows = await tx`
    select user_id, role, revoked_at
      from platform_roles
     where user_id = ${targetUserId} and role = 'platform_operator'
     for update
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError("The nominated account does not hold a platform operator grant");
  if (row.revokedAt !== null) throw new ConflictError("That grant has already been revoked");

  if ((await activePlatformOperatorCount(tx)) <= 1) {
    throw new LastOperatorRevocationForbiddenError();
  }

  await tx`
    update platform_roles
       set revoked_at = now(), revoked_by = ${actorUserId}, revoked_reason = ${trimmed}
     where user_id = ${targetUserId}
       and role = 'platform_operator'
       and revoked_at is null
  `;

  await revokeSessionsForUser(tx, targetUserId, "platform-operator-revoked");

  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: REVOKE_ACTION,
    resourceType: "PlatformRole",
    resourceId: targetUserId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { targetUserId, reason: trimmed },
  });
}

/** Soft-revokes grants whose expiry has passed. Run by the scheduled sweep. */
export async function expireStaleGrants(tx: Tx, config: AppConfig): Promise<number> {
  const before = await activePlatformOperatorCount(tx);
  const revoked = await tx`
    update platform_roles
       set revoked_at = now(), revoked_reason = 'grant-expired'
     where role = 'platform_operator'
       and revoked_at is null
       and expires_at is not null
       and expires_at <= now()
    returning user_id
  `;
  const after = await activePlatformOperatorCount(tx);
  if (revoked.length) {
    await writeAudit(tx, config, {
      actorKind: "system",
      action: EXPIRE_ACTION,
      resourceType: "PlatformRole",
      metadata: { activeBefore: before, activeAfter: after, revoked: revoked.length },
    });
  }
  return revoked.length;
}

/**
 * Break-glass is a CLI-only bootstrap path. In production it must be requested with an extra
 * explicit flag so no script or scheduled job can silently grant platform access.
 */
export function assertBreakGlassAllowed(appEnv: string, args: readonly string[]): void {
  if (appEnv !== "production") return;
  if (!args.includes("--allow-production")) {
    throw new ForbiddenError("Break-glass grants in production require the explicit --allow-production flag");
  }
  if (!args.some((arg) => arg.startsWith("--reason="))) {
    throw new ValidationError("Break-glass grants in production require an explicit --reason=");
  }
}

export async function breakGlassGrant(
  tx: Tx,
  config: AppConfig,
  targetUserId: string,
  reason: string,
  actorUserId: string | null,
  options: { allowProduction: boolean; hours?: number },
): Promise<{ expiresAt: Date }> {
  if (config.appEnv === "production" && !options.allowProduction) {
    throw new ForbiddenError("Break-glass grants in production require the explicit --allow-production flag");
  }
  const trimmed = assertReason(reason);
  await checkEligibility(tx, targetUserId, config.appEnv);
  if (await hasActiveOperatorGrant(tx, targetUserId)) {
    throw new ConflictError("That account already holds an active platform operator grant");
  }

  const hours = Math.min(options.hours ?? BREAK_GLASS_DURATION_HOURS, config.platformRoles.maxGrantHours);
  const expiresAt = new Date(Date.now() + hours * 3_600_000);

  await tx`
    insert into platform_roles (user_id, role, granted_by, approved_by, request_id, granted_at, expires_at)
    values (${targetUserId}, 'platform_operator', ${actorUserId}, null, null, now(), ${expiresAt})
    on conflict (user_id, role) where role = 'platform_operator' do nothing
  `;

  await writeAudit(tx, config, {
    actorKind: "system",
    actorUserId,
    action: BREAK_GLASS_GRANT_ACTION,
    resourceType: "PlatformRole",
    resourceId: targetUserId,
    metadata: { targetUserId, source: BREAK_GLASS_SOURCE, reason: trimmed, expiresAt: expiresAt.toISOString() },
  });

  return { expiresAt };
}

/** Legacy direct elevate, kept only behind the synthetic-environment gate. */
export async function legacyGrantPlatformRole(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  targetUserId: string,
  actorUserId: string,
  notes: string | null,
): Promise<void> {
  await checkEligibility(tx, targetUserId, config.appEnv);
  if (await hasActiveOperatorGrant(tx, targetUserId)) {
    throw new ConflictError("User already holds platform_operator role");
  }
  await tx`
    insert into platform_roles (user_id, role, granted_by, granted_at, expires_at)
    values (${targetUserId}, 'platform_operator', ${actorUserId}, now(), now() + interval '24 hours')
  `;
  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: LEGACY_ELEVATE_ACTION,
    resourceType: "PlatformRole",
    resourceId: targetUserId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { role: "platform_operator", elevatedBy: actorUserId, notes },
  });
}

/** Legacy direct revoke: soft-revokes instead of deleting the audit-relevant row. */
export async function legacyRevokePlatformRole(
  tx: Tx,
  config: AppConfig,
  meta: PlatformAuditMeta,
  targetUserId: string,
  actorUserId: string,
): Promise<void> {
  const rows = await tx`
    select user_id from platform_roles
     where user_id = ${targetUserId} and role = 'platform_operator' and revoked_at is null
     for update
  `;
  if (!rows.length) throw new NotFoundError("User does not hold platform_operator role");
  if (actorUserId === targetUserId) {
    throw new ConflictError("Users may not revoke their own platform_operator role");
  }
  if ((await activePlatformOperatorCount(tx)) <= 1) {
    throw new LastOperatorRevocationForbiddenError();
  }
  await tx`
    update platform_roles
       set revoked_at = now(), revoked_by = ${actorUserId}, revoked_reason = 'legacy-revoke'
     where user_id = ${targetUserId} and role = 'platform_operator' and revoked_at is null
  `;
  await revokeSessionsForUser(tx, targetUserId, "platform-operator-revoked");
  await writeAudit(tx, config, {
    actorKind: "staff",
    actorUserId,
    action: LEGACY_REVOKE_ACTION,
    resourceType: "PlatformRole",
    resourceId: targetUserId,
    correlationId: meta.correlationId,
    ipAddress: meta.ipAddress ?? null,
    metadata: { role: "platform_operator", revokedBy: actorUserId },
  });
}
