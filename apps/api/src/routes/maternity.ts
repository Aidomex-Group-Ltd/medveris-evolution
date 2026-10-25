import { Hono } from "hono";
import {
  deliveryRecordSchema,
  labourObservationSchema,
  maternityEpisodeSchema,
  maternityEpisodeUpdateSchema,
  newbornRecordSchema,
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
