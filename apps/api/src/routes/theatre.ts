import { Hono } from "hono";
import {
  anesthesiaRecordSchema,
  preopAssessmentSchema,
  recoveryObservationSchema,
  theatreCaseSchema,
  theatreCaseTransitionSchema,
  theatreChecklistSchema,
  theatreConsentSchema,
  theatreCountSchema,
  theatreSchema,
  theatreSpecimenSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertMembershipAdmin, assertWardAccess } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const theatreRoutes = new Hono<AppEnv>();

const NEXT_STATUS: Record<string, string[]> = {
  scheduled: ["preop-ready", "cancelled"],
  "preop-ready": ["in-theatre", "cancelled"],
  "in-theatre": ["recovery"],
  recovery: ["completed"],
};

theatreRoutes.get("/theatres", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select * from theatres where tenant_id = ${auth.activeTenant!.id} order by name
  `);
  return c.json({ theatres: rows });
});

theatreRoutes.post("/theatres", async (c) => {
  requireStaff(c);
  assertMembershipAdmin(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, theatreSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into theatres (id, tenant_id, name, status) values (${id}, ${auth.activeTenant!.id}, ${body.name}, ${body.status})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.create", { resourceType: "Theatre", resourceId: id }));
  });
  return c.json({ ok: true, theatre: { id } }, 201);
});

theatreRoutes.get("/theatre-cases", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select tc.id, tc.patient_id, tc.encounter_id, tc.admission_id, tc.procedure_name, tc.procedure_coding,
           tc.laterality, tc.site, tc.urgency, tc.scheduled_at, tc.theatre_id, tc.surgeon_user_id,
           tc.anesthetist_user_id, tc.status, tc.version, p.public_id, p.given_name, p.family_name,
           t.name as theatre_name, u.display_name as surgeon_name
      from theatre_cases tc join patients p on p.id = tc.patient_id
      left join theatres t on t.id = tc.theatre_id left join users u on u.id = tc.surgeon_user_id
     where tc.tenant_id = ${auth.activeTenant!.id}
     order by tc.scheduled_at desc limit 200
  `);
  return c.json({ cases: rows });
});

theatreRoutes.post("/theatre-cases", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, theatreCaseSchema);
  if (body.procedureName.length < 3) throw new ValidationError("Procedure name is too short");
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const encounter = await requireRows(await tx`
      select id, patient_id from encounters where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id}
    `, "Encounter not found");
    if (String(encounter.patientId) !== body.patientId) throw new ValidationError("Encounter does not belong to the selected patient");
    if (body.admissionId) {
      const admission = await tx`
        select id from admissions where id = ${body.admissionId} and patient_id = ${body.patientId}
         and tenant_id = ${auth.activeTenant!.id} and status = 'admitted'
      `;
      if (!admission[0]) throw new ValidationError("The selected active admission does not belong to this patient");
    }
    await tx`
      insert into theatre_cases (id, tenant_id, patient_id, encounter_id, admission_id, procedure_name, procedure_coding,
        laterality, site, urgency, scheduled_at, theatre_id, surgeon_user_id, anesthetist_user_id, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId}, ${body.admissionId ?? null},
        ${body.procedureName}, ${body.procedureCoding ? tx.json(body.procedureCoding as never) : null},
        ${body.laterality}, ${body.site || null}, ${body.urgency}, ${new Date(body.scheduledAt)},
        ${body.theatreId ?? null}, ${body.surgeonUserId ?? auth.user.id}, ${body.anesthetistUserId ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.case.create", {
      subjectPatientId: body.patientId, resourceType: "TheatreCase", resourceId: id,
      metadata: { urgency: body.urgency, laterality: body.laterality },
    }));
  });
  return c.json({ ok: true, case: { id } }, 201);
});

theatreRoutes.get("/theatre-cases/:id", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select tc.*, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, t.name as theatre_name
        from theatre_cases tc join patients p on p.id = tc.patient_id left join theatres t on t.id = tc.theatre_id
       where tc.id = ${id} and tc.tenant_id = ${auth.activeTenant!.id}
    `, "Theatre case not found");
    const [preop, consents, checklists, anesthesia, recovery, counts, specimens] = await Promise.all([
      tx`select * from preop_assessments where case_id = ${id} order by created_at desc`,
      tx`select * from theatre_consents where case_id = ${id} order by created_at desc`,
      tx`select * from theatre_checklists where case_id = ${id} order by created_at`,
      tx`select * from anesthesia_records where case_id = ${id} order by created_at desc`,
      tx`select * from recovery_observations where case_id = ${id} order by occurred_at`,
      tx`select * from theatre_counts where case_id = ${id} order by created_at`,
      tx`select * from theatre_specimens where case_id = ${id} order by created_at`,
    ]);
    return { case: tc, preop, consents, checklists, anesthesia, recovery, counts, specimens };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.case.read", {
    subjectPatientId: String(data.case.patientId), resourceType: "TheatreCase", resourceId: id,
  })));
  return c.json(data);
});

