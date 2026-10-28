import { Hono } from "hono";
import { switchTenantSchema, uuidSchema } from "@medveris/contracts";
import { withContext } from "@medveris/db";
import { withActor, requireAuth, requirePatient } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { NotFoundError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/me", async (c) => {
  const auth = requireAuth(c);
  return c.json({
    user: {
      id: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      givenName: auth.user.givenName,
      familyName: auth.user.familyName,
      emailVerified: Boolean(auth.user.emailVerifiedAt),
      mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
      mfaVerified: auth.mfaVerified,
    },
    memberships: auth.memberships.map((m) => ({ id: m.id, tenantId: m.tenantId, tenantName: m.tenantName, tenantSlug: m.tenantSlug, roles: m.roles })),
    activeTenant: auth.activeTenant,
    patientId: auth.patientId,
    platformRoles: auth.platformRoles,
    csrfToken: auth.session.csrfToken,
  });
});

/**
 * Facility staff assignments for staff sign-in. `facilities` holds only active assignments at active
 * facilities (the same set /me/context accepts); `inactive` explains assignments that no longer grant access.
 */
meRoutes.get("/me/facilities", async (c) => {
  const auth = requireAuth(c);
  const inactive = await withContext(c.get("deps").sql, { userId: auth.user.id, actorKind: "staff" }, async (tx) => tx`
    select t.name, m.status as membership_status, t.status as facility_status
      from memberships m join tenants t on t.id = m.tenant_id
     where m.user_id = ${auth.user.id} and (m.status <> 'active' or t.status <> 'active')
     order by t.name`);
  return c.json({
    facilities: auth.memberships.map((m) => ({ tenantId: m.tenantId, name: m.tenantName, roles: m.roles, membershipId: m.id })),
    inactive: inactive.map((row) => ({
      name: row.name,
      reason: row.membershipStatus !== "active" ? String(row.membershipStatus) : "facility_unavailable",
    })),
    activeTenantId: auth.activeTenant?.id ?? null,
    mfa: { enrolled: Boolean(auth.user.mfaEnrolledAt), verified: auth.mfaVerified },
  });
});

meRoutes.post("/me/context", async (c) => {
  const auth = requireAuth(c);
  const body = await parseJson(c, switchTenantSchema);
  const membership = auth.memberships.find((m) => m.tenantId === body.tenantId);
  if (!membership) throw new NotFoundError("Facility membership not found");
  await c.get("deps").sql`update sessions set active_tenant_id = ${body.tenantId}, last_seen_at = now() where id = ${auth.session.id}`;
  await withActor(c, async (tx) => {
    await writeAudit(tx, c.get("deps").config, {
      tenantId: body.tenantId,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: membership.roles,
      action: "session.context.switch",
      ...auditMeta(c),
      metadata: { fromTenantId: auth.activeTenant?.id ?? null, toTenantId: body.tenantId },
    });
  });
  return c.json({ ok: true, activeTenant: { id: membership.tenantId, name: membership.tenantName, roles: membership.roles } });
});

meRoutes.get("/me/sessions", async (c) => {
  const auth = requireAuth(c);
  const rows = await c.get("deps").sql`
    select id, active_tenant_id, created_at, last_seen_at, expires_at, revoked_at, revoked_reason, user_agent
      from sessions where user_id = ${auth.user.id} order by created_at desc limit 50
  `;
  return c.json({ sessions: rows.map((r) => ({ ...r, current: r.id === auth.session.id })) });
});

meRoutes.delete("/me/sessions/:id", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const rows = await c.get("deps").sql`
    update sessions set revoked_at = now(), revoked_reason = 'user-revoked'
     where id = ${id} and user_id = ${auth.user.id} and revoked_at is null returning id
  `;
  if (!rows[0]) throw new NotFoundError("Session not found");
  return c.json({ ok: true });
});

meRoutes.get("/me/patient", async (c) => {
  const auth = requirePatient(c);
  const rows = await withActor(c, async (tx) => tx`
    select p.id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, p.email, p.phone,
           p.identity_confidence, p.created_at
      from patients p where p.id = ${auth.patientId}
  `);
  const links = await withActor(c, async (tx) => tx`
    select l.tenant_id, t.name as tenant_name, l.release_signed_records
      from tenant_patient_links l join tenants t on t.id = l.tenant_id
     where l.patient_id = ${auth.patientId}
  `);
  if (!rows[0]) throw new NotFoundError("Patient profile not found");
  return c.json({ patient: rows[0], facilityLinks: links });
});

