import { Hono } from "hono";
import {
  emergencyCaseSchema,
  emergencyDispositionSchema,
  emergencyHandoffSchema,
  emergencyObservationSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertEmergencyAccess } from "@medveris/authz";
import { canTransitionEncounter, randomPatientPublicId, type EncounterState } from "@medveris/domain";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import { insertObservation } from "../services/clinical.js";
import type { AppEnv } from "../types.js";

export const emergencyRoutes = new Hono<AppEnv>();

function emergencyStatus(c: Parameters<typeof requireStaff>[0]): "active" | "closed" | "all" {
  const value = c.req.query("status") ?? "active";
  if (value !== "active" && value !== "closed" && value !== "all") {
    throw new ValidationError("status must be active, closed or all");
  }
  return value;
}

async function emergencyCaseFor(tx: Tx, tenantId: string, id: string, lock = false) {
  const rows = await tx`
    select ec.*, e.state, e.version as encounter_version, e.reason, e.opened_at, e.closed_at as encounter_closed_at,
           p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, p.identity_confidence, p.created_via
      from emergency_cases ec join encounters e on e.id = ec.encounter_id join patients p on p.id = ec.patient_id
     where ec.id = ${id} and ec.tenant_id = ${tenantId}
     ${lock ? tx`for update of ec` : tx``}
  `;
  return requireRows(rows, "Emergency case not found");
}

async function ensureClinicalMember(tx: Tx, tenantId: string, userId: string, label: string): Promise<void> {
  const member = await tx`
    select 1 from memberships
     where tenant_id = ${tenantId} and user_id = ${userId} and status = 'active'
       and roles && ARRAY['clinician','nurse']
  `;
  if (!member[0]) throw new ValidationError(`${label} is not an active clinical member of this facility`);
}

emergencyRoutes.get("/emergency/cases", async (c) => {
  requireStaff(c);
  assertEmergencyAccess(requestActor(c));
  const auth = c.get("auth")!;
  const status = emergencyStatus(c);
  const rows = await withStaffActor(c, async (tx) => tx`
    select ec.id, ec.encounter_id, ec.patient_id, ec.arrival_mode, ec.location, ec.assigned_user_id,
           ec.status, ec.disposition, ec.disposition_note, ec.closed_at, ec.created_at, ec.updated_at,
           e.state as encounter_state, e.version as encounter_version, e.reason, e.opened_at,
           p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, p.identity_confidence, p.created_via,
           u.display_name as assigned_name,
           triage.complaint as triage_complaint, triage.urgency as triage_urgency, triage.created_at as triaged_at,
           (select count(*)::int from observations o where o.encounter_id = ec.encounter_id and o.tenant_id = ec.tenant_id) as observation_count,
           (select max(o.occurred_at) from observations o where o.encounter_id = ec.encounter_id and o.tenant_id = ec.tenant_id) as last_observation_at
      from emergency_cases ec
      join encounters e on e.id = ec.encounter_id
      join patients p on p.id = ec.patient_id
      left join users u on u.id = ec.assigned_user_id
      left join lateral (
        select complaint, urgency, created_at from triage_records
         where encounter_id = ec.encounter_id and tenant_id = ec.tenant_id
         order by created_at desc limit 1
      ) triage on true
     where ec.tenant_id = ${auth.activeTenant!.id}
       and (${status} = 'all' or (${status} = 'active' and ec.status = 'active') or (${status} = 'closed' and ec.status = 'closed'))
     order by case when ec.status = 'active' then 0 else 1 end,
              case triage.urgency when 'emergency' then 0 when 'urgent' then 1 else 2 end,
              ec.created_at desc
     limit 200
  `);
  return c.json({ cases: rows });
});

