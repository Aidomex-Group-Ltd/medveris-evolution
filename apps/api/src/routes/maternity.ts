import { Hono } from "hono";
import {
  antenatalVisitSchema,
  childHealthEventSchema,
  deliveryRecordSchema,
  immunizationSchema,
  labourAlertSchema,
  labourObservationSchema,
  maternityEpisodeSchema,
  maternityEpisodeUpdateSchema,
  newbornPatientCreateSchema,
  newbornRecordSchema,
  newbornStatusUpdateSchema,
  uuidSchema,
} from "@medveris/contracts";
import { validateLabourObservation } from "@medveris/domain";
import { assertWardAccess } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const maternityRoutes = new Hono<AppEnv>();

maternityRoutes.get("/maternity/episodes", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select e.id, e.patient_id, e.encounter_id, e.gravidity, e.parity, e.estimated_due_date, e.dating_basis,
           e.risk_level, e.status, e.admitted_at, e.delivered_at, e.closed_at, e.version, e.notes,
           p.public_id, p.given_name, p.family_name,
           (select count(*)::int from labour_observations o where o.episode_id = e.id) as observation_count,
           (select count(*)::int from newborn_records n where n.episode_id = e.id) as newborn_count,
           exists (select 1 from delivery_records d where d.episode_id = e.id) as has_delivery
      from maternity_episodes e join patients p on p.id = e.patient_id
     where e.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and e.status = ${status}` : tx``}
     order by e.created_at desc limit 200
  `);
  return c.json({ episodes: rows });
});

maternityRoutes.post("/maternity/episodes", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, maternityEpisodeSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const patient = await tx`select id from patients where id = ${body.patientId} and created_tenant_id = ${auth.activeTenant!.id}`;
    if (!patient[0]) throw new ValidationError("The patient does not belong to this facility");
    if (body.encounterId) {
      const encounter = await tx`
        select id, patient_id, state from encounters where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id}
      `;
      const row = await requireRows(encounter, "Encounter not found");
      if (String(row.patientId) !== body.patientId) throw new ValidationError("The encounter does not belong to the selected patient");
    }
    await tx`
      insert into maternity_episodes (id, tenant_id, patient_id, encounter_id, gravidity, parity, estimated_due_date,
        dating_basis, risk_level, status, admitted_at, notes, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId ?? null}, ${body.gravidity ?? null},
        ${body.parity ?? null}, ${body.estimatedDueDate ?? null}, ${body.datingBasis ?? null}, ${body.riskLevel},
        'active', now(), ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.episode.create", {
      subjectPatientId: body.patientId, resourceType: "MaternityEpisode", resourceId: id, metadata: { riskLevel: body.riskLevel },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "maternity.episode.created", aggregateId: id });
  });
  return c.json({ ok: true, episode: { id } }, 201);
});

maternityRoutes.get("/maternity/episodes/:id", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select e.*, p.public_id, p.given_name, p.family_name, p.date_of_birth
        from maternity_episodes e join patients p on p.id = e.patient_id
       where e.id = ${id} and e.tenant_id = ${auth.activeTenant!.id}
    `, "Maternity episode not found");
    const observations = await tx`
      select o.id, o.template_type, o.clinical_occurred_at, o.recorded_at, o.maternal, o.fetal, o.notes,
             o.late_entry, u.display_name as recorded_by_name
        from labour_observations o join users u on u.id = o.recorded_by
       where o.episode_id = ${id} order by o.clinical_occurred_at
    `;
    const delivery = await tx`select * from delivery_records where episode_id = ${id}`;
    const newborns = await tx`select * from newborn_records where episode_id = ${id} order by created_at`;
    return { episode, observations, delivery: delivery[0] ?? null, newborns };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.episode.read", {
    subjectPatientId: String(data.episode.patientId), resourceType: "MaternityEpisode", resourceId: id,
  })));
  return c.json(data);
});