meRoutes.get("/me/records", async (c) => {
  const auth = requirePatient(c);
  const deps = c.get("deps");
  const data = await withActor(c, async (tx) => {
    await writeAudit(tx, deps.config, {
      actorKind: "patient",
      actorUserId: auth.user.id,
      subjectPatientId: auth.patientId,
      action: "patient.records.read",
      resourceType: "PatientRecordSet",
      resourceId: auth.patientId,
      ...auditMeta(c),
    });
    const notes = await tx`
      select v.id, v.entry_id, v.version, v.status, v.title, v.content, v.occurred_at, v.recorded_at, v.signed_at,
             v.author_id, u.display_name as author_name, v.tenant_id, t.name as source_facility
        from clinical_entry_versions v
        join clinical_entries ce on ce.id = v.entry_id and ce.current_version = v.version
        join tenant_patient_links l on l.tenant_id = v.tenant_id and l.patient_id = v.patient_id
        join tenants t on t.id = v.tenant_id
        join users u on u.id = v.author_id
       where v.patient_id = ${auth.patientId} and v.status in ('signed','amended','entered-in-error')
         and l.release_signed_records = true
       order by v.occurred_at desc limit 100
    `;
    const observations = await tx`
      select o.id, o.display, o.value_num, o.unit_code, o.occurred_at, o.status, t.name as source_facility, o.tenant_id
        from observations o join tenant_patient_links l on l.tenant_id = o.tenant_id and l.patient_id = o.patient_id
        join tenants t on t.id = o.tenant_id
       where o.patient_id = ${auth.patientId} and l.release_signed_records = true
       order by o.occurred_at desc limit 100
    `;
    const conditions = await tx`
      select c.id, c.display, c.clinical_status, c.recorded_at, t.name as source_facility
        from conditions c join tenant_patient_links l on l.tenant_id = c.tenant_id and l.patient_id = c.patient_id
        join tenants t on t.id = c.tenant_id
       where c.patient_id = ${auth.patientId} and l.release_signed_records = true
       order by c.recorded_at desc limit 100
    `;
    const allergies = await tx`
      select a.id, a.state, a.substance_coding, a.reaction_coding, a.severity, a.recorded_at, t.name as source_facility
        from allergies a join tenant_patient_links l on l.tenant_id = a.tenant_id and l.patient_id = a.patient_id
        join tenants t on t.id = a.tenant_id
       where a.patient_id = ${auth.patientId} and l.release_signed_records = true
       order by a.recorded_at desc limit 20
    `;
    const followUps = await tx`
      select f.id, f.due_date, f.instructions, f.status, t.name as source_facility
        from follow_ups f join tenant_patient_links l on l.tenant_id = f.tenant_id and l.patient_id = f.patient_id
        join tenants t on t.id = f.tenant_id
       where f.patient_id = ${auth.patientId} and l.release_signed_records = true order by f.due_date desc limit 20
    `;
    return { notes, observations, conditions, allergies, followUps };
  });
  return c.json(data);
});

meRoutes.get("/me/appointments", async (c) => {
  const auth = requirePatient(c);
  const rows = await withActor(c, async (tx) => tx`
    select a.id, a.start_at, a.duration_minutes, a.reason, a.status, a.tenant_id, t.name as facility_name
      from appointments a join tenants t on t.id = a.tenant_id
     where a.patient_id = ${auth.patientId} order by a.start_at desc limit 50
  `);
  return c.json({ appointments: rows });
});

meRoutes.get("/me/consents", async (c) => {
  const auth = requirePatient(c);
  const rows = await withActor(c, async (tx) => tx`
    select g.id, g.recipient_tenant_id, rt.name as recipient_facility, g.source_tenant_ids,
           g.categories, g.purpose, g.legal_basis, g.policy_version, g.sensitivity_exclusions,
           g.starts_at, g.expires_at, g.version, g.revoked_at, g.revoked_reason, g.created_at,
           (select array_agg(t.name) from tenants t where t.id = any(g.source_tenant_ids)) as source_facilities
      from exchange_grants g join tenants rt on rt.id = g.recipient_tenant_id
     where g.patient_id = ${auth.patientId} order by g.created_at desc
  `);
  return c.json({ consents: rows });
});

meRoutes.get("/me/access-history", async (c) => {
  const auth = requirePatient(c);
  const rows = await withActor(c, async (tx) => tx`
    select id, action, actor_kind, decision, resource_type, occurred_at, metadata
      from audit_events where subject_patient_id = ${auth.patientId}
     order by occurred_at desc limit 100
  `);
  return c.json({
    events: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorKind: r.actorKind,
      decision: r.decision,
      resourceType: r.resourceType,
      occurredAt: r.occurredAt,
      summary: summarizeAudit(String(r.action)),
    })),
  });
});

function summarizeAudit(action: string): string {
  if (action.startsWith("patient.records")) return "You viewed your released records";
  if (action.startsWith("exchange")) return "A participating facility accessed records under your authorization";
  if (action.startsWith("emergency")) return "Emergency access was used";
  if (action.startsWith("consent")) return "Consent scope changed";
  if (action.startsWith("clinical")) return "Clinical record activity";
  return "Account or record activity";
}
