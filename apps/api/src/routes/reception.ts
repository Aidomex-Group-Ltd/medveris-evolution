import { Hono } from "hono";
import {
  appointmentRescheduleSchema,
  appointmentSchema,
  appointmentStatusSchema,
  createEncounterSchema,
  createPatientByStaffSchema,
  enrollPatientSchema,
  patientSearchSchema,
  queueEntrySchema,
  resolvePatientSchema,
  triageSchema,
  transitionEncounterSchema,
  uuidSchema,
} from "@medveris/contracts";
import type { ActorContext } from "@medveris/authz";
import { sha256Hex } from "@medveris/auth";
import type { Tx } from "@medveris/db";
import { canTransitionAppointment, canTransitionEncounter, localMedicalRecordNumber, randomPatientPublicId, type AppointmentStatus, type EncounterState } from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, ensureMatch, parseJson, parseQuery, requestMeta } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { idempotencyKey, uniqueViolation } from "../lib/idempotency.js";
import { resolveAttribution } from "../lib/scope.js";
import { insertAllergy, insertObservation, validateClinicalCoding } from "../services/clinical.js";
import type { AppEnv } from "../types.js";

export const receptionRoutes = new Hono<AppEnv>();

const FRONT_DESK_ROLES = ["receptionist", "nurse", "clinician", "facility_admin"];

function actor(c: Parameters<typeof requireStaff>[0]): ActorContext {
  const auth = c.get("auth")!;
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

function requireFrontDesk(c: Parameters<typeof requireStaff>[0]): void {
  const a = actor(c);
  if (!FRONT_DESK_ROLES.some((r) => a.roles.includes(r as never))) throw new ForbiddenError("Front-desk access is required");
}

receptionRoutes.post("/reception/patients", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const body = await parseJson(c, createPatientByStaffSchema);
  const meta = requestMeta(c);
  const result = await withStaffActor(c, async (tx) => {
    // A client retry (network flap, double submit, replayed form) must not create a second patient.
    const idemKey = idempotencyKey(c);
    if (idemKey) {
      await tx`select pg_advisory_xact_lock(hashtext(${`reception/register:${auth.user.id}:${idemKey}`}))`;
      const [saved] = await tx`
        select response_body from idempotency_keys
         where actor_id = ${auth.user.id} and key = ${idemKey} and route = '/reception/patients'
           and response_body is not null and expires_at > now()
      `;
      if (saved) return { payload: saved.responseBody as { patientId: string; publicId: string; duplicateReviewQueued: number }, replayed: true };
    }
    let publicId = randomPatientPublicId();
    for (let i = 0; i < 5; i++) {
      const clash = await tx`select 1 from patients where public_id = ${publicId}`;
      if (!clash.length) break;
      publicId = randomPatientPublicId();
    }
    const patientId = crypto.randomUUID();
    await tx`
      insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, email, phone,
        identity_confidence, identity_evidence, created_via, created_tenant_id)
      values (${patientId}, ${publicId}, ${body.givenName}, ${body.familyName}, ${body.dateOfBirth}, ${body.sex},
        ${body.email || null}, ${body.phone || null}, ${body.identityConfidence},
        ${body.assistedWithoutContactDetails ? "assisted registration without contact details" : "staff-assisted registration"},
        'assisted-registration', ${auth.activeTenant!.id})
    `;
    await tx`
      insert into tenant_patient_links (id, tenant_id, patient_id, local_mrn)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${patientId},
        ${localMedicalRecordNumber(auth.activeTenant!.slug, publicId)})
    `;
    const possible = await tx`
      select p.id, p.public_id from patients p
        join tenant_patient_links l on l.patient_id = p.id and l.tenant_id = ${auth.activeTenant!.id}
       where lower(p.family_name) = lower(${body.familyName}) and p.date_of_birth = ${body.dateOfBirth}
         and p.id <> ${patientId} and p.merged_into is null
       limit 5
    `;
    for (const candidate of possible) {
      await tx`
        insert into patient_duplicate_candidates (id, tenant_id, primary_patient_id, candidate_patient_id, reason)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${candidate.id}, ${patientId},
          'Exact family name and date of birth in this facility; review required')
      `;
    }
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "patient.assisted-register",
      subjectPatientId: patientId,
      resourceType: "Patient",
      resourceId: patientId,
      ...meta,
      metadata: { publicId, duplicateCandidates: possible.length },
    });
    const payload = { patientId, publicId, duplicateReviewQueued: possible.length };
    if (idemKey) {
      await tx`
        insert into idempotency_keys (id, key, actor_id, tenant_id, route, request_digest, response_status, response_body, expires_at)
        values (${crypto.randomUUID()}, ${idemKey}, ${auth.user.id}, ${auth.activeTenant!.id}, '/reception/patients',
          ${await sha256Hex(JSON.stringify(body))}, 201,
          ${tx.json(payload as never)}, now() + interval '24 hours')
        on conflict (actor_id, key) do nothing
      `;
    }
    return { payload, replayed: false };
  });
  return c.json({ ok: true, patient: result.payload }, 201);
});