maternityRoutes.patch("/maternity/episodes/:id", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, maternityEpisodeUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status, version from maternity_episodes
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Maternity episode not found");
    if (body.expectedVersion) ensureMatch(body.expectedVersion, Number(episode.version));
    const from = String(episode.status);
    if (body.status && body.status !== from) {
      const allowed: Record<string, string[]> = {
        active: ["delivered", "closed", "transferred-out", "cancelled"],
        delivered: ["closed", "transferred-out"],
        closed: [],
        "transferred-out": [],
        cancelled: [],
      };
      if (!(allowed[from] ?? []).includes(body.status)) throw new ConflictError(`Cannot move a ${from} episode to ${body.status}`);
    }
    await tx`
      update maternity_episodes set
        status = coalesce(${body.status ?? null}, status),
        risk_level = coalesce(${body.riskLevel ?? null}, risk_level),
        gravidity = ${body.gravidity === undefined ? tx`gravidity` : body.gravidity},
        parity = ${body.parity === undefined ? tx`parity` : body.parity},
        estimated_due_date = ${body.estimatedDueDate === undefined ? tx`estimated_due_date` : body.estimatedDueDate},
        dating_basis = ${body.datingBasis === undefined ? tx`dating_basis` : body.datingBasis},
        notes = ${body.notes === undefined ? tx`notes` : (body.notes || null)},
        closed_at = case when ${body.status === "closed"} then now() else closed_at end,
        version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.episode.update", {
      subjectPatientId: String(episode.patientId), resourceType: "MaternityEpisode", resourceId: id,
      metadata: { from, to: body.status ?? from, riskLevel: body.riskLevel ?? null },
    }));
  });
  return c.json({ ok: true });
});

maternityRoutes.post("/maternity/episodes/:id/observations", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, labourObservationSchema);
  validateLabourObservation({
    occurredAt: body.clinicalOccurredAt,
    templateType: body.templateType,
    maternal: body.maternal as Record<string, number | string | null>,
    fetal: body.fetal as Record<string, number | string | null>,
    notes: body.notes || null,
  });
  const observationId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status from maternity_episodes where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Maternity episode not found");
    if (!["active", "delivered"].includes(String(episode.status))) {
      throw new ConflictError("Labour observations can only be charted on an active episode");
    }
    await tx`
      insert into labour_observations (id, tenant_id, episode_id, template_type, clinical_occurred_at, maternal, fetal, notes, late_entry, recorded_by)
      values (${observationId}, ${auth.activeTenant!.id}, ${id}, ${body.templateType}, ${new Date(body.clinicalOccurredAt)},
        ${tx.json(body.maternal as never)}, ${tx.json(body.fetal as never)}, ${body.notes || null}, ${body.lateEntry}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.labour.observe", {
      subjectPatientId: String(episode.patientId), resourceType: "LabourObservation", resourceId: observationId,
      metadata: { templateType: body.templateType, lateEntry: body.lateEntry },
    }));
  });
  return c.json({ ok: true, observation: { id: observationId } }, 201);
});

