import { hashPassword, sha256Hex } from "@medveris/auth";
import { setLocalContext, type Sql, type Tx } from "@medveris/db";
import type { AppConfig } from "../config.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, ConflictError } from "../lib/errors.js";

/**
 * Staff invitation lifecycle. The facility, role and inviter always come from the invitation row the
 * administrator created; nothing the invitee submits besides the emailed token selects them.
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Roles that are not facility staff roles and can never be granted through an invitation. */
export const NON_INVITABLE_ROLES: ReadonlySet<string> = new Set(["patient", "proxy", "credential_reviewer"]);

export type InvitationStatus = "pending" | "accepted" | "revoked" | "declined" | "expired" | "facility_unavailable" | "inviter_unauthorized";

export interface InvitationRow {
  id: string;
  tenantId: string;
  email: string;
  roles: string[];
  invitedBy: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedBy: string | null;
  revokedAt: Date | null;
  declinedAt: Date | null;
  scopeDepartmentId: string | null;
  scopeUnitId: string | null;
}

interface Facility {
  id: string;
  name: string;
  facilityType: string | null;
  city: string | null;
  country: string | null;
  status: string;
}

interface LoadedInvitation {
  invitation: InvitationRow;
  facility: Facility;
  inviterIsAdmin: boolean;
}

export interface AuditMeta {
  correlationId?: string | null;
  ipAddress?: string | null;
}