receptionRoutes.post("/patients/enroll", async (c) => {
  // Enrol a globally registered patient (found via exact-ID resolve) at this facility, without creating a new identity.
  requireStaff(c);
  requireFrontDesk(c);
  await enforceRateLimit(c, "patient.resolve", c.get("auth")!.user.id);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const meta = requestMeta(c);
  const body = await parseJson(c, enrollPatientSchema);
  const result = await withStaffActor(c, async (tx) => {
    const [confirmed] = await tx`
      select p.id, p.public_id, p.merged_into from patients p
       where p.public_id = ${body.publicId} and lower(p.family_name) = lower(${body.familyName}) and p.date_of_birth = ${body.dateOfBirth}
       limit 1
    `;
    if (!confirmed) {
      await writeAudit(tx, deps.config, {
        tenantId: auth.activeTenant!.id,
        actorKind: "staff",
        actorUserId: auth.user.id,
        actorRoles: auth.activeTenant!.roles,
        action: "patient.enroll",
        subjectPatientId: null,
        resourceType: "Patient",
        resourceId: null,
        decision: "deny",
        reasonCode: "no-patient-matched",
        ...meta,
      });
      throw new NotFoundError("No patient matched the supplied ID, family name and date of birth");
    }
    const targetId = String(confirmed.mergedInto ?? confirmed.id);
    const [survivor] = await tx`select id, public_id from patients where id = ${targetId} and merged_into is null`;
    if (!survivor) throw new NotFoundError("No patient matched the supplied ID, family name and date of birth");
    await tx`select pg_advisory_xact_lock(hashtext(${`patient:enroll:${auth.activeTenant!.id}:${targetId}`}))`;
    const [existing] = await tx`
      select id from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${targetId}
    `;
    if (!existing) {
      await tx`
        insert into tenant_patient_links (id, tenant_id, patient_id, local_mrn)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${targetId},
          ${localMedicalRecordNumber(auth.activeTenant!.slug, String(survivor.publicId))})
      `;
    }
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "patient.enroll",
      subjectPatientId: targetId,
      resourceType: "Patient",
      resourceId: targetId,
      ...meta,
      metadata: { publicId: String(survivor.publicId), alreadyLinked: Boolean(existing) },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "patient.enrolled",
      aggregateId: targetId,
      payload: { patientId: targetId, publicId: String(survivor.publicId), alreadyLinked: Boolean(existing) },
    });
    return { id: targetId, publicId: survivor.publicId, alreadyLinked: Boolean(existing) };
  });
  return c.json({ ok: true, patient: result, alreadyLinked: result.alreadyLinked }, result.alreadyLinked ? 200 : 201);
});