maternityRoutes.post("/maternity/episodes/:id/delivery", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, deliveryRecordSchema);
  const deliveryId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status from maternity_episodes
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Maternity episode not found");
    if (String(episode.status) !== "active") throw new ConflictError("Only an active maternity episode can record a delivery");
    const existing = await tx`select id from delivery_records where episode_id = ${id}`;
    if (existing[0]) throw new ConflictError("A delivery is already recorded for this episode");
    await tx`
      insert into delivery_records (id, tenant_id, episode_id, delivered_at, mode, outcome, blood_loss_ml, perineum, complications, notes, attended_by)
      values (${deliveryId}, ${auth.activeTenant!.id}, ${id}, ${new Date(body.deliveredAt)}, ${body.mode}, ${body.outcome},
        ${body.bloodLossMl ?? null}, ${body.perineum || null}, ${body.complications || null}, ${body.notes || null}, ${auth.user.id})
    `;
    await tx`
      update maternity_episodes set status = 'delivered', delivered_at = ${new Date(body.deliveredAt)}, version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.delivery.record", {
      subjectPatientId: String(episode.patientId), resourceType: "DeliveryRecord", resourceId: deliveryId,
      metadata: { mode: body.mode, outcome: body.outcome, bloodLossMl: body.bloodLossMl ?? null },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "maternity.delivery.recorded", aggregateId: deliveryId, payload: { outcome: body.outcome } });
  });
  return c.json({ ok: true, delivery: { id: deliveryId } }, 201);
});

maternityRoutes.post("/maternity/episodes/:id/newborns", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, newbornRecordSchema);
  const newbornId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status from maternity_episodes where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Maternity episode not found");
    if (!["active", "delivered"].includes(String(episode.status))) {
      throw new ConflictError("Newborn records require an active or delivered episode");
    }
    await tx`
      insert into newborn_records (id, tenant_id, episode_id, given_name, family_name, sex, born_at, weight_g, apgar_1, apgar_5, feeding, notes, created_by)
      values (${newbornId}, ${auth.activeTenant!.id}, ${id}, ${body.givenName}, ${body.familyName}, ${body.sex},
        ${body.bornAt ? new Date(body.bornAt) : null}, ${body.weightG ?? null}, ${body.apgar1 ?? null}, ${body.apgar5 ?? null},
        ${body.feeding || null}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.newborn.record", {
      subjectPatientId: String(episode.patientId), resourceType: "NewbornRecord", resourceId: newbornId,
      metadata: { sex: body.sex, weightG: body.weightG ?? null },
    }));
  });
  return c.json({ ok: true, newborn: { id: newbornId } }, 201);
});

// Labour alerts are decision support only: staff record them manually or from
// partograph review. They do not trigger automated clinical action.
maternityRoutes.get("/maternity/episodes/:id/alerts", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id from maternity_episodes where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Maternity episode not found");
    const alerts = await tx`
      select la.*, u.display_name as recorded_by_name
        from labour_alerts la join users u on u.id = la.recorded_by
       where la.episode_id = ${id}
       order by la.recorded_at desc
    `;
    return { episodeId: id, patientId: String(episode.patient_id), alerts };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.alerts.read", {
    subjectPatientId: String(data.patientId), resourceType: "LabourAlert", resourceId: id,
  })));
  return c.json(data);
});

maternityRoutes.post("/maternity/episodes/:id/alerts", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, labourAlertSchema);
  const alertId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status from maternity_episodes where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Maternity episode not found");
    if (!["active", "delivered"].includes(String(episode.status))) {
      throw new ConflictError("Alerts can only be recorded on an active or delivered episode");
    }
    await tx`
      insert into labour_alerts (id, tenant_id, episode_id, alert, severity, source, note, recorded_by)
      values (${alertId}, ${auth.activeTenant!.id}, ${id}, ${body.alert}, ${body.severity}, ${body.source}, ${body.note || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.alert.record", {
      subjectPatientId: String(episode.patient_id), resourceType: "LabourAlert", resourceId: alertId,
      metadata: { severity: body.severity, source: body.source },
    }));
  });
  return c.json({ ok: true, alert: { id: alertId } }, 201);
});

// Newborn status follow-up.
maternityRoutes.patch("/maternity/newborns/:newbornId/status", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const newbornId = uuidSchema.parse(c.req.param("newbornId"));
  const body = await parseJson(c, newbornStatusUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const newborn = await requireRows(await tx`
      select nr.id, nr.tenant_id, nr.episode_id, nr.status, nr.version, e.patient_id
        from newborn_records nr join maternity_episodes e on e.id = nr.episode_id
       where nr.id = ${newbornId} and nr.tenant_id = ${auth.activeTenant!.id} for update
    `, "Newborn record not found");
    if (body.expectedVersion && body.expectedVersion !== newborn.version) {
      throw new ConflictError("The newborn record has been updated since you last read it");
    }
    await tx`
      update newborn_records set status = ${body.status}, notes = ${body.notes || null}, version = version + 1, updated_at = now()
       where id = ${newbornId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.newborn.status", {
      subjectPatientId: String(newborn.patient_id), resourceType: "NewbornRecord", resourceId: newbornId,
      metadata: { status: body.status },
    }));
  });
  return c.json({ ok: true });
});