emergencyRoutes.post("/emergency/cases", async (c) => {
  requireStaff(c);
  assertEmergencyAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, emergencyCaseSchema);
  const result = await withStaffActor(c, async (tx) => {
    let patientId = body.patientId ?? null;
    let publicId: string | null = null;
    let temporaryIdentity = false;
    if (patientId) {
      const linked = await tx`select public_id from patients join tenant_patient_links l on l.patient_id = patients.id where patients.id = ${patientId} and l.tenant_id = ${auth.activeTenant!.id}`;
      if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
      publicId = String(linked[0].publicId);
    } else {
      const temporary = body.temporaryPatient!;
      publicId = randomPatientPublicId();
      for (let attempt = 0; attempt < 5; attempt++) {
        const clash = await tx`select 1 from patients where public_id = ${publicId}`;
        if (!clash[0]) break;
        publicId = randomPatientPublicId();
      }
      patientId = crypto.randomUUID();
      temporaryIdentity = true;
      await tx`
        insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, identity_confidence,
          identity_evidence, created_via, created_tenant_id)
        values (${patientId}, ${publicId}, ${temporary.givenName}, ${temporary.familyName}, ${temporary.dateOfBirth},
          ${temporary.sex}, 'temporary', 'Emergency registration without confirmed identity; reconcile when identified',
          'temporary-emergency', ${auth.activeTenant!.id})
      `;
      await tx`
        insert into tenant_patient_links (id, tenant_id, patient_id)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${patientId})
      `;
    }
    if (body.assignedUserId) await ensureClinicalMember(tx, auth.activeTenant!.id, body.assignedUserId, "Assigned clinician");
    const caseId = crypto.randomUUID();
    const encounterId = crypto.randomUUID();
    await tx`
      insert into encounters (id, tenant_id, patient_id, type, state, reason, version, created_by, opened_at, updated_at)
      values (${encounterId}, ${auth.activeTenant!.id}, ${patientId}, 'emergency', 'arrived', ${body.reason}, 1, ${auth.user.id}, now(), now())
    `;
    await tx`
      insert into emergency_cases (id, tenant_id, encounter_id, patient_id, arrival_mode, location, assigned_user_id, created_by)
      values (${caseId}, ${auth.activeTenant!.id}, ${encounterId}, ${patientId}, ${body.arrivalMode},
        ${body.location || null}, ${body.assignedUserId ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "emergency.case.create", {
      subjectPatientId: patientId, resourceType: "EmergencyCase", resourceId: caseId,
      metadata: { encounterId, arrivalMode: body.arrivalMode, temporaryIdentity, assignedUserId: body.assignedUserId ?? null },
    }));
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id, eventType: "emergency.case.created", aggregateId: caseId,
      payload: { encounterId, patientId, arrivalMode: body.arrivalMode, temporaryIdentity },
    });
    return { id: caseId, encounterId, patientId, publicId, temporaryIdentity };
  });
  return c.json({ ok: true, case: result }, 201);
});

emergencyRoutes.get("/emergency/cases/:id", async (c) => {
  requireStaff(c);
  assertEmergencyAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const record = await emergencyCaseFor(tx, auth.activeTenant!.id, id);
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "emergency.case.read", {
      subjectPatientId: String(record.patientId), resourceType: "EmergencyCase", resourceId: id,
    }));
    const [triage, observations, allergies, conditions, entries, handoffs] = await Promise.all([
      tx`select * from triage_records where encounter_id = ${record.encounterId} and tenant_id = ${auth.activeTenant!.id} order by created_at desc`,
      tx`select id, display, loinc_code, value_num, value_text, unit_code, occurred_at, status, recorded_at
           from observations where encounter_id = ${record.encounterId} and tenant_id = ${auth.activeTenant!.id}
          order by occurred_at desc limit 200`,
      tx`select id, state, substance_coding, reaction_coding, severity, note, recorded_at
           from allergies where encounter_id = ${record.encounterId} and tenant_id = ${auth.activeTenant!.id}
          order by recorded_at desc`,
      tx`select id, display, snomed_code, clinical_status, onset_date, note, recorded_at
           from conditions where encounter_id = ${record.encounterId} and tenant_id = ${auth.activeTenant!.id}
          order by recorded_at desc`,
      tx`select ce.id, ce.status, ce.current_version, v.title, u.display_name as author_name, v.occurred_at, v.signed_at
           from clinical_entries ce join clinical_entry_versions v on v.entry_id = ce.id and v.version = ce.current_version
           join users u on u.id = v.author_id
          where ce.encounter_id = ${record.encounterId} and ce.tenant_id = ${auth.activeTenant!.id}
          order by v.occurred_at desc`,
      tx`select h.*, fu.display_name as from_name, tu.display_name as to_name
           from emergency_handoffs h join users fu on fu.id = h.from_user_id join users tu on tu.id = h.to_user_id
          where h.case_id = ${id} and h.tenant_id = ${auth.activeTenant!.id} order by h.created_at desc`,
    ]);
    return { case: record, triage, observations, allergies, conditions, entries, handoffs };
  });
  return c.json(data);
});

emergencyRoutes.post("/emergency/cases/:id/observations", async (c) => {
  requireStaff(c);
  assertEmergencyAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, emergencyObservationSchema);
  const observationId = await withStaffActor(c, async (tx) => {
    const record = await emergencyCaseFor(tx, auth.activeTenant!.id, id, true);
    if (record.status !== "active") throw new ConflictError("Observations cannot be added to a closed emergency case");
    if (["completed", "cancelled", "entered-in-error"].includes(String(record.state))) {
      throw new ConflictError("Observations cannot be added to a closed encounter");
    }
    const observationId = await insertObservation(c, tx, {
      tenantId: auth.activeTenant!.id,
      patientId: String(record.patientId),
      encounterId: String(record.encounterId),
      authorId: auth.user.id,
      coding: body.coding,
      value: body.value,
      unit: body.unit,
      occurredAt: new Date(body.occurredAt),
      source: "emergency",
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "emergency.observation.record", {
      subjectPatientId: String(record.patientId), resourceType: "Observation", resourceId: observationId,
      metadata: { caseId: id, loincCode: body.coding.code, unit: body.unit.code },
    }));
    return observationId;
  });
  return c.json({ ok: true, observation: { id: observationId } }, 201);
});

emergencyRoutes.post("/emergency/cases/:id/handoffs", async (c) => {
  requireStaff(c);
  assertEmergencyAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, emergencyHandoffSchema);
  await withStaffActor(c, async (tx) => {
    const record = await emergencyCaseFor(tx, auth.activeTenant!.id, id, true);
    if (record.status !== "active") throw new ConflictError("Handoffs must be recorded while the emergency case is active");
    await ensureClinicalMember(tx, auth.activeTenant!.id, body.toUserId, "Handoff recipient");
    await tx`
      insert into emergency_handoffs (id, tenant_id, case_id, from_user_id, to_user_id, summary)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${auth.user.id}, ${body.toUserId}, ${body.summary})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "emergency.handoff.record", {
      subjectPatientId: String(record.patientId), resourceType: "EmergencyCase", resourceId: id,
      metadata: { toUserId: body.toUserId },
    }));
  });
  return c.json({ ok: true }, 201);
});