receptionRoutes.post("/patients/resolve", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  await enforceRateLimit(c, "patient.resolve", c.get("auth")!.user.id);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const meta = requestMeta(c);
  const body = await parseJson(c, resolvePatientSchema);
  const data = await withStaffActor(c, async (tx) => {
    // Identity is confirmed against the record the ID belongs to; a merged ID then resolves to its survivor.
    const [confirmed] = await tx`
      select p.id, p.public_id, p.merged_into from patients p
       where p.public_id = ${body.publicId} and lower(p.family_name) = lower(${body.familyName}) and p.date_of_birth = ${body.dateOfBirth}
       limit 1
    `;
    const targetId = confirmed ? String(confirmed.mergedInto ?? confirmed.id) : null;
    const rows = targetId ? await tx`
      select p.id, p.public_id, p.given_name, p.family_name, to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth, p.sex, p.identity_confidence,
             EXISTS (SELECT 1 FROM tenant_patient_links l WHERE l.tenant_id = ${auth.activeTenant!.id} AND l.patient_id = p.id) as linked
        from patients p where p.id = ${targetId} and p.merged_into is null
    ` : [];
    const patient: (Record<string, unknown> & { id: unknown }) | undefined = rows[0]
      ? { ...rows[0], id: rows[0].id, mergedFrom: confirmed?.mergedInto ? String(confirmed.publicId) : null }
      : undefined;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "patient.lookup",
      subjectPatientId: patient ? String(patient.id) : null,
      resourceType: "Patient",
      resourceId: patient ? String(patient.id) : null,
      decision: patient ? "allow" : "deny",
      reasonCode: patient ? "exact-id-and-identity-confirmed" : "not-found-or-confirmation-failed",
      ...meta,
      metadata: { exactPublicIdLookup: true },
    });
    return patient ?? null;
  });
  // A failed confirmation is an expected outcome of this check, so it is a 200 with matched=false.
  if (!data) {
    return c.json({ matched: false, patient: null, message: "No patient matched the supplied ID, family name and date of birth" });
  }
  return c.json({ matched: true, patient: data });
});

receptionRoutes.get("/patients/search", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  await enforceRateLimit(c, "patient.search", c.get("auth")!.user.id);
  const auth = c.get("auth")!;
  const query = parseQuery(c, patientSearchSchema);
  const term = `${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const result = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select p.id, p.public_id, p.given_name, p.family_name, to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth,
             p.sex, p.identity_confidence, l.local_mrn, true as linked
        from tenant_patient_links l join patients p on p.id = l.patient_id
       where l.tenant_id = ${auth.activeTenant!.id} and p.merged_into is null
         and (p.family_name ilike ${term} or p.given_name ilike ${term} or p.public_id ilike ${term} or l.local_mrn ilike ${term})
         and (${query.dateOfBirth ?? null}::date is null or p.date_of_birth = ${query.dateOfBirth ?? null}::date)
       order by lower(p.family_name), lower(p.given_name), p.public_id
       limit ${query.limit + 1} offset ${query.offset}
    `;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "patient.search",
      ...auditMeta(c),
      metadata: { scope: "facility-linked", results: Math.min(rows.length, query.limit), withDateOfBirth: Boolean(query.dateOfBirth) },
    });
    return rows;
  });
  return c.json({
    patients: result.slice(0, query.limit),
    hasMore: result.length > query.limit,
    limit: query.limit,
    offset: query.offset,
  });
});

