import { Hono } from "hono";
import {
  telehealthCompleteSchema,
  telehealthConsentSchema,
  telehealthSessionSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertWardAccess } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, DependencyError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const telehealthRoutes = new Hono<AppEnv>();

telehealthRoutes.get("/telehealth/sessions", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select s.*, p.public_id, p.given_name, p.family_name, u.display_name as clinician_name,
           (select tc.consent from telehealth_consents tc where tc.session_id = s.id order by tc.created_at desc limit 1) as latest_consent
      from telehealth_sessions s join patients p on p.id = s.patient_id join users u on u.id = s.clinician_user_id
     where s.tenant_id = ${auth.activeTenant!.id} order by s.scheduled_at desc limit 200
  `);
  return c.json({ sessions: rows });
});

telehealthRoutes.post("/telehealth/sessions", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, telehealthSessionSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const linked = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}`;
    if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
    const clinician = await tx`
      select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.clinicianUserId}
         and status = 'active' and roles && ARRAY['clinician','nurse']
    `;
    if (!clinician[0]) throw new ValidationError("The selected clinician is not an active clinical member");
    if (body.appointmentId) {
      const appointment = await tx`
        select 1 from appointments where id = ${body.appointmentId} and patient_id = ${body.patientId} and tenant_id = ${auth.activeTenant!.id}
      `;
      if (!appointment[0]) throw new ValidationError("The appointment does not belong to this patient");
    }
    await tx`
      insert into telehealth_sessions (id, tenant_id, appointment_id, patient_id, clinician_user_id, scheduled_at, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.appointmentId ?? null}, ${body.patientId}, ${body.clinicianUserId},
        ${new Date(body.scheduledAt)}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "telehealth.session.create", {
      subjectPatientId: body.patientId, resourceType: "TelehealthSession", resourceId: id,
      metadata: { clinicianUserId: body.clinicianUserId, adapterConfigured: c.get("deps").config.features.telemedicine },
    }));
  });
  return c.json({ ok: true, session: { id } }, 201);
});

telehealthRoutes.get("/telehealth/sessions/:id", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const session = await requireRows(await tx`
      select s.*, p.public_id, p.given_name, p.family_name, u.display_name as clinician_name
        from telehealth_sessions s join patients p on p.id = s.patient_id join users u on u.id = s.clinician_user_id
       where s.id = ${id} and s.tenant_id = ${auth.activeTenant!.id}
    `, "Telehealth session not found");
    const consents = await tx`select * from telehealth_consents where session_id = ${id} order by created_at desc`;
    return { session, consents, adapter: { configured: c.get("deps").config.features.telemedicine, provider: null } };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "telehealth.session.read", {
    subjectPatientId: String(data.session.patientId), resourceType: "TelehealthSession", resourceId: id,
  })));
  return c.json(data);
});

telehealthRoutes.post("/telehealth/sessions/:id/consent", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, telehealthConsentSchema);
  await withStaffActor(c, async (tx) => {
    const session = await requireRows(await tx`
      select id, patient_id, status from telehealth_sessions where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Telehealth session not found");
    if (!["scheduled", "consented"].includes(String(session.status))) throw new ConflictError("Consent is closed for this session");
    if (!body.consent) throw new ValidationError("Telehealth cannot proceed without patient consent");
    await tx`
      insert into telehealth_consents (id, tenant_id, session_id, consent, notes, recorded_by)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.consent}, ${body.notes || null}, ${auth.user.id})
    `;
    await tx`update telehealth_sessions set status = 'consented', version = version + 1 where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "telehealth.consent.record", {
      subjectPatientId: String(session.patientId), resourceType: "TelehealthSession", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

telehealthRoutes.post("/telehealth/sessions/:id/join", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  if (!c.get("deps").config.features.telemedicine) {
    throw new DependencyError("The telemedicine media adapter is not configured; session records remain available without a media link");
  }
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const session = await requireRows(await tx`
      select id, patient_id, status, started_at from telehealth_sessions where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Telehealth session not found");
    if (session.status !== "consented") throw new ConflictError("Patient consent is required before joining");
    await tx`update telehealth_sessions set status = 'in-progress', version = version + 1, started_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "telehealth.session.join", {
      subjectPatientId: String(session.patientId), resourceType: "TelehealthSession", resourceId: id,
    }));
  });
  return c.json({ ok: true, media: { configured: true } });
});

telehealthRoutes.post("/telehealth/sessions/:id/complete", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, telehealthCompleteSchema);
  await withStaffActor(c, async (tx) => {
    const session = await requireRows(await tx`
      select id, patient_id, status from telehealth_sessions where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Telehealth session not found");
    if (!["in-progress", "consented"].includes(String(session.status))) throw new ConflictError("Only open sessions can be completed");
    if (session.status === "consented" && body.connectionStatus === "completed") {
      throw new ConflictError("A session that never joined cannot be marked completed");
    }
    await tx`
      update telehealth_sessions set status = ${body.connectionStatus}, version = version + 1,
        connection_status = ${body.connectionStatus}, notes = ${body.notes || null}, ended_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `telehealth.session.${body.connectionStatus}`, {
      subjectPatientId: String(session.patientId), resourceType: "TelehealthSession", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

telehealthRoutes.get("/telehealth/sessions/:id/participants", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const row = await withStaffActor(c, async (tx) => tx`
    select s.id, s.clinician_user_id, u.display_name as clinician_name, s.patient_id, p.public_id
      from telehealth_sessions s join users u on u.id = s.clinician_user_id join patients p on p.id = s.patient_id
     where s.id = ${id} and s.tenant_id = ${auth.activeTenant!.id}
  `);
  if (!row[0]) throw new NotFoundError("Telehealth session not found");
  return c.json({ participants: [
    { role: "clinician", userId: row[0].clinicianUserId, name: row[0].clinicianName },
    { role: "patient", publicId: row[0].publicId },
  ] });
});
