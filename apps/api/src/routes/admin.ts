import { Hono } from "hono";
import { randomToken, sha256Hex } from "@medveris/auth";
import { createInvitationSchema, uuidSchema } from "@medveris/contracts";
import { assertMembershipAdmin, type ActorContext } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { sendInvitation } from "./auth.js";
import { listIntegrations } from "../integrations/registry.js";
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
  const body = await parseJson(c, createInvitationSchema);
  if (body.roles.includes("credential_reviewer") && !auth.platformRoles.includes("credential_reviewer")) {
    throw new ValidationError("Credential reviewer is a platform role and cannot be assigned by a facility administrator");
  }
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into invitations (id, tenant_id, email, roles, token_hash, invited_by, expires_at)
      values (${id}, ${auth.activeTenant!.id}, ${body.email}, ${body.roles}, ${tokenHash}, ${auth.user.id},
        ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)})
    `;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "membership.invite",
      resourceType: "Invitation",
      resourceId: id,
      ...auditMeta(c),
      metadata: { roles: body.roles, emailDomain: body.email.split("@")[1] },
    });
  });
  const delivery = await sendInvitation(c, {
    tenantId: auth.activeTenant!.id,
    email: body.email,
    roles: body.roles,
    invitedBy: auth.user.id,
    token,
    tokenId: id,
  });
  return c.json({ ok: true, invitationId: id, delivery: { delivered: delivery.delivered, detail: delivery.detail } }, 201);
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
      label: config.terminologyMode === "synthetic" ? "Synthetic development terminology (not for production coding)" : "Production terminology adapter",
    },
  });
});