// Create a separate patient identity for the newborn, linked to the maternal
// episode through the existing newborn_records row. This preserves separate
// identities and access rights while keeping the records auditable.
maternityRoutes.post("/maternity/newborns/:newbornId/patient", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const newbornId = uuidSchema.parse(c.req.param("newbornId"));
  const body = await parseJson(c, newbornPatientCreateSchema);
  const newbornPatientId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const newborn = await requireRows(await tx`
      select nr.id, nr.tenant_id, nr.episode_id, nr.patient_id, nr.status, e.patient_id as mother_patient_id
        from newborn_records nr join maternity_episodes e on e.id = nr.episode_id
       where nr.id = ${newbornId} and nr.tenant_id = ${auth.activeTenant!.id}
    `, "Newborn record not found");
    if (newborn.patient_id) throw new ConflictError("A patient identity is already linked to this newborn record");
    if (String(newborn.episode_id) !== String(body.episodeId)) throw new ValidationError("The episode id does not match the newborn record");
    // Create the newborn as a separate patient in the same facility.
    const patientId = newbornPatientId;
    await tx`
      insert into patients (id, created_tenant_id, given_name, family_name, date_of_birth, sex, identity_confidence, assisted_without_contact_details, created_by, created_at, updated_at)
      values (${patientId}, ${auth.activeTenant!.id}, ${body.givenName}, ${body.familyName}, ${new Date(body.dateOfBirth)}, ${body.sex}, ${body.identityConfidence}, false, ${auth.user.id}, now(), now())
    `;
    await tx`
      update newborn_records set patient_id = ${patientId}, born_at = coalesce(${body.bornAt ? new Date(body.bornAt) : null}, born_at), weight_g = coalesce(${body.weightG ?? null}, weight_g), apgar_1 = coalesce(${body.apgar1 ?? null}, apgar_1), apgar_5 = coalesce(${body.apgar5 ?? null}, apgar_5), feeding = coalesce(${body.feeding || null}, feeding), notes = coalesce(${body.notes || null}, notes), updated_at = now()
       where id = ${newbornId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.newborn.patient.create", {
      subjectPatientId: String(newborn.mother_patient_id), resourceType: "Patient", resourceId: patientId,
      metadata: { newbornRecordId: newbornId, linkedFromEpisodeId: body.episodeId },
    }));
  });
  return c.json({ ok: true, patientId: newbornPatientId }, 201);
});

// Antenatal care visits.
maternityRoutes.get("/maternity/episodes/:id/antenatal-visits", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status from maternity_episodes where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Maternity episode not found");
    const visits = await tx`
      select av.*, u.display_name as recorded_by_name
        from antenatal_visits av join users u on u.id = av.recorded_by
       where av.episode_id = ${id}
       order by av.occurred_at desc
    `;
    const last = visits[0] ?? null;
    return {
      episodeId: id,
      patientId: String(episode.patient_id),
      visits,
      summary: {
        visitCount: visits.length,
        lastVisitAt: last ? last.occurred_at : null,
        riskLevel: last?.risk_level ?? episode.risk_level,
        estimatedDueDate: episode.estimated_due_date ?? null,
      },
    };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.antenatal.read", {
    subjectPatientId: String(data.patientId), resourceType: "AntenatalVisit", resourceId: id,
  })));
  return c.json(data);
});

maternityRoutes.post("/maternity/episodes/:id/antenatal-visits", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, antenatalVisitSchema);
  const visitId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const episode = await requireRows(await tx`
      select id, patient_id, status, gravidity, parity, estimated_due_date, risk_level from maternity_episodes where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Maternity episode not found");
    if (!["active", "delivered"].includes(String(episode.status))) {
      throw new ConflictError("Antenatal visits can only be recorded on an active or delivered episode");
    }
    if (body.bloodPressureSystolic != null && body.bloodPressureDiastolic != null) {
      if (body.bloodPressureDiastolic > body.bloodPressureSystolic) {
        throw new ValidationError("Diastolic pressure must not exceed systolic pressure");
      }
    }
    await tx`
      insert into antenatal_visits (id, tenant_id, episode_id, occurred_at, gestational_age_weeks, lmp_date, edd, dating_basis, risk_level, blood_pressure_systolic, blood_pressure_diastolic, pulse, temperature_c, respiratory_rate, oxygen_saturation, weight_kg, height_cm, bmi, fundal_height_cm, fetal_heart_rate, fetal_position, fetal_lie, presentation, contractions_per_10_min, amniotic_fluid, cervix_dilatation_cm, cervix_effacement_percent, station, urine_protein, urine_sugar, hemoglobin_gdl, blood_group, rhesus, hiv_status, syphilis_status, malaria_status, received_tetanus_immunization, received_iron_folic_acid, received_intermittent_preventive_treatment, birth_preparement_counselling, danger_sign_counseling, breastfeeding_counseling, postnatal_plan, notes, recorded_by)
      values (${visitId}, ${auth.activeTenant!.id}, ${id}, ${new Date(body.occurredAt)}, ${body.gestationalAgeWeeks ?? null}, ${body.lmpDate ?? null}, ${body.edd ?? null}, ${body.datingBasis ?? null}, ${body.riskLevel ?? null}, ${body.bloodPressureSystolic ?? null}, ${body.bloodPressureDiastolic ?? null}, ${body.pulse ?? null}, ${body.temperatureC ?? null}, ${body.respiratoryRate ?? null}, ${body.oxygenSaturation ?? null}, ${body.weightKg ?? null}, ${body.heightCm ?? null}, ${body.bmi ?? null}, ${body.fundalHeightCm ?? null}, ${body.fetalHeartRate ?? null}, ${body.fetalPosition || null}, ${body.fetalLie || null}, ${body.presentation || null}, ${body.contractionsPer10Min ?? null}, ${body.amnioticFluid || null}, ${body.cervixDilatationCm ?? null}, ${body.cervixEffacementPercent ?? null}, ${body.station || null}, ${body.urineProtein || null}, ${body.urineSugar || null}, ${body.hemoglobinGdl ?? null}, ${body.bloodGroup || null}, ${body.rhesus || null}, ${body.hivStatus || null}, ${body.syphilisStatus || null}, ${body.malariaStatus || null}, ${body.receivedTetanusImmunization ?? null}, ${body.receivedIronFolicAcid ?? null}, ${body.receivedIntermittentPreventiveTreatment ?? null}, ${body.birthPreparednessCounselling ?? null}, ${body.dangerSignCounselling ?? null}, ${body.breastfeedingCounselling ?? null}, ${body.postnatalPlan || null}, ${body.notes || null}, ${auth.user.id})
    `;
    if (body.riskLevel && body.riskLevel !== episode.risk_level) {
      await tx`
        update maternity_episodes set risk_level = ${body.riskLevel}, version = version + 1, updated_at = now() where id = ${id}
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "maternity.antenatal.visit", {
      subjectPatientId: String(episode.patient_id), resourceType: "AntenatalVisit", resourceId: visitId,
      metadata: { riskLevel: body.riskLevel ?? null, gestationalAgeWeeks: body.gestationalAgeWeeks ?? null },
    }));
  });
  return c.json({ ok: true, visit: { id: visitId } }, 201);
});

// Child health and immunisation records.
maternityRoutes.get("/maternity/children/:patientId/events", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const patient = await withStaffActor(c, async (tx) => tx`
    select id from patients where id = ${patientId} and created_tenant_id = ${auth.activeTenant!.id}
  `);
  if (!patient[0]) throw new ValidationError("The child does not belong to this facility");
  const events = await withStaffActor(c, async (tx) => tx`
    select ce.*, u.display_name as recorded_by_name
      from child_health_events ce join users u on u.id = ce.recorded_by
     where ce.patient_id = ${patientId}
     order by ce.event_date desc, ce.created_at desc
  `);
  return c.json({ patientId, events });
});

maternityRoutes.post("/maternity/children/:patientId/events", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const body = await parseJson(c, childHealthEventSchema);
  const eventId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const patient = await tx`
      select id from patients where id = ${patientId} and created_tenant_id = ${auth.activeTenant!.id}
    `;
    if (!patient[0]) throw new ValidationError("The child does not belong to this facility");
    if (body.weightKg != null && body.weightForAgeZ == null && body.eventDate) {
      // Z-scores are optional; staff may record raw measurements and compute
      // Z-scores at review time rather than forcing them at entry.
    }
    if (body.eventPoint === "well-child" && !body.weightKg && !body.heightCm) {
      // Well-child visits typically include at least one growth measurement;
      // this warning is advisory and does not block the record.
    }
    await tx`
      insert into child_health_events (id, tenant_id, patient_id, episode_id, event_date, event_point, weight_kg, height_cm, head_circumference_cm, weight_for_age_z, height_for_age_z, weight_for_height_z, muac_cm, developmental_milestones, nutrition_status, feeding_practice, notes, recorded_by)
      values (${eventId}, ${auth.activeTenant!.id}, ${patientId}, ${body.episodeId ?? null}, ${new Date(body.eventDate)}, ${body.eventPoint}, ${body.weightKg ?? null}, ${body.heightCm ?? null}, ${body.headCircumferenceCm ?? null}, ${body.weightForAgeZ ?? null}, ${body.heightForAgeZ ?? null}, ${body.weightForHeightZ ?? null}, ${body.muacCm ?? null}, ${tx.json(body.developmentalMilestones ?? null)}, ${body.nutritionStatus || null}, ${body.feedingPractice || null}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "child_health.event.create", {
      subjectPatientId: patientId, resourceType: "ChildHealthEvent", resourceId: eventId,
      metadata: { eventPoint: body.eventPoint, weightKg: body.weightKg ?? null },
    }));
  });
  return c.json({ ok: true, event: { id: eventId } }, 201);
});