theatreRoutes.post("/theatre-cases/:id/preop", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, preopAssessmentSchema);
  const recordId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Theatre case not found");
    if (!["scheduled", "preop-ready"].includes(String(tc.status))) throw new ConflictError("Pre-operative assessment is closed");
    await tx`
      insert into preop_assessments (id, tenant_id, case_id, investigations_reviewed, fitness, notes, assessor_id)
      values (${recordId}, ${auth.activeTenant!.id}, ${id}, ${body.investigationsReviewed}, ${body.fitness}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.preop.create", {
      subjectPatientId: String(tc.patientId), resourceType: "PreopAssessment", resourceId: recordId,
      metadata: { investigationsReviewed: body.investigationsReviewed },
    }));
  });
  return c.json({ ok: true, assessment: { id: recordId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/consent", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, theatreConsentSchema);
  const recordId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Theatre case not found");
    if (!["scheduled", "preop-ready"].includes(String(tc.status))) throw new ConflictError("Consent is closed for this case");
    if (!body.procedureConsent || !body.siteMarked) throw new ValidationError("Procedure consent and site marking are both required");
    await tx`
      insert into theatre_consents (id, tenant_id, case_id, procedure_consent, site_marked, consent_reference, recorded_by)
      values (${recordId}, ${auth.activeTenant!.id}, ${id}, ${body.procedureConsent}, ${body.siteMarked}, ${body.consentReference}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.consent.record", {
      subjectPatientId: String(tc.patientId), resourceType: "TheatreConsent", resourceId: recordId,
      metadata: { consentReference: body.consentReference },
    }));
  });
  return c.json({ ok: true, consent: { id: recordId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/checklist", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, theatreChecklistSchema);
  const checklistId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Theatre case not found");
    if (!["scheduled", "preop-ready", "in-theatre"].includes(String(tc.status))) throw new ConflictError("Checklists are closed for this case");
    const existing = await tx`select id from theatre_checklists where case_id = ${id} and stage = ${body.stage}`;
    if (existing[0]) throw new ConflictError(`${body.stage} checklist has already been recorded`);
    const allTrue = Object.values(body.items).every(Boolean);
    if (!allTrue) throw new ValidationError("Every checklist item must be confirmed before the stage can be recorded");
    await tx`
      insert into theatre_checklists (id, tenant_id, case_id, stage, items, notes, recorded_by)
      values (${checklistId}, ${auth.activeTenant!.id}, ${id}, ${body.stage}, ${tx.json(body.items as never)}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.checklist.record", {
      subjectPatientId: String(tc.patientId), resourceType: "TheatreChecklist", resourceId: checklistId,
      metadata: { stage: body.stage },
    }));
  });
  return c.json({ ok: true, checklist: { id: checklistId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/anesthesia", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, anesthesiaRecordSchema);
  const recordId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Theatre case not found");
    if (!["preop-ready", "in-theatre"].includes(String(tc.status))) throw new ConflictError("Anesthesia documentation is not open");
    await tx`
      insert into anesthesia_records (id, tenant_id, case_id, anesthesia_type, notes, started_at, ended_at, author_id)
      values (${recordId}, ${auth.activeTenant!.id}, ${id}, ${body.anesthesiaType}, ${body.notes},
        ${new Date(body.startedAt)}, ${body.endedAt ? new Date(body.endedAt) : null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.anesthesia.create", {
      subjectPatientId: String(tc.patientId), resourceType: "AnesthesiaRecord", resourceId: recordId,
      metadata: { anesthesiaType: body.anesthesiaType },
    }));
  });
  return c.json({ ok: true, anesthesia: { id: recordId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/recovery", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, recoveryObservationSchema);
  const recordId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Theatre case not found");
    if (!["in-theatre", "recovery"].includes(String(tc.status))) throw new ConflictError("Recovery observations require an in-theatre or recovery case");
    await tx`
      insert into recovery_observations (id, tenant_id, case_id, respiratory, circulation, consciousness, pain, notes, occurred_at, author_id)
      values (${recordId}, ${auth.activeTenant!.id}, ${id}, ${body.respiratory}, ${body.circulation}, ${body.consciousness},
        ${body.pain}, ${body.notes || null}, ${new Date(body.occurredAt)}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.recovery.observe", {
      subjectPatientId: String(tc.patientId), resourceType: "RecoveryObservation", resourceId: recordId,
    }));
  });
  return c.json({ ok: true, observation: { id: recordId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/counts", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, theatreCountSchema);
  const recordId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Theatre case not found");
    await tx`
      insert into theatre_counts (id, tenant_id, case_id, item_type, expected_count, actual_count, notes, recorded_by)
      values (${recordId}, ${auth.activeTenant!.id}, ${id}, ${body.itemType}, ${body.expectedCount}, ${body.actualCount}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.count.record", {
      subjectPatientId: String(tc.patientId), resourceType: "TheatreCount", resourceId: recordId,
      metadata: { matches: body.expectedCount === body.actualCount },
    }));
  });
  return c.json({ ok: true, count: { id: recordId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/specimens", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, theatreSpecimenSchema);
  const recordId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id from theatre_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Theatre case not found");
    await tx`
      insert into theatre_specimens (id, tenant_id, case_id, specimen_type, destination, recorded_by)
      values (${recordId}, ${auth.activeTenant!.id}, ${id}, ${body.specimenType}, ${body.destination}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "theatre.specimen.record", {
      subjectPatientId: String(tc.patientId), resourceType: "TheatreSpecimen", resourceId: recordId,
    }));
  });
  return c.json({ ok: true, specimen: { id: recordId } }, 201);
});

theatreRoutes.post("/theatre-cases/:id/transitions", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, theatreCaseTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const tc = await requireRows(await tx`
      select id, patient_id, status, version from theatre_cases
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Theatre case not found");
    ensureMatch(body.expectedVersion, Number(tc.version));
    const allowed = NEXT_STATUS[String(tc.status)] ?? [];
    if (!allowed.includes(body.status)) throw new ConflictError(`Cannot move a theatre case from ${tc.status} to ${body.status}`);
    const emergency = Boolean(body.emergencyExceptionReason);
    if (body.status === "preop-ready") {
      const preop = await tx`select 1 from preop_assessments where case_id = ${id}`;
      const consent = await tx`select 1 from theatre_consents where case_id = ${id} and procedure_consent and site_marked`;
      if (!preop.length) throw new ConflictError("Pre-operative assessment is required before preop-ready");
      if (!consent.length && !emergency) throw new ConflictError("Documented procedure consent and site marking are required; record an emergency exception to proceed");
    }
    if (body.status === "in-theatre") {
      const timeout = await tx`select 1 from theatre_checklists where case_id = ${id} and stage = 'time-out'`;
      if (!timeout.length) throw new ConflictError("The time-out checklist is required before entering theatre");
    }
    if (body.status === "recovery") {
      const anesthesia = await tx`select 1 from anesthesia_records where case_id = ${id}`;
      const signout = await tx`select 1 from theatre_checklists where case_id = ${id} and stage = 'sign-out'`;
      if (!anesthesia.length || !signout.length) throw new ConflictError("Anesthesia and sign-out documentation are required before recovery");
    }
    if (body.status === "completed") {
      const recovery = await tx`select 1 from recovery_observations where case_id = ${id}`;
      if (!recovery.length) throw new ConflictError("At least one recovery observation is required before completion");
    }
    if (body.status === "cancelled" && !body.cancellationReason) throw new ValidationError("A cancellation reason is required");
    await tx`
      update theatre_cases set status = ${body.status}, version = version + 1,
        cancellation_reason = ${body.cancellationReason ?? null},
        emergency_exception_reason = ${body.emergencyExceptionReason ?? null}, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `theatre.case.${body.status}`, {
      subjectPatientId: String(tc.patientId), resourceType: "TheatreCase", resourceId: id,
      metadata: { from: tc.status, emergencyException: emergency, reason: body.cancellationReason ?? null },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "theatre.case.status", aggregateId: id, payload: { status: body.status } });
  });
  return c.json({ ok: true });
});
