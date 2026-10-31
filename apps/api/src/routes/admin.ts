import { Hono } from "hono";
import { randomToken, sha256Hex } from "@medveris/auth";
import { createInvitationSchema, dicomwebVerifySchema, updateMembershipSchema, uuidSchema } from "@medveris/contracts";
import { assertMembershipAdmin, type ActorContext, type Role } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import { isPlatformOperator, requireStaff, withPlatformActor, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { adminInvitationStatus, assertInvitable, INVITATION_TTL_MS, invitationEmail } from "../services/invitations.js";
import { integrationStatus, listIntegrations } from "../integrations/registry.js";
import { dicomwebClientFor } from "../integrations/dicomweb.js";
import { loadVerifications, recordVerification, runDicomwebVerification } from "../integrations/verification.js";
import { UNAVAILABLE_LABEL } from "../terminology/unavailable.js";
import type { AppEnv } from "../types.js";

export const adminRoutes = new Hono<AppEnv>();

/** Roles a department administrator may grant inside their own department. */
const DEPARTMENT_DELEGABLE: ReadonlySet<string> = new Set([
  "unit_lead", "staff", "report_viewer", "receptionist", "nurse", "midwife", "clinician", "specialist_clinician",
  "diagnostic_practitioner", "department_lead", "pharmacist", "laboratory", "lab_validator", "radiology", "radiographer",
  "radiologist", "ward_manager", "records", "theatre", "housekeeping", "porter", "mortuary", "cssd", "biomedical",
]);
const SCOPE_REQUIRED: ReadonlySet<string> = new Set(["department_admin", "unit_lead"]);

type Manager = { kind: "facility"; owner: boolean } | { kind: "department"; departmentId: string };

/** Facility administrators manage every membership; department administrators manage their own department only. */
function membershipManager(c: Parameters<typeof withStaffActor>[0]): Manager {
  const auth = requireStaff(c);
  const roles = auth.activeTenant!.roles as string[];
  if (roles.includes("facility_admin")) return { kind: "facility", owner: roles.includes("owner") };
  const departmentId = auth.activeTenant!.scope?.departmentId;
  if (roles.includes("department_admin") && departmentId) return { kind: "department", departmentId };
  throw new ForbiddenError("Facility or department administrator permission is required");
}

interface Scope { scopeDepartmentId?: string | null; scopeUnitId?: string | null }

/** Normalises and checks the department/unit scope for a role grant by this manager. */
async function checkedScope(tx: Tx, tenantId: string, manager: Manager, roles: string[], scope: Scope): Promise<{ departmentId: string | null; unitId: string | null }> {
  let departmentId = scope.scopeDepartmentId ?? null;
  const unitId = scope.scopeUnitId ?? null;
  if (unitId) {
    const [unit] = await tx`select department_id from units where id = ${unitId} and tenant_id = ${tenantId}`;
    if (!unit) throw new ValidationError("The unit does not belong to this facility");
    if (departmentId && departmentId !== unit.departmentId) throw new ValidationError("The unit does not belong to the selected department");
    departmentId = String(unit.departmentId);
  }
  if (departmentId) {
    const [department] = await tx`select 1 from departments where id = ${departmentId} and tenant_id = ${tenantId}`;
    if (!department) throw new ValidationError("The department does not belong to this facility");
  }
  if (manager.kind === "department") {
    const refused = roles.filter((role) => !DEPARTMENT_DELEGABLE.has(role));
    if (refused.length) throw new ForbiddenError(`A department administrator cannot grant ${refused.join(", ")}`);
    departmentId = departmentId ?? manager.departmentId;
    if (departmentId !== manager.departmentId) throw new ForbiddenError("You can only grant access within your own department");
  }
  if (roles.includes("unit_lead") && !unitId) throw new ValidationError("A unit lead needs the unit they lead");
  if (roles.some((role) => SCOPE_REQUIRED.has(role)) && !departmentId) throw new ValidationError("Department administrators need the department they administer");
  if (manager.kind === "facility" && roles.includes("owner") && !manager.owner) throw new ForbiddenError("Only an owner can grant ownership");
  return { departmentId, unitId };
}

async function ownerCount(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx`select count(*)::int as n from memberships where tenant_id = ${tenantId} and status = 'active' and 'owner' = any(roles)`;
  return Number(row?.n ?? 0);
}

function actor(c: Parameters<typeof withStaffActor>[0]): ActorContext {
  const auth = requireStaff(c);
  return {
    userId: auth.user.id,
    roles: auth.activeTenant?.roles ?? [],
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId,
    mfaVerified: auth.mfaVerified,
    mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
    platformRoles: auth.platformRoles,
  };
}

adminRoutes.get("/memberships", async (c) => {
  const auth = c.get("auth")!;
  const manager = membershipManager(c);
  const departmentId = manager.kind === "department" ? manager.departmentId : null;
  const rows = await withStaffActor(c, async (tx) => tx`
    select m.id, m.roles, m.status, m.created_at, m.scope_department_id, m.scope_unit_id, d.name as scope_department_name, un.name as scope_unit_name,
           u.id as user_id, u.display_name, u.email, u.email_verified_at, u.mfa_enrolled_at
      from memberships m join users u on u.id = m.user_id
      left join departments d on d.id = m.scope_department_id
      left join units un on un.id = m.scope_unit_id
     where m.tenant_id = ${auth.activeTenant!.id}
       and (${departmentId}::uuid is null or m.scope_department_id = ${departmentId}::uuid)
     order by m.created_at
  `);
  return c.json({ memberships: rows, manager: manager.kind, delegableRoles: manager.kind === "department" ? [...DEPARTMENT_DELEGABLE] : null });
});

adminRoutes.post("/invitations", async (c) => {
  const auth = c.get("auth")!;
  const manager = membershipManager(c);
  const deps = c.get("deps");
  const body = await parseJson(c, createInvitationSchema);
  const refused = assertInvitable(body.roles);
  if (refused) throw new ValidationError(refused);
  const tenantId = auth.activeTenant!.id;
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const facilityName = await withStaffActor(c, async (tx) => {
    const [facility] = await tx`select name, status from tenants where id = ${tenantId}`;
    if (facility?.status !== "active") throw new ValidationError("This facility is not active and cannot onboard staff");
    const scope = await checkedScope(tx, tenantId, manager, body.roles, body);
    const member = await tx`
      select m.roles from memberships m join users u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.status = 'active' and lower(u.email) = ${body.email}`;
    if (member[0] && body.roles.every((role) => (member[0]!.roles as string[]).includes(role))) {
      throw new ConflictError("This person is already an active member with these roles");
    }
    const superseded = await tx`
      update invitations set revoked_at = now(), revoked_by = ${auth.user.id}
       where tenant_id = ${tenantId} and lower(email) = ${body.email}
         and accepted_at is null and revoked_at is null and declined_at is null
       returning id`;
    await tx`
      insert into invitations (id, tenant_id, email, roles, token_hash, invited_by, expires_at, scope_department_id, scope_unit_id)
      values (${id}, ${tenantId}, ${body.email}, ${body.roles}, ${tokenHash}, ${auth.user.id}, ${expiresAt}, ${scope.departmentId}, ${scope.unitId})
    `;
    await writeAudit(tx, deps.config, {
      tenantId,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "membership.invite",
      resourceType: "Invitation",
      resourceId: id,
      ...auditMeta(c),
      metadata: { roles: body.roles, emailDomain: body.email.split("@")[1], supersedes: superseded.map((row) => row.id), scope },
    });
    return String(facility.name);
  });
  const delivery = await deps.email.send({ to: body.email, ...invitationEmail({ origin: deps.config.origin, facilityName, token, expiresAt }) });
  await withStaffActor(c, async (tx) => tx`update invitations set delivery_status = ${delivery.delivered ? "delivered" : "failed"} where id = ${id}`);
  return c.json({ ok: true, invitationId: id, delivery: { delivered: delivery.delivered, detail: delivery.detail } }, 201);
});

adminRoutes.get("/invitations", async (c) => {
  const auth = c.get("auth")!;
  const manager = membershipManager(c);
  const departmentId = manager.kind === "department" ? manager.departmentId : null;
  const rows = await withStaffActor(c, async (tx) => tx`
    select i.id, i.email, i.roles, i.created_at, i.expires_at, i.accepted_at, i.revoked_at, i.declined_at, i.delivery_status,
           i.scope_department_id, i.scope_unit_id,
           inviter.display_name as invited_by_name, accepter.display_name as accepted_by_name
      from invitations i
      join users inviter on inviter.id = i.invited_by
      left join users accepter on accepter.id = i.accepted_by
     where i.tenant_id = ${auth.activeTenant!.id}
       and (${departmentId}::uuid is null or i.scope_department_id = ${departmentId}::uuid)
     order by i.created_at desc
     limit 200
  `);
  return c.json({
    invitations: rows.map((row) => ({
      id: row.id,
      email: row.email,
      roles: row.roles,
      status: adminInvitationStatus({
        acceptedAt: row.acceptedAt as Date | null,
        revokedAt: row.revokedAt as Date | null,
        declinedAt: row.declinedAt as Date | null,
        expiresAt: row.expiresAt as Date,
      }),
      deliveryStatus: row.deliveryStatus,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      invitedByName: row.invitedByName,
      acceptedByName: row.acceptedByName,
      scopeDepartmentId: row.scopeDepartmentId,
      scopeUnitId: row.scopeUnitId,
    })),
  });
});

adminRoutes.post("/invitations/:id/revoke", async (c) => {
  const auth = c.get("auth")!;
  const manager = membershipManager(c);
  const departmentId = manager.kind === "department" ? manager.departmentId : null;
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const rows = await tx`
      update invitations set revoked_at = now(), revoked_by = ${auth.user.id}
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
         and accepted_at is null and revoked_at is null and declined_at is null
         and (${departmentId}::uuid is null or scope_department_id = ${departmentId}::uuid)
       returning id`;
    if (!rows[0]) throw new NotFoundError("No pending invitation with this id in your facility");
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "membership.invitation.revoke",
      resourceType: "Invitation",
      resourceId: id,
      ...auditMeta(c),
    });
  });
  return c.json({ ok: true });
});

