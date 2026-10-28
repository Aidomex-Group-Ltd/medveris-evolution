import { Hono } from "hono";
import { randomToken, sha256Hex } from "@medveris/auth";
import { createInvitationSchema, uuidSchema } from "@medveris/contracts";
import { assertMembershipAdmin, type ActorContext } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { adminInvitationStatus, assertInvitable, INVITATION_TTL_MS, invitationEmail } from "../services/invitations.js";
import { listIntegrations } from "../integrations/registry.js";
import { UNAVAILABLE_LABEL } from "../terminology/unavailable.js";
import type { AppEnv } from "../types.js";

export const adminRoutes = new Hono<AppEnv>();

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
  assertMembershipAdmin(actor(c));
  const rows = await withStaffActor(c, async (tx) => tx`
    select m.id, m.roles, m.status, m.created_at, u.id as user_id, u.display_name, u.email, u.email_verified_at, u.mfa_enrolled_at
      from memberships m join users u on u.id = m.user_id
     where m.tenant_id = ${auth.activeTenant!.id}
     order by m.created_at
  `);
  return c.json({ memberships: rows });
});

adminRoutes.post("/invitations", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
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
      insert into invitations (id, tenant_id, email, roles, token_hash, invited_by, expires_at)
      values (${id}, ${tenantId}, ${body.email}, ${body.roles}, ${tokenHash}, ${auth.user.id}, ${expiresAt})
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
      metadata: { roles: body.roles, emailDomain: body.email.split("@")[1], supersedes: superseded.map((row) => row.id) },
    });
    return String(facility.name);
  });
  const delivery = await deps.email.send({ to: body.email, ...invitationEmail({ origin: deps.config.origin, facilityName, token, expiresAt }) });
  await withStaffActor(c, async (tx) => tx`update invitations set delivery_status = ${delivery.delivered ? "delivered" : "failed"} where id = ${id}`);
  return c.json({ ok: true, invitationId: id, delivery: { delivered: delivery.delivered, detail: delivery.detail } }, 201);
});

adminRoutes.get("/invitations", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
  const rows = await withStaffActor(c, async (tx) => tx`
    select i.id, i.email, i.roles, i.created_at, i.expires_at, i.accepted_at, i.revoked_at, i.declined_at, i.delivery_status,
           inviter.display_name as invited_by_name, accepter.display_name as accepted_by_name
      from invitations i
      join users inviter on inviter.id = i.invited_by
      left join users accepter on accepter.id = i.accepted_by
     where i.tenant_id = ${auth.activeTenant!.id}
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
    })),
  });
});

adminRoutes.post("/invitations/:id/revoke", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const rows = await tx`
      update invitations set revoked_at = now(), revoked_by = ${auth.user.id}
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
         and accepted_at is null and revoked_at is null and declined_at is null
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
  assertMembershipAdmin(actor(c));
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, createInvitationSchema.pick({ roles: true }));
  if (body.roles.length === 0) throw new ValidationError("At least one role is required");
  if (body.roles.includes("credential_reviewer")) throw new ValidationError("Credential reviewer is a platform role");
  const updated = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      update memberships set roles = ${body.roles}, updated_at = now()
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and status = 'active'
       returning id, user_id, roles
    `;
    if (!rows[0]) throw new NotFoundError("Membership not found");
    await tx`update sessions set revoked_at = now(), revoked_reason = 'role-change' where user_id = ${rows[0].userId} and active_tenant_id = ${auth.activeTenant!.id} and revoked_at is null`;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "membership.roles.change",
      resourceType: "Membership",
      resourceId: id,
      ...auditMeta(c),
      metadata: { roles: body.roles },
    });
    return rows[0];
  });
  return c.json({ ok: true, membership: updated });
});

adminRoutes.delete("/memberships/:id", async (c) => {
  const auth = c.get("auth")!;
  assertMembershipAdmin(actor(c));
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const target = await tx`
      select m.id, m.user_id, m.roles from memberships m
       where m.id = ${id} and m.tenant_id = ${auth.activeTenant!.id} and m.status = 'active'
    `;
    if (!target[0]) throw new NotFoundError("Membership not found");
    if (String(target[0].userId) === auth.user.id) throw new ValidationError("You cannot remove your own active membership");
    if ((target[0].roles as string[]).includes("facility_admin")) {
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
  assertMembershipAdmin(actor(c));
  const config = c.get("deps").config;
  return c.json({
    integrations: listIntegrations(config).map((integration) => ({ ...integration, enabled: integration.state === "available" })),
    terminology: {
      mode: config.terminologyMode,
      label: config.terminologyMode === "synthetic"
        ? "Synthetic development terminology (not for production coding)"
        : config.terminologyMode === "unavailable" ? UNAVAILABLE_LABEL : "Production terminology adapter",
    },
  });
});