receptionRoutes.get("/patients/recent", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select p.id, p.public_id, p.given_name, p.family_name, to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth, p.sex, l.created_at, l.release_signed_records
      from tenant_patient_links l join patients p on p.id = l.patient_id
     where l.tenant_id = ${auth.activeTenant!.id}
     order by l.created_at desc limit 25
  `);
  await withStaffActor(c, async (tx) => {
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "patient.list.recent",
      ...auditMeta(c),
    });
  });
  return c.json({ patients: rows });
});

async function ensureAssignedClinician(tx: Tx, tenantId: string, userId: string): Promise<void> {
  const member = await tx`
    select 1 from memberships
     where tenant_id = ${tenantId} and user_id = ${userId} and status = 'active'
       and roles && ARRAY['clinician','nurse']
  `;
  if (!member[0]) throw new ValidationError("Assigned clinician is not an active clinical member of this facility");
}

receptionRoutes.get("/appointments", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const status = c.req.query("status") ?? "all";
  const scope = c.req.query("scope") ?? "upcoming";
  if (!["all", "scheduled", "arrived", "completed", "cancelled", "no-show"].includes(status)) {
    throw new ValidationError("Invalid appointment status filter");
  }
  if (!["upcoming", "past", "all"].includes(scope)) throw new ValidationError("Invalid appointment scope");
  const rows = await withStaffActor(c, async (tx) => tx`
    select a.id, a.start_at, a.duration_minutes, a.reason, a.status, a.version, a.status_note, a.updated_at,
           a.patient_id, p.public_id, p.given_name, p.family_name,
           a.clinician_user_id, u.display_name as clinician_name
      from appointments a join patients p on p.id = a.patient_id
      left join users u on u.id = a.clinician_user_id
     where a.tenant_id = ${auth.activeTenant!.id}
       and (${status} = 'all' or a.status = ${status})
       and (${scope} = 'all'
         or (${scope} = 'upcoming' and a.start_at >= now() - interval '1 day')
         or (${scope} = 'past' and a.start_at < now() - interval '1 day'))
     order by a.start_at limit 200
  `);
  return c.json({ appointments: rows });
});

receptionRoutes.post("/appointments", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const body = await parseJson(c, appointmentSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const link = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}`;
    if (!link.length) throw new NotFoundError("Patient is not linked to this facility");
    if (body.clinicianUserId) await ensureAssignedClinician(tx, auth.activeTenant!.id, body.clinicianUserId);
    await tx`
      insert into appointments (id, tenant_id, patient_id, clinician_user_id, start_at, duration_minutes, reason, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.clinicianUserId ?? null}, ${body.startAt},
        ${body.durationMinutes}, ${body.reason}, ${auth.user.id})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "appointment.create",
      subjectPatientId: body.patientId,
      resourceType: "Appointment",
      resourceId: id,
      ...auditMeta(c),
    });
  });
  return c.json({ ok: true, appointmentId: id }, 201);
});

receptionRoutes.patch("/appointments/:id", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, appointmentRescheduleSchema);
  const result = await withStaffActor(c, async (tx) => {
    const current = await tx`
      select id, patient_id, status, version from appointments
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `;
    if (!current[0]) throw new NotFoundError("Appointment not found");
    if (current[0].status !== "scheduled") throw new ConflictError("Only a scheduled appointment can be rescheduled");
    ensureMatch(body.expectedVersion, Number(current[0].version));
    if (body.clinicianUserId) await ensureAssignedClinician(tx, auth.activeTenant!.id, body.clinicianUserId);
    const version = Number(current[0].version) + 1;
    await tx`
      update appointments
         set start_at = ${body.startAt}, duration_minutes = ${body.durationMinutes},
             clinician_user_id = ${body.clinicianUserId ?? null}, version = ${version},
             status_note = ${body.note}, updated_by = ${auth.user.id}, updated_at = now()
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "appointment.reschedule",
      subjectPatientId: String(current[0].patientId),
      resourceType: "Appointment",
      resourceId: id,
      ...auditMeta(c),
      metadata: { startAt: body.startAt, durationMinutes: body.durationMinutes, clinicianUserId: body.clinicianUserId ?? null, note: body.note },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "appointment.rescheduled",
      aggregateId: id,
      aggregateVersion: version,
      payload: { patientId: current[0].patientId, startAt: body.startAt },
    });
    return { id, version };
  });
  return c.json({ ok: true, appointment: result });
});

receptionRoutes.post("/appointments/:id/status", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, appointmentStatusSchema);
  const result = await withStaffActor(c, async (tx) => {
    const current = await tx`
      select id, patient_id, status, version from appointments
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `;
    if (!current[0]) throw new NotFoundError("Appointment not found");
    ensureMatch(body.expectedVersion, Number(current[0].version));
    const from = String(current[0].status) as AppointmentStatus;
    if (!canTransitionAppointment(from, body.status)) {
      throw new ConflictError(`Cannot move a ${from} appointment to ${body.status}`);
    }
    const version = Number(current[0].version) + 1;
    await tx`
      update appointments
         set status = ${body.status}, version = ${version}, status_note = ${body.note},
             updated_by = ${auth.user.id}, updated_at = now()
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `;
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "appointment.status-change",
      subjectPatientId: String(current[0].patientId),
      resourceType: "Appointment",
      resourceId: id,
      ...auditMeta(c),
      metadata: { from, to: body.status, note: body.note },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "appointment.status-changed",
      aggregateId: id,
      aggregateVersion: version,
      payload: { patientId: current[0].patientId, from, to: body.status },
    });
    return { id, status: body.status, version };
  });
  return c.json({ ok: true, appointment: result });
});