adminRoutes.patch("/memberships/:id", async (c) => {
  const auth = c.get("auth")!;
  const manager = membershipManager(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, updateMembershipSchema);
  if (body.roles.length === 0) throw new ValidationError("At least one role is required");
  if (body.roles.includes("credential_reviewer")) throw new ValidationError("Credential reviewer is a platform role");
  const tenantId = auth.activeTenant!.id;
  const updated = await withStaffActor(c, async (tx) => {
    const [target] = await tx`
      select id, user_id, roles, scope_department_id from memberships where id = ${id} and tenant_id = ${tenantId} and status = 'active' for update`;
    if (!target) throw new NotFoundError("Membership not found");
    const before = target.roles as string[];
    if (manager.kind === "department") {
      if (target.scopeDepartmentId !== manager.departmentId) throw new ForbiddenError("This member is outside your department");
      const outside = before.filter((role) => !DEPARTMENT_DELEGABLE.has(role));
      if (outside.length) throw new ForbiddenError(`This member holds ${outside.join(", ")}, which only a facility administrator can change`);
    }
    if (before.includes("owner") && !body.roles.includes("owner")) {
      if (manager.kind !== "facility" || !manager.owner) throw new ForbiddenError("Only an owner can remove ownership");
      if (await ownerCount(tx, tenantId) <= 1) throw new ValidationError("The workspace must keep at least one owner");
    }
    const roles: Role[] = body.roles.includes("owner") && !body.roles.includes("facility_admin") ? [...body.roles, "facility_admin"] : body.roles;
    const scope = await checkedScope(tx, tenantId, manager, roles, body);
    const rows = await tx`
      update memberships set roles = ${roles}, scope_department_id = ${scope.departmentId}, scope_unit_id = ${scope.unitId}, updated_at = now()
       where id = ${id} returning id, user_id, roles`;
    await tx`update sessions set revoked_at = now(), revoked_reason = 'role-change' where user_id = ${rows[0]!.userId} and active_tenant_id = ${tenantId} and revoked_at is null`;
    await writeAudit(tx, c.get("deps").config, {
      tenantId,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "membership.roles.change",
      resourceType: "Membership",
      resourceId: id,
      ...auditMeta(c),
      metadata: { roles, previousRoles: before, scope },
    });
    return rows[0];
  });
  return c.json({ ok: true, membership: updated });
});

