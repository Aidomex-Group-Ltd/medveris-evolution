import { randomToken, sha256Hex } from "@medveris/auth";
import { withContext, type ShardState, type Sql } from "@medveris/db";
import type { AppConfig } from "../config.js";
import type { AuthContext, MembershipRecord, SessionRecord, UserRecord } from "../types.js";
import { withImpliedRoles, type Role } from "@medveris/authz";

export const SESSION_COOKIE = "mv_session";

export interface NewSession {
  id: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
  activeTenantId: string | null;
}

export async function createSession(
  sql: Sql,
  config: AppConfig,
  userId: string,
  options: { mfaVerified: boolean; activeTenantId?: string | null; userAgent?: string | null; ip?: string | null },
): Promise<NewSession> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.sessionTtlMinutes * 60_000);
  await sql`
    insert into sessions (id, user_id, token_hash, csrf_token, active_tenant_id, mfa_verified_at, expires_at, user_agent, ip_address)
    values (${id}, ${userId}, ${tokenHash}, ${csrfToken}, ${options.activeTenantId ?? null},
      ${options.mfaVerified ? new Date() : null}, ${expiresAt}, ${options.userAgent ?? null}, ${options.ip ?? null})
  `;
  return { id, token, csrfToken, expiresAt, activeTenantId: options.activeTenantId ?? null };
}

export async function loadAuthContext(sql: Sql, token: string): Promise<AuthContext | null> {
  const tokenHash = await sha256Hex(token);
  const rows = await sql`
    select s.id as session_id, s.user_id, s.csrf_token, s.active_tenant_id, s.mfa_verified_at, s.expires_at, s.revoked_at,
           u.id as user_id2, u.email, u.email_verified_at, u.display_name, u.given_name, u.family_name, u.status,
           u.totp_secret_enc, u.mfa_enrolled_at, u.created_at
      from sessions s join users u on u.id = s.user_id
     where s.token_hash = ${tokenHash}
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const session: SessionRecord = {
    id: row.sessionId as string,
    userId: row.userId as string,
    csrfToken: row.csrfToken as string,
    activeTenantId: (row.activeTenantId as string | null) ?? null,
    mfaVerifiedAt: (row.mfaVerifiedAt as Date | null) ?? null,
    expiresAt: row.expiresAt as Date,
    revokedAt: (row.revokedAt as Date | null) ?? null,
  };
  if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
  if (row.status !== "active") return null;
  const user: UserRecord = {
    id: row.userId2 as string,
    email: row.email as string,
    emailVerifiedAt: (row.emailVerifiedAt as Date | null) ?? null,
    displayName: row.displayName as string,
    givenName: row.givenName as string,
    familyName: row.familyName as string,
    status: row.status as string,
    totpSecretEnc: (row.totpSecretEnc as string | null) ?? null,
    mfaEnrolledAt: (row.mfaEnrolledAt as Date | null) ?? null,
    createdAt: row.createdAt as Date,
  };
  const related = await withContext(sql, { userId: user.id, actorKind: "staff" }, async (tx) => {
    const membershipsRaw = await tx`
      select m.id, m.tenant_id, t.name as tenant_name, t.slug as tenant_slug, m.roles, m.status,
             m.scope_department_id, m.scope_unit_id,
             t.workspace_kind, t.service_category, t.enabled_modules, t.organization_id,
             a.shard_id, a.state as shard_state, a.routing_version
        from memberships m join tenants t on t.id = m.tenant_id
        left join tenant_shard_assignments a on a.tenant_id = m.tenant_id
       where m.user_id = ${user.id} and m.status = 'active' and t.status = 'active'
       order by t.name
    `;
    const patientRows = await tx`select patient_id from patient_accounts where user_id = ${user.id} limit 1`;
    const platformRows = await tx`select role from platform_roles where user_id = ${user.id}`;
    const roleGrantRows = await tx`
      select tenant_id, role from role_grants
       where user_id = ${user.id} and status = 'approved'
         and starts_at <= now() and (expires_at is null or expires_at > now())
    `;
    return { membershipsRaw, patientRows, platformRows, roleGrantRows };
  });
  const memberships: MembershipRecord[] = related.membershipsRaw
    .filter((m) => m.status === "active")
    .map((m) => ({
      id: m.id as string,
      tenantId: m.tenantId as string,
      tenantName: m.tenantName as string,
      tenantSlug: m.tenantSlug as string,
      roles: (m.roles as string[]) as Role[],
      status: m.status as string,
      shard: m.shardId
        ? { tenantId: m.tenantId as string, shardId: m.shardId as string, state: m.shardState as ShardState, routingVersion: Number(m.routingVersion) }
        : null,
      scope: { departmentId: (m.scopeDepartmentId as string | null) ?? null, unitId: (m.scopeUnitId as string | null) ?? null },
      workspace: {
        workspaceKind: String(m.workspaceKind ?? "facility"),
        serviceCategory: (m.serviceCategory as string | null) ?? null,
        enabledModules: (m.enabledModules as string[] | null) ?? [],
        organizationId: (m.organizationId as string | null) ?? null,
      },
    }));
  for (const grant of related.roleGrantRows) {
    const membership = memberships.find((m) => m.tenantId === grant.tenantId);
    if (!membership) continue;
    const role = grant.role as Role;
    if (!membership.roles.includes(role)) membership.roles = [...membership.roles, role];
  }
  for (const membership of memberships) membership.roles = withImpliedRoles(membership.roles);
  const active = memberships.find((m) => m.tenantId === session.activeTenantId) ?? null;
  if (session.activeTenantId && !active) {
    await sql`update sessions set active_tenant_id = null where id = ${session.id}`;
    session.activeTenantId = null;
  }
  const patientRows = related.patientRows;
  const platformRows = related.platformRows;
  return {
    user,
    session,
    memberships,
    activeTenant: active
      ? {
          id: active.tenantId,
          name: active.tenantName,
          slug: active.tenantSlug,
          roles: active.roles,
          membershipId: active.id,
          shard: active.shard,
          scope: active.scope,
          workspace: active.workspace,
        }
      : null,
    patientId: (patientRows[0]?.patientId as string | undefined) ?? null,
    platformRoles: platformRows.map((r) => r.role as string),
    mfaVerified: Boolean(session.mfaVerifiedAt) && Boolean(user.mfaEnrolledAt),
  };
}

export async function revokeSession(sql: Sql, sessionId: string, reason: string): Promise<void> {
  await sql`update sessions set revoked_at = now(), revoked_reason = ${reason} where id = ${sessionId} and revoked_at is null`;
}