receptionRoutes.get("/queues", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select q.id, q.name, count(qe.id) filter (where qe.status not in ('completed','cancelled'))::int as waiting
      from queues q left join queue_entries qe on qe.queue_id = q.id and qe.tenant_id = q.tenant_id
     where q.tenant_id = ${auth.activeTenant!.id} group by q.id, q.name order by q.name
  `);
  return c.json({ queues: rows });
});

receptionRoutes.post("/queues", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? "Outpatient").trim();
  if (name.length < 2 || name.length > 80) throw new ValidationError("Queue name must be 2-80 characters");
  const id = await withStaffActor(c, async (tx) => {
    const existing = await tx`select id from queues where tenant_id = ${auth.activeTenant!.id} and name = ${name} limit 1`;
    if (existing[0]) return String(existing[0].id);
    const newId = crypto.randomUUID();
    await tx`insert into queues (id, tenant_id, name) values (${newId}, ${auth.activeTenant!.id}, ${name})`;
    return newId;
  });
  return c.json({ ok: true, queueId: id }, 201);
});

receptionRoutes.post("/queues/:queueId/entries", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const queueId = uuidSchema.parse(c.req.param("queueId"));
  const body = await parseJson(c, queueEntrySchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const queue = await tx`select id from queues where id = ${queueId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!queue.length) throw new NotFoundError("Queue not found");
    const link = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}`;
    if (!link.length) throw new NotFoundError("Patient is not linked to this facility");
    await tx`
      insert into queue_entries (id, tenant_id, queue_id, patient_id, appointment_id, priority)
      values (${id}, ${auth.activeTenant!.id}, ${queueId}, ${body.patientId}, ${body.appointmentId ?? null}, ${body.priority})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "queue.entry.create",
      subjectPatientId: body.patientId,
      resourceType: "QueueEntry",
      resourceId: id,
      ...auditMeta(c),
    });
  });
  return c.json({ ok: true, queueEntryId: id }, 201);
});

receptionRoutes.get("/queues/:queueId/entries", async (c) => {
  requireStaff(c);
  requireFrontDesk(c);
  const auth = c.get("auth")!;
  const queueId = uuidSchema.parse(c.req.param("queueId"));
  const rows = await withStaffActor(c, async (tx) => tx`
    select qe.id, qe.status, qe.priority, qe.created_at, qe.called_at, qe.encounter_id,
           p.id as patient_id, p.public_id, p.given_name, p.family_name, p.date_of_birth,
           e.state as encounter_state
      from queue_entries qe join patients p on p.id = qe.patient_id
      left join encounters e on e.id = qe.encounter_id
     where qe.tenant_id = ${auth.activeTenant!.id} and qe.queue_id = ${queueId} and qe.status not in ('completed','cancelled')
     order by case qe.priority when 'emergency' then 0 when 'urgent' then 1 else 2 end, qe.created_at
  `);
  return c.json({ entries: rows });
});