adminRoutes.delete("/memberships/:id", async (c) => {
  const auth = c.get("auth")!;
  const manager = membershipManager(c);
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const target = await tx`
      select m.id, m.user_id, m.roles, m.scope_department_id from memberships m
       where m.id = ${id} and m.tenant_id = ${auth.activeTenant!.id} and m.status = 'active'
    `;
    if (!target[0]) throw new NotFoundError("Membership not found");
    if (String(target[0].userId) === auth.user.id) throw new ValidationError("You cannot remove your own active membership");
    const roles = target[0].roles as string[];
    if (manager.kind === "department" && (target[0].scopeDepartmentId !== manager.departmentId || roles.some((role) => !DEPARTMENT_DELEGABLE.has(role)))) {
      throw new ForbiddenError("Only a facility administrator can remove this member");
    }
    if (roles.includes("owner")) {
      if (manager.kind !== "facility" || !manager.owner) throw new ForbiddenError("Only an owner can remove another owner");
      if (await ownerCount(tx, auth.activeTenant!.id) <= 1) throw new ValidationError("The workspace must keep at least one owner");
    }
    if (roles.includes("facility_admin")) {
      const admins = await tx`select count(*)::int as count from memberships where tenant_id = ${auth.activeTenant!.id} and status = 'active' and 'facility_admin' = any(roles)`;
      if (Number(admins[0]?.count ?? 0) <= 1) throw new ValidationError("The facility must retain at least one active administrator");
    }
    await tx`update memberships set status = 'removed', updated_at = now() where id = ${id}`;
    await tx`update sessions set revoked_at = now(), revoked_reason = 'membership-removed' where user_id = ${target[0].userId} and active_tenant_id = ${auth.activeTenant!.id} and revoked_at is null`;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "membership.remove",
      resourceType: "Membership",
      resourceId: id,
      ...auditMeta(c),
      metadata: { removedUserId: target[0].userId },
    });
  });
  return c.json({ ok: true });
});