export function invitationStatus(loaded: LoadedInvitation, now = new Date()): InvitationStatus {
  const { invitation, facility, inviterIsAdmin } = loaded;
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  if (invitation.declinedAt) return "declined";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
  if (facility.status !== "active") return "facility_unavailable";
  if (!inviterIsAdmin) return "inviter_unauthorized";
  return "pending";
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Refusal for an invitation that exists but cannot be acted on; the code names the state for the client. */
function notPending(status: InvitationStatus): AppError {
  const messages: Record<InvitationStatus, string> = {
    pending: "",
    accepted: "This invitation has already been used",
    revoked: "This invitation was withdrawn by the facility",
    declined: "This invitation was declined",
    expired: "This invitation has expired",
    facility_unavailable: "This facility is not currently accepting staff",
    inviter_unauthorized: "The person who sent this invitation can no longer invite staff",
  };
  return new AppError(410, `invitation_${status}`, messages[status]);
}

const INVALID = () => new AppError(404, "invitation_invalid", "This invitation link is not valid");

/**
 * Makes exactly the invitation matching the emailed token visible in this transaction, then scopes the
 * transaction to its facility. Returns null for an unknown token.
 */
async function loadByToken(tx: Tx, token: string, options: { lock: boolean; userId?: string | null }): Promise<LoadedInvitation | null> {
  const tokenHash = await sha256Hex(token);
  await setLocalContext(tx, { actorKind: "registration", userId: options.userId ?? null });
  await tx`select set_config('app.invitation_token_hash', ${tokenHash}, true)`;
  const rows = options.lock
    ? await tx`
        select id, tenant_id, email, roles, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at, declined_at,
               scope_department_id, scope_unit_id
          from invitations where token_hash = ${tokenHash} for update`
    : await tx`
        select id, tenant_id, email, roles, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at, declined_at,
               scope_department_id, scope_unit_id
          from invitations where token_hash = ${tokenHash}`;
  const row = rows[0];
  if (!row) return null;
  const invitation: InvitationRow = {
    id: String(row.id),
    tenantId: String(row.tenantId),
    email: String(row.email),
    roles: row.roles as string[],
    invitedBy: String(row.invitedBy),
    createdAt: row.createdAt as Date,
    expiresAt: row.expiresAt as Date,
    acceptedAt: (row.acceptedAt as Date | null) ?? null,
    acceptedBy: (row.acceptedBy as string | null) ?? null,
    revokedAt: (row.revokedAt as Date | null) ?? null,
    declinedAt: (row.declinedAt as Date | null) ?? null,
    scopeDepartmentId: (row.scopeDepartmentId as string | null) ?? null,
    scopeUnitId: (row.scopeUnitId as string | null) ?? null,
  };
  await setLocalContext(tx, { actorKind: "registration", tenantId: invitation.tenantId, userId: options.userId ?? null });
  const [facility] = await tx`
    select id, name, facility_type, city, country, status from tenants where id = ${invitation.tenantId}`;
  const inviter = await tx`
    select 1 from memberships
     where tenant_id = ${invitation.tenantId} and user_id = ${invitation.invitedBy} and status = 'active'
       and ('facility_admin' = any(roles)
            or ('department_admin' = any(roles) and scope_department_id is not distinct from ${row.scopeDepartmentId ?? null}::uuid))`;
  return {
    invitation,
    facility: {
      id: String(facility!.id),
      name: String(facility!.name),
      facilityType: (facility!.facilityType as string | null) ?? null,
      city: (facility!.city as string | null) ?? null,
      country: (facility!.country as string | null) ?? null,
      status: String(facility!.status),
    },
    inviterIsAdmin: inviter.length > 0,
  };
}

function publicFacility(facility: Facility) {
  return { id: facility.id, name: facility.name, facilityType: facility.facilityType, city: facility.city, country: facility.country };
}

async function auditDenied(sql: Sql, config: AppConfig, input: { tenantId: string; userId: string | null; invitationId: string; reason: string; meta: AuditMeta }) {
  await sql.begin(async (tx) => {
    await setLocalContext(tx, { actorKind: "registration", tenantId: input.tenantId, userId: input.userId });
    await writeAudit(tx, config, {
      tenantId: input.tenantId,
      actorKind: "registration",
      actorUserId: input.userId,
      action: "membership.accept-invitation",
      decision: "deny",
      reasonCode: input.reason,
      resourceType: "Invitation",
      resourceId: input.invitationId,
      ...input.meta,
    });
  });
}

export interface Viewer {
  id: string;
  email: string;
}

/** Read-only view for the confirmation page. Never changes the invitation. */
export async function describeInvitation(sql: Sql, token: string, viewer: Viewer | null) {
  return sql.begin(async (tx) => {
    const loaded = await loadByToken(tx, token, { lock: false, userId: viewer?.id ?? null });
    if (!loaded) throw INVALID();
    const status = invitationStatus(loaded);
    const { invitation, facility } = loaded;
    const accounts = status === "pending" ? await tx`select 1 from users where lower(email) = lower(${invitation.email}) limit 1` : [];
    return {
      status,
      facility: publicFacility(facility),
      roles: status === "pending" ? invitation.roles : [],
      invitedEmail: maskEmail(invitation.email),
      expiresAt: invitation.expiresAt.toISOString(),
      recipientHasAccount: accounts.length > 0,
      viewer: {
        authenticated: Boolean(viewer),
        matchesRecipient: viewer ? sameEmail(viewer.email, invitation.email) : null,
        acceptedByViewer: Boolean(viewer && invitation.acceptedBy === viewer.id),
      },
    };
  });
}

/**
 * Creates the account for an invitee who has none. Receiving the token at the invited address proves
 * control of it, so the email is recorded as verified. The invitation itself is not accepted here.
 */
export async function registerInvitee(
  sql: Sql,
  config: AppConfig,
  input: { token: string; givenName: string; familyName: string; password: string; meta: AuditMeta },
): Promise<{ userId: string }> {
  const passwordHash = await hashPassword(input.password);
  return sql.begin(async (tx) => {
    const loaded = await loadByToken(tx, input.token, { lock: true });
    if (!loaded) throw INVALID();
    const status = invitationStatus(loaded);
    if (status !== "pending") throw notPending(status);
    const { invitation } = loaded;
    const existing = await tx`select 1 from users where lower(email) = lower(${invitation.email}) limit 1`;
    if (existing.length) {
      throw new AppError(409, "invitation_account_exists", "An account already exists for this email. Sign in to accept the invitation.");
    }
    const userId = crypto.randomUUID();
    await tx`
      insert into users (id, email, password_hash, display_name, given_name, family_name, email_verified_at)
      values (${userId}, ${invitation.email.toLowerCase()}, ${passwordHash}, ${`${input.givenName} ${input.familyName}`},
        ${input.givenName}, ${input.familyName}, now())`;
    await writeAudit(tx, config, {
      tenantId: invitation.tenantId,
      actorKind: "registration",
      actorUserId: userId,
      action: "auth.register.invitee",
      resourceType: "Invitation",
      resourceId: invitation.id,
      ...input.meta,
    });
    return { userId };
  });
}

export type AcceptOutcome = "accepted" | "already-accepted";

interface Accepted {
  outcome: AcceptOutcome;
  facility: ReturnType<typeof publicFacility>;
  roles: string[];
  membershipId: string;
}

type AcceptResult =
  | { accepted: Accepted }
  | { denied: { tenantId: string; invitationId: string; reason: string; error: AppError } };

/**
 * Accepts for the signed-in account. The invitation row is locked, so concurrent or retried requests
 * create one membership and one acceptance audit event.
 */
export async function acceptInvitation(
  sql: Sql,
  config: AppConfig,
  input: { token: string; user: Viewer; meta: AuditMeta },
): Promise<Accepted> {
  const result = await sql.begin(async (tx): Promise<AcceptResult> => {
    const loaded = await loadByToken(tx, input.token, { lock: true, userId: input.user.id });
    if (!loaded) throw INVALID();
    const { invitation, facility } = loaded;
    if (invitation.acceptedAt) {
      if (invitation.acceptedBy !== input.user.id) {
        return { denied: { tenantId: invitation.tenantId, invitationId: invitation.id, reason: "accepted_by_other", error: new AppError(409, "invitation_accepted_by_other", "This invitation was already accepted by a different account") } };
      }
      const [membership] = await tx`select id, roles from memberships where tenant_id = ${invitation.tenantId} and user_id = ${input.user.id}`;
      return { accepted: { outcome: "already-accepted", facility: publicFacility(facility), roles: (membership?.roles as string[]) ?? invitation.roles, membershipId: String(membership?.id ?? "") } };
    }
    const status = invitationStatus(loaded);
    if (status !== "pending") {
      return { denied: { tenantId: invitation.tenantId, invitationId: invitation.id, reason: status, error: notPending(status) } };
    }
    if (!sameEmail(input.user.email, invitation.email)) {
      return { denied: {
        tenantId: invitation.tenantId,
        invitationId: invitation.id,
        reason: "recipient_mismatch",
        error: new AppError(403, "invitation_recipient_mismatch", "This invitation was sent to a different email address. Sign in with the invited account to accept it."),
      } };
    }

    const [existing] = await tx`
      select id, roles, status, updated_at from memberships where tenant_id = ${invitation.tenantId} and user_id = ${input.user.id}`;
    let membershipId: string;
    let roles: string[];
    if (!existing) {
      membershipId = crypto.randomUUID();
      roles = invitation.roles;
      await tx`
        insert into memberships (id, tenant_id, user_id, roles, invited_by, scope_department_id, scope_unit_id)
        values (${membershipId}, ${invitation.tenantId}, ${input.user.id}, ${roles}, ${invitation.invitedBy},
          ${invitation.scopeDepartmentId}, ${invitation.scopeUnitId})`;
    } else if (existing.status === "active") {
      membershipId = String(existing.id);
      roles = [...new Set([...(existing.roles as string[]), ...invitation.roles])];
      // A membership has one scope; an existing scope is kept, otherwise the invitation's scope applies.
      await tx`
        update memberships set roles = ${roles},
          scope_department_id = coalesce(scope_department_id, ${invitation.scopeDepartmentId}::uuid),
          scope_unit_id = case when scope_department_id is null then ${invitation.scopeUnitId}::uuid else scope_unit_id end,
          updated_at = now()
         where id = ${membershipId}`;
    } else if (existing.status === "removed" && invitation.createdAt > (existing.updatedAt as Date)) {
      membershipId = String(existing.id);
      roles = invitation.roles;
      await tx`update memberships set roles = ${roles}, status = 'active', invited_by = ${invitation.invitedBy},
        scope_department_id = ${invitation.scopeDepartmentId}, scope_unit_id = ${invitation.scopeUnitId}, updated_at = now() where id = ${membershipId}`;
    } else {
      return { denied: {
        tenantId: invitation.tenantId,
        invitationId: invitation.id,
        reason: `membership_${existing.status}`,
        error: new AppError(409, "invitation_membership_blocked", "Your access to this facility is suspended or was removed after this invitation was sent. Contact the facility administrator."),
      } };
    }

    const updated = await tx`
      update invitations set accepted_at = now(), accepted_by = ${input.user.id}, membership_id = ${membershipId}
       where id = ${invitation.id} and accepted_at is null and revoked_at is null and declined_at is null
       returning id`;
    if (!updated.length) throw new ConflictError("The invitation changed while it was being accepted; reload and try again");
    await tx`update users set email_verified_at = coalesce(email_verified_at, now()) where id = ${input.user.id}`;
    await writeAudit(tx, config, {
      tenantId: invitation.tenantId,
      actorKind: "staff",
      actorUserId: input.user.id,
      actorRoles: roles,
      action: "membership.accept-invitation",
      resourceType: "Membership",
      resourceId: membershipId,
      ...input.meta,
      metadata: { invitationId: invitation.id, roles: invitation.roles, invitedBy: invitation.invitedBy },
    });
    return { accepted: { outcome: "accepted", facility: publicFacility(facility), roles, membershipId } };
  });
  if ("denied" in result) {
    const { error, ...denial } = result.denied;
    await auditDenied(sql, config, { ...denial, userId: input.user.id, meta: input.meta });
    throw error;
  }
  return result.accepted;
}

/** The token holder declines; the invitation can no longer be used. */
export async function declineInvitation(sql: Sql, config: AppConfig, input: { token: string; userId: string | null; meta: AuditMeta }): Promise<void> {
  await sql.begin(async (tx) => {
    const loaded = await loadByToken(tx, input.token, { lock: true, userId: input.userId });
    if (!loaded) throw INVALID();
    const status = invitationStatus(loaded);
    if (status !== "pending") throw notPending(status);
    await tx`update invitations set declined_at = now() where id = ${loaded.invitation.id} and declined_at is null`;
    await writeAudit(tx, config, {
      tenantId: loaded.invitation.tenantId,
      actorKind: "registration",
      actorUserId: input.userId,
      action: "membership.invitation.decline",
      resourceType: "Invitation",
      resourceId: loaded.invitation.id,
      ...input.meta,
    });
  });
}

/** Status for administrators, computed from the row alone (the facility and inviter are the admin's own). */
export function adminInvitationStatus(row: { acceptedAt: Date | null; revokedAt: Date | null; declinedAt: Date | null; expiresAt: Date }, now = new Date()): InvitationStatus {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.declinedAt) return "declined";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

/** The email carries only the facility name, the link and its expiry. */
export function invitationEmail(input: { origin: string; facilityName: string; token: string; expiresAt: Date }): { subject: string; text: string } {
  return {
    subject: `Invitation to join ${input.facilityName} on Medveris`,
    text: [
      `${input.facilityName} has invited you to join its staff on Medveris.`,
      "",
      `Review and accept the invitation: ${input.origin}/accept-invitation?token=${input.token}`,
      "",
      `The link expires on ${input.expiresAt.toUTCString()}. Opening it does not accept the invitation.`,
      "If you were not expecting this invitation, you can ignore this email or decline it from the link.",
    ].join("\n"),
  };
}

export function assertInvitable(roles: string[]): string | null {
  const refused = roles.filter((role) => NON_INVITABLE_ROLES.has(role));
  return refused.length ? `${refused.join(", ")} cannot be granted through a facility invitation` : null;
}