receptionRoutes.post("/encounters", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const body = await parseJson(c, createEncounterSchema);
  const key = idempotencyKey(c);
  const tenantId = auth.activeTenant!.id;
  const id = crypto.randomUUID();

  const replay = async () => {
    if (!key) return null;
    const [existing] = await withStaffActor(c, async (tx) => tx`
      select id, patient_id, type, reason from encounters where tenant_id = ${tenantId} and idempotency_key = ${key}
    `);
    if (!existing) return null;
    if (String(existing.patientId) !== body.patientId || existing.type !== body.type || existing.reason !== body.reason) {
      throw new ConflictError("This Idempotency-Key was already used for a different encounter request");
    }
    return c.json({ ok: true, encounterId: String(existing.id), replayed: true }, 200);
  };
  const openEncounter = async (tx: Tx): Promise<string | null> => {
    if (!body.appointmentId && !body.queueEntryId) return null;
    const [open] = await tx`
      select id from encounters
       where tenant_id = ${tenantId} and state not in ('cancelled', 'entered-in-error')
         and (appointment_id = ${body.appointmentId ?? null}::uuid or queue_entry_id = ${body.queueEntryId ?? null}::uuid)
       limit 1
    `;
    return open ? String(open.id) : null;
  };
  const openConflict = (encounterId: string | null) =>
    new ConflictError("This appointment or queue entry already has an open encounter", { encounterId });

  const replayed = await replay();
  if (replayed) return replayed;
  try {
    await withStaffActor(c, async (tx) => {
      const link = await tx`
        select p.merged_into from tenant_patient_links l join patients p on p.id = l.patient_id
         where l.tenant_id = ${tenantId} and l.patient_id = ${body.patientId}
      `;
      if (!link.length) throw new NotFoundError("Patient is not linked to this facility");
      if (link[0]!.mergedInto) {
        throw new ConflictError("This patient identity was merged; open the encounter on the surviving record", { survivorPatientId: String(link[0]!.mergedInto) });
      }
      if (!actor(c).roles.some((r) => ["receptionist", "nurse", "clinician", "facility_admin"].includes(r))) {
        throw new ForbiddenError("Front-desk access is required");
      }
      const existing = await openEncounter(tx);
      if (existing) throw openConflict(existing);
      const attribution = await resolveAttribution(tx, c, body.departmentId, body.unitId);
      await tx`
        insert into encounters (id, tenant_id, patient_id, appointment_id, queue_entry_id, type, state, reason, created_by, clinician_user_id, idempotency_key, department_id, unit_id)
        values (${id}, ${tenantId}, ${body.patientId}, ${body.appointmentId ?? null}, ${body.queueEntryId ?? null},
          ${body.type}, 'arrived', ${body.reason}, ${auth.user.id}, ${null}, ${key}, ${attribution.departmentId}, ${attribution.unitId})
      `;
      if (body.queueEntryId) {
        await tx`update queue_entries set encounter_id = ${id}, status = 'waiting', updated_at = now() where id = ${body.queueEntryId} and tenant_id = ${tenantId}`;
      }
      if (body.appointmentId) {
        await tx`update appointments set status = 'arrived', updated_at = now() where id = ${body.appointmentId} and tenant_id = ${tenantId}`;
      }
      await writeAudit(tx, deps.config, {
        tenantId,
        actorKind: "staff",
        actorUserId: auth.user.id,
        actorRoles: auth.activeTenant!.roles,
        action: "encounter.create",
        subjectPatientId: body.patientId,
        resourceType: "Encounter",
        resourceId: id,
        ...auditMeta(c),
      });
      await writeOutbox(tx, {
        tenantId,
        eventType: "encounter.created",
        aggregateId: id,
        aggregateVersion: 1,
        payload: { encounterId: id, patientId: body.patientId },
      });
    });
  } catch (error) {
    // Concurrent duplicates pass the checks above together; the unique indexes decide which one wins.
    const constraint = uniqueViolation(error);
    if (constraint === "encounters_idempotency") {
      const raced = await replay();
      if (raced) return raced;
    }
    if (constraint === "encounters_open_appointment" || constraint === "encounters_open_queue_entry") {
      throw openConflict(await withStaffActor(c, openEncounter));
    }
    throw error;
  }
  return c.json({ ok: true, encounterId: id }, 201);
});