adminRoutes.get("/facility", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
  const rows = await withStaffActor(c, async (tx) => tx`
    select id, name, slug, facility_type, city, country, email, phone, status, created_at
      from tenants where id = ${auth.activeTenant!.id}
  `);
  return c.json({ facility: rows[0] });
});

adminRoutes.get("/duplicate-candidates", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
  const rows = await withStaffActor(c, async (tx) => tx`
    select d.id, d.reason, d.status, d.created_at, d.primary_patient_id, d.candidate_patient_id,
           p.public_id as primary_public_id, p.given_name as primary_given_name, p.family_name as primary_family_name,
           c.public_id as candidate_public_id, c.given_name as candidate_given_name, c.family_name as candidate_family_name
      from patient_duplicate_candidates d
      join patients p on p.id = d.primary_patient_id
      join patients c on c.id = d.candidate_patient_id
     where d.tenant_id = ${auth.activeTenant!.id} and d.status = 'pending'
     order by d.created_at
  `);
  return c.json({ candidates: rows, automaticMerge: false });
});

adminRoutes.post("/duplicate-candidates/:id/review", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await c.req.json<{ status?: string; note?: string }>();
  if (body.status !== "reviewed-no-merge" && body.status !== "linked") throw new ValidationError("Invalid review status");
  if (!body.note || body.note.trim().length < 5) throw new ValidationError("A review note is required");
  const status = body.status;
  const note = body.note.trim();
  await withStaffActor(c, async (tx) => {
    const rows = await tx`
      update patient_duplicate_candidates
         set status = ${status}, reviewed_by = ${auth.user.id}, reviewed_at = now(), review_note = ${note}
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and status = 'pending' returning id
    `;
    if (!rows[0]) throw new NotFoundError("Candidate not found");
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "patient.duplicate.review",
      resourceType: "PatientDuplicateCandidate",
      resourceId: id,
      ...auditMeta(c),
      metadata: { status: body.status },
    });
  });
  return c.json({ ok: true, automaticMerge: false });
});

adminRoutes.get("/integrations", async (c) => {
  // Platform operators monitor adapter state without needing a facility membership.
  if (!isPlatformOperator(c)) assertMembershipAdmin(actor(c));
  const config = c.get("deps").config;
  return c.json({
    integrations: listIntegrations(config, await loadVerifications(c.get("deps").sql, config)).map((integration) => ({ ...integration, enabled: integration.state === "available" })),
    terminology: {
      mode: config.terminologyMode,
      label: config.terminologyMode === "synthetic"
        ? "Synthetic development terminology (not for production coding)"
        : config.terminologyMode === "unavailable" ? UNAVAILABLE_LABEL : "Production terminology adapter",
    },
  });
});

/**
 * Conformance run against the configured PACS, from this runtime. The stored outcome is what makes
 * DICOMweb available; a failed run makes it unavailable until a later run passes.
 */
adminRoutes.post("/integrations/dicomweb/verify", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const deps = c.get("deps");
  const body = await parseJson(c, dicomwebVerifySchema);
  const auth = c.get("auth")!;
  const startedAt = new Date();
  const run = await runDicomwebVerification(deps.config, dicomwebClientFor(deps.config, deps.dicomweb), body.sampleStudyInstanceUid);
  const id = await withPlatformActor(c, async (tx) => {
    const recordId = await recordVerification(tx, deps.config, "dicomweb", run, auth.user.id, startedAt);
    await writeAudit(tx, deps.config, {
      tenantId: null,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: [],
      action: "integration.verify",
      resourceType: "IntegrationVerification",
      resourceId: recordId,
      ...auditMeta(c),
      metadata: { integration: "dicomweb", outcome: run.outcome, failedCheck: run.checks.find((check) => !check.passed)?.name ?? null },
    });
    return recordId;
  });
  const status = integrationStatus(deps.config, "dicomweb", (await loadVerifications(deps.sql, deps.config)).dicomweb);
  return c.json({ id, outcome: run.outcome, checks: run.checks, status });
});
