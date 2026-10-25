import type { Context } from "hono";
import type { PolicyActor, ResourceContext } from "@medveris/authz";
import { assertAuthorized, type Permission } from "@medveris/authz";
import { withContext } from "@medveris/db";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import type { AppEnv } from "../types.js";

export interface AccessSummary {
  roles: string[];
  departments: Array<{ id: string; name: string; cadreCode: string | null; cadreName: string | null; isPrimary: boolean }>;
  specialties: string[];
  privileges: string[];
  engagementActive: boolean;
  credentialValid: boolean;
  careTeamPatientIds: string[];
  proxyPatientIds: string[];
}

export interface AccessActor {
  actor: PolicyActor;
  summary: AccessSummary;
}

/**
 * Assemble the trusted policy actor from the live database on every request.
 * Membership, role grants, engagement, assignments, privileges and care-team
 * relationships are re-read so revocation and expiry take effect immediately.
 */
export async function loadAccessActor(c: Context<AppEnv>): Promise<AccessActor> {
  const auth = requireAuth(c);
  const deps = c.get("deps");
  const baseRoles = auth.activeTenant?.roles ?? (auth.patientId ? ["patient"] : []);
  const summary: AccessSummary = {
    roles: [...baseRoles],
    departments: [],
    specialties: [],
    privileges: [],
    engagementActive: true,
    credentialValid: true,
    careTeamPatientIds: [],
    proxyPatientIds: [],
  };

  const actor: PolicyActor = {
    userId: auth.user.id,
    roles: baseRoles,
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId,
    mfaVerified: auth.mfaVerified,
    mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
    platformRoles: auth.platformRoles,
    membershipActive: auth.activeTenant ? auth.memberships.some((m) => m.tenantId === auth.activeTenant?.id && m.status === "active") : undefined,
    sessionRevokedAt: auth.session.revokedAt,
  };

  if (auth.activeTenant) {
    const access = await withContext(deps.sql, {
      tenantId: auth.activeTenant.id,
      userId: auth.user.id,
      patientId: auth.patientId,
      actorKind: "staff",
      roles: baseRoles,
    }, async (tx) => {
      const staffRows = await tx`select id from staff_persons where user_id = ${auth.user.id} limit 1`;
      const staffPersonId = staffRows[0]?.id as string | undefined;
      if (!staffPersonId) {
        return { engagementActive: false, departments: [], cadres: [], cadresNamed: [], privileges: [], careTeam: [], credentialValid: false };
      }
      const engagementRows = await tx`
        select e.id, e.status, e.start_date, e.end_date, c.code as cadre_code, c.name as cadre_name
          from engagements e
          left join job_titles j on j.id = e.job_title_id
          left join cadres c on c.id = j.cadre_id
         where e.tenant_id = ${auth.activeTenant!.id} and e.staff_person_id = ${staffPersonId}
           and e.status = 'active'
           and e.start_date <= current_date and (e.end_date is null or e.end_date >= current_date)
         limit 1
      `;
      const engagement = engagementRows[0];
      const assignmentRows = engagement
        ? await tx`
            select a.department_id, a.is_primary, d.name as department_name, c.code as cadre_code, c.name as cadre_name
              from department_assignments a
              join departments d on d.id = a.department_id
              left join engagements e on e.id = a.engagement_id
              left join job_titles j on j.id = e.job_title_id
              left join cadres c on c.id = j.cadre_id
             where a.engagement_id = ${engagement.id} and a.starts_on <= current_date
               and (a.ends_on is null or a.ends_on >= current_date)
          `
        : [];
      const privileges = engagement
        ? await tx`
            select p.code
              from privilege_grants g join privilege_catalog p on p.id = g.privilege_id
             where g.engagement_id = ${engagement.id} and g.status = 'approved'
               and (g.effective_from is null or g.effective_from <= current_date)
               and (g.expires_on is null or g.expires_on >= current_date)
          `
        : [];
      const careTeam = await tx`
        select distinct patient_id from care_team_members
         where tenant_id = ${auth.activeTenant!.id} and status = 'active'
           and (user_id = ${auth.user.id} or staff_person_id = ${staffPersonId})
           and starts_at <= now() and (ends_at is null or ends_at > now())
      `;
      const credentialRows = await tx`
        select 1 from credentials
         where subject_type = 'practitioner' and subject_user_id = ${auth.user.id}
           and status = 'verified' and expires_on >= current_date
         limit 1
      `;
      return {
        engagementActive: Boolean(engagement),
        departments: assignmentRows.map((row) => ({
          id: row.departmentId as string,
          name: row.departmentName as string,
          cadreCode: (row.cadreCode as string | null) ?? null,
          cadreName: (row.cadreName as string | null) ?? null,
          isPrimary: Boolean(row.isPrimary),
        })),
        cadres: [engagement?.cadreCode, ...assignmentRows.map((row) => row.cadreCode)].filter(Boolean) as string[],
        cadresNamed: [engagement?.cadreName, ...assignmentRows.map((row) => row.cadreName)].filter(Boolean) as string[],
        privileges: privileges.map((row) => String(row.code)),
        careTeam: careTeam.map((row) => String(row.patientId)),
        credentialValid: Boolean(credentialRows[0]) || privileges.length === 0,
      };
    });
    actor.engagementActive = access.engagementActive;
    actor.departmentIds = access.departments.map((d) => d.id);
    actor.cadreCodes = access.cadres.filter(Boolean).map((code) => String(code).toLowerCase());
    actor.specialties = [...access.cadres, ...access.cadresNamed].filter(Boolean).map((value) => String(value).toLowerCase());
    actor.privileges = access.privileges;
    actor.careTeamPatientIds = access.careTeam;
    actor.credentialValid = access.credentialValid;
    summary.departments = access.departments;
    summary.specialties = actor.specialties;
    summary.privileges = actor.privileges;
    summary.engagementActive = access.engagementActive;
    summary.credentialValid = access.credentialValid;
    summary.careTeamPatientIds = actor.careTeamPatientIds;
  }

  if (auth.patientId) {
    const proxies = await withContext(deps.sql, {
      patientId: auth.patientId,
      userId: auth.user.id,
      actorKind: "patient",
    }, async (tx) => tx`
      select scopes, expires_at from patient_proxies
       where proxy_user_id = ${auth.user.id} and status = 'active' and revoked_at is null
         and starts_at <= now() and (expires_at is null or expires_at > now())
    `);
    actor.proxyScopes = proxies.flatMap((row) => (row.scopes as string[]) ?? []);
    actor.proxyExpiresAt = proxies
      .map((row) => row.expiresAt as Date | null)
      .filter(Boolean)
      .sort((a, b) => (a!.getTime() - b!.getTime()))[0] ?? null;
  }

  return { actor, summary };
}

export async function loadStaffAccessActor(c: Context<AppEnv>): Promise<AccessActor> {
  requireStaff(c);
  return loadAccessActor(c);
}

export function policyDecision(actor: PolicyActor, action: Permission, resource: ResourceContext) {
  return assertAuthorized(actor, action, resource);
}