receptionRoutes.get("/encounters/worklist", async (c) => {
  requireStaff(c);
  const a = actor(c);
  if (!a.roles.some((r) => ["nurse", "clinician"].includes(r))) {
    throw new ForbiddenError("A clinical role is required for the clinical worklist");
  }
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select e.id, e.state, e.type, e.reason, e.opened_at, e.version,
           p.id as patient_id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex,
           (select count(*)::int from clinical_entries ce where ce.encounter_id = e.id and ce.status = 'draft') as draft_notes,
           (select count(*)::int from clinical_entries ce where ce.encounter_id = e.id and ce.status in ('signed','amended')) as signed_notes,
           (select count(*)::int from follow_ups f where f.encounter_id = e.id and f.status = 'pending') as pending_followups
      from encounters e join patients p on p.id = e.patient_id
     where e.tenant_id = ${auth.activeTenant!.id} and e.state in ('arrived','triaged','in-progress')
     order by case e.state when 'triaged' then 0 when 'in-progress' then 1 else 2 end, e.opened_at
  `);
  await withStaffActor(c, async (tx) => {
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.worklist.read",
      ...auditMeta(c),
    });
  });
  return c.json({ encounters: rows });
});

receptionRoutes.get("/encounters/:id", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const a = actor(c);
  const clinical = a.roles.some((r) => ["nurse", "clinician"].includes(r));
  const data = await withStaffActor(c, async (tx) => {
    const encounters = await tx`
      select e.id, e.state, e.type, e.reason, e.opened_at, e.closed_at, e.version, e.created_by,
             p.id as patient_id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, p.identity_confidence,
             t.name as facility_name, e.tenant_id
        from encounters e join patients p on p.id = e.patient_id join tenants t on t.id = e.tenant_id
       where e.id = ${id} and e.tenant_id = ${auth.activeTenant!.id}
    `;
    if (!encounters[0]) throw new NotFoundError("Encounter not found");
    if (!clinical) {
      return { encounter: encounters[0], triage: [], observations: [], allergies: [], conditions: [], entries: [], followUps: [], referrals: [] };
    }
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "encounter.read",
      subjectPatientId: String(encounters[0].patientId),
      resourceType: "Encounter",
      resourceId: id,
      ...auditMeta(c),
    });
    const [triage, observations, allergies, conditions, entries, followUps, referrals] = await Promise.all([
      tx`select * from triage_records where encounter_id = ${id} and tenant_id = ${auth.activeTenant!.id} order by created_at desc`,
      tx`select id, display, loinc_code, value_num, value_text, unit_code, occurred_at, status, recorded_at from observations where encounter_id = ${id} and tenant_id = ${auth.activeTenant!.id} order by occurred_at desc`,
      tx`select id, state, substance_coding, reaction_coding, severity, note, recorded_at from allergies where encounter_id = ${id} and tenant_id = ${auth.activeTenant!.id} order by recorded_at desc`,
      tx`select id, display, snomed_code, clinical_status, onset_date, note, recorded_at from conditions where encounter_id = ${id} and tenant_id = ${auth.activeTenant!.id} order by recorded_at desc`,
      tx`select ce.id, ce.status, ce.current_version, v.title, v.author_id, u.display_name as author_name, v.occurred_at, v.recorded_at, v.signed_at, v.change_note, v.content
           from clinical_entries ce join clinical_entry_versions v on v.entry_id = ce.id and v.version = ce.current_version
           join users u on u.id = v.author_id
          where ce.encounter_id = ${id} and ce.tenant_id = ${auth.activeTenant!.id} order by ce.created_at`,
      tx`select * from follow_ups where encounter_id = ${id} and tenant_id = ${auth.activeTenant!.id} order by due_date`,
      tx`select * from referrals where encounter_id = ${id} and tenant_id = ${auth.activeTenant!.id} order by created_at`,
    ]);
    return { encounter: encounters[0], triage, observations, allergies, conditions, entries, followUps, referrals };
  });
  return c.json(data);
});

receptionRoutes.post("/encounters/:id/transitions", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, transitionEncounterSchema);
  const a = actor(c);
  if (!a.roles.some((r) => ["nurse", "clinician"].includes(r))) throw new ForbiddenError("Clinical role required");
  const result = await withStaffActor(c, async (tx) => {
    const current = await tx`select state, version, patient_id from encounters where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update`;
    if (!current[0]) throw new NotFoundError("Encounter not found");
    ensureMatch(body.expectedVersion, Number(current[0].version));
    const from = String(current[0].state) as EncounterState;
    if (!canTransitionEncounter(from, body.state)) throw new ConflictError(`Cannot transition encounter from ${from} to ${body.state}`);
    if ((body.state === "cancelled" || body.state === "entered-in-error") && (!body.reason || body.reason.length < 5)) {
      throw new ValidationError("A reason is required for this transition");
    }
    if (body.state === "completed") {
      const drafts = await tx`select count(*)::int as count from clinical_entries where encounter_id = ${id} and status = 'draft'`;
      if (Number(drafts[0]?.count ?? 0) > 0) throw new ConflictError("Sign or resolve draft notes before completing the encounter");
    }
    if (body.state === "in-progress") {
      await tx`update queue_entries set status = 'with-clinician', updated_at = now() where encounter_id = ${id} and status not in ('completed','cancelled')`;
      await tx`update encounters set clinician_user_id = coalesce(clinician_user_id, ${auth.user.id}) where id = ${id}`;
    }
    if (body.state === "completed") {
      await tx`update queue_entries set status = 'completed', completed_at = now(), updated_at = now() where encounter_id = ${id} and status not in ('cancelled')`;
      await tx`update appointments set status = 'completed', updated_at = now() where id = (select appointment_id from encounters where id = ${id})`;
    }
    await tx`
      update encounters set state = ${body.state}, version = version + 1, updated_at = now(),
        closed_at = case when ${body.state} in ('completed','cancelled','entered-in-error') then now() else closed_at end
       where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "encounter.transition",
      subjectPatientId: String(current[0].patientId),
      resourceType: "Encounter",
      resourceId: id,
      ...auditMeta(c),
      metadata: { from, to: body.state, reason: body.reason ?? null },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "encounter.state.changed",
      aggregateId: id,
      aggregateVersion: Number(current[0].version) + 1,
      payload: { from, to: body.state },
    });
    return { id, state: body.state, version: Number(current[0].version) + 1 };
  });
  return c.json({ ok: true, encounter: result });
});