emergencyRoutes.post("/emergency/cases/:id/disposition", async (c) => {
  requireStaff(c);
  assertEmergencyAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, emergencyDispositionSchema);
  const result = await withStaffActor(c, async (tx) => {
    const record = await emergencyCaseFor(tx, auth.activeTenant!.id, id, true);
    if (record.status !== "active") throw new ConflictError("This emergency case is already closed");
    ensureMatch(body.expectedVersion, Number(record.encounterVersion));
    if (body.disposition === "admitted") {
      const admission = await tx`
        select 1 from admissions where encounter_id = ${record.encounterId} and tenant_id = ${auth.activeTenant!.id} and status = 'admitted'
      `;
      if (!admission[0]) throw new ConflictError("Create an inpatient admission before recording an admitted disposition");
    }
    const from = String(record.state) as EncounterState;
    let nextState: EncounterState;
    if (body.disposition === "admitted") {
      nextState = from === "arrived" || from === "triaged" ? "in-progress" : from;
    } else {
      nextState = body.disposition === "cancelled" || body.disposition === "left-without-seen" ? "cancelled" : "completed";
      if (from !== nextState && !canTransitionEncounter(from, nextState)) {
        throw new ConflictError(`Start treatment before recording this disposition (encounter is ${from})`);
      }
      if (nextState === "completed") {
        const drafts = await tx`select count(*)::int as count from clinical_entries where encounter_id = ${record.encounterId} and status = 'draft'`;
        if (Number(drafts[0]?.count ?? 0) > 0) throw new ConflictError("Sign or resolve draft notes before closing the emergency case");
      }
    }
    const nextVersion = Number(record.encounterVersion) + (nextState === from ? 0 : 1);
    if (nextState !== from) {
      await tx`
        update encounters set state = ${nextState}, version = version + 1, updated_at = now(),
          closed_at = case when ${nextState} in ('completed','cancelled') then now() else closed_at end
         where id = ${record.encounterId} and tenant_id = ${auth.activeTenant!.id}
      `;
    }
    await tx`
      update emergency_cases set status = 'closed', disposition = ${body.disposition}, disposition_note = ${body.note},
        closed_at = now(), updated_at = now() where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "emergency.case.disposition", {
      subjectPatientId: String(record.patientId), resourceType: "EmergencyCase", resourceId: id,
      metadata: { disposition: body.disposition, encounterState: nextState, note: body.note },
    }));
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id, eventType: "emergency.case.dispositioned", aggregateId: id,
      aggregateVersion: nextVersion, payload: { disposition: body.disposition, encounterState: nextState },
    });
    return { disposition: body.disposition, encounterState: nextState, encounterVersion: nextVersion };
  });
  return c.json({ ok: true, case: result });
});