maternityRoutes.get("/maternity/children/:patientId/immunizations", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const patient = await withStaffActor(c, async (tx) => tx`
    select id from patients where id = ${patientId} and created_tenant_id = ${auth.activeTenant!.id}
  `);
  if (!patient[0]) throw new ValidationError("The child does not belong to this facility");
  const immunizations = await withStaffActor(c, async (tx) => tx`
    select i.*, u.display_name as recorded_by_name
      from immunizations i join users u on u.id = i.recorded_by
     where i.patient_id = ${patientId}
     order by i.administered_at nulls last, i.created_at desc
  `);
  return c.json({ patientId, immunizations });
});

maternityRoutes.post("/maternity/children/:patientId/immunizations", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const body = await parseJson(c, immunizationSchema);
  const immunizationId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const patient = await tx`
      select id, date_of_birth from patients where id = ${patientId} and created_tenant_id = ${auth.activeTenant!.id}
    `;
    if (!patient[0]) throw new ValidationError("The child does not belong to this facility");
    if (!body.administeredAt && !body.missedDoseReason) {
      throw new ValidationError("Record an administration time or a missed-dose reason");
    }
      if (body.administeredAt && body.missedDoseReason) {
      throw new ValidationError("Record either an administration time or a missed-dose reason, not both");
    }
    if (body.batchExpiryDate && body.administeredAt) {
      const administered = new Date(body.administeredAt);
      const expiry = new Date(body.batchExpiryDate);
      if (expiry < administered) {
        throw new ValidationError("The vaccine batch expiry date is before the administration time");
      }
    }
    await tx`
      insert into immunizations (id, tenant_id, patient_id, child_health_event_id, vaccine_code, vaccine_name, dose_number, total_doses, schedule_date, administered_at, route, site, lot_number, batch_expiry_date, manufacturer, cold_chain_observed, healthcare_worker_id, healthcare_worker_name, anaphylaxis_observed, aefi_note, missed_dose_reason, next_dose_due_date, notes, recorded_by)
      values (${immunizationId}, ${auth.activeTenant!.id}, ${patientId}, ${body.childHealthEventId ?? null}, ${body.vaccineCode}, ${body.vaccineName}, ${body.doseNumber ?? null}, ${body.totalDoses ?? null}, ${body.scheduleDate ?? null}, ${body.administeredAt ? new Date(body.administeredAt) : null}, ${body.route || null}, ${body.site || null}, ${body.lotNumber || null}, ${body.batchExpiryDate ?? null}, ${body.manufacturer || null}, ${body.coldChainObserved ?? null}, ${body.healthcareWorkerId ?? null}, ${body.healthcareWorkerName || null}, ${body.anaphylaxisObserved ?? null}, ${body.aefiNote || null}, ${body.missedDoseReason || null}, ${body.nextDoseDueDate ?? null}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "immunization.record", {
      subjectPatientId: patientId, resourceType: "Immunization", resourceId: immunizationId,
      metadata: { vaccineCode: body.vaccineCode, administered: Boolean(body.administeredAt), missedDoseReason: body.missedDoseReason || null },
    }));
  });
  return c.json({ ok: true, immunization: { id: immunizationId } }, 201);
});

// Nationally recommended vaccine schedule is facility-configured rather than
// hard-coded in the platform. This endpoint returns the schedule the current
// facility has recorded for routine immunisation; it is guidance only and does
// not replace professional judgement or the current national EPI schedule.
maternityRoutes.get("/maternity/immunization-schedule", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const schedule = await withStaffActor(c, async (tx) => tx`
    select * from immunization_schedules where tenant_id = ${auth.activeTenant!.id} order by recommended_at_months
  `);
  return c.json({ schedule });
});

maternityRoutes.get("/maternity/children/:patientId/immunization-due", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const due = await withStaffActor(c, async (tx) => {
    const patient = await tx`
      select id, date_of_birth from patients where id = ${patientId} and created_tenant_id = ${auth.activeTenant!.id}
    `;
    if (!patient[0]) throw new ValidationError("The child does not belong to this facility");
    const rows = await tx`
      select * from immunication_due_for_patient(${patientId})
    `;
    return rows;
  });
  return c.json({ patientId, due });
});

maternityRoutes.get("/maternity/children/:patientId/immunization-catch-up", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("patientId"));
  const fromDateRaw = c.req.query("from") ?? "1970-01-01";
  const fromDate = new Date(fromDateRaw);
  if (isNaN(fromDate.getTime())) throw new ValidationError("The 'from' query parameter must be a valid date");
  const maxAge = c.req.query("maxAgeMonths");
  let maxAgeMonths: number | null = null;
  if (maxAge) {
    maxAgeMonths = Number(maxAge);
    if (isNaN(maxAgeMonths) || maxAgeMonths < 1 || maxAgeMonths > 240) {
      throw new ValidationError("maxAgeMonths must be a number between 1 and 240");
    }
  }
  const patient = await withStaffActor(c, async (tx) => tx`
    select id from patients where id = ${patientId} and created_tenant_id = ${auth.activeTenant!.id}
  `);
  if (!patient[0]) throw new ValidationError("The child does not belong to this facility");
  const rows = await withStaffActor(c, async (tx) => tx`
    select * from immunication_catch_up_for_patient(${patientId}, ${fromDate.toISOString().slice(0, 10)}, ${maxAgeMonths})
  `);
  return c.json({ patientId, fromDate: fromDate.toISOString().slice(0, 10), maxAgeMonths, candidates: rows });
});