receptionRoutes.post("/encounters/:id/triage", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, triageSchema);
  const a = actor(c);
  if (!a.roles.some((r) => ["nurse", "clinician"].includes(r))) throw new ForbiddenError("Nursing or clinician role required");
  await withStaffActor(c, async (tx) => {
    const encounters = await tx`select id, state, version, patient_id from encounters where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update`;
    if (!encounters[0]) throw new NotFoundError("Encounter not found");
    if (!["planned", "arrived", "triaged"].includes(String(encounters[0].state))) throw new ConflictError("Encounter is not in a triageable state");
    for (const observation of body.observations) {
      await validateClinicalCoding(c, observation.coding, "observation");
      await insertObservation(c, tx, {
        tenantId: auth.activeTenant!.id,
        patientId: String(encounters[0].patientId),
        encounterId: id,
        authorId: auth.user.id,
        coding: observation.coding,
        value: observation.value,
        unit: observation.unit,
        occurredAt: new Date(observation.occurredAt),
        source: "triage",
      });
    }
    if (body.allergyState) {
      if (body.allergyState === "recorded") {
        if (!body.allergy?.substance) throw new ValidationError("A recorded allergy requires a substance");
        await validateClinicalCoding(c, body.allergy.substance, "allergy-substance");
        if (body.allergy.reaction) await validateClinicalCoding(c, body.allergy.reaction, "allergy-reaction");
      }
      await insertAllergy(c, tx, {
        tenantId: auth.activeTenant!.id,
        patientId: String(encounters[0].patientId),
        encounterId: id,
        authorId: auth.user.id,
        state: body.allergyState,
        substance: body.allergy?.substance ?? null,
        reaction: body.allergy?.reaction ?? null,
        severity: "unknown",
        note: body.allergy?.note || null,
      });
    }
    await tx`
      insert into triage_records (id, tenant_id, encounter_id, patient_id, complaint, urgency, notes, nurse_user_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${encounters[0].patientId}, ${body.complaint},
        ${body.urgency}, ${body.notes || null}, ${auth.user.id})
    `;
    await tx`update encounters set state = 'triaged', version = version + 1, updated_at = now() where id = ${id}`;
    await tx`update queue_entries set status = 'in-triage', updated_at = now() where encounter_id = ${id} and status not in ('completed','cancelled')`;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "encounter.triage",
      subjectPatientId: String(encounters[0].patientId),
      resourceType: "Encounter",
      resourceId: id,
      ...auditMeta(c),
      metadata: { urgency: body.urgency, allergyState: body.allergyState },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "encounter.triaged",
      aggregateId: id,
      aggregateVersion: Number(encounters[0].version) + 1,
      payload: { encounterId: id, urgency: body.urgency },
    });
  });
  return c.json({ ok: true });
});
