import { Hono } from "hono";
import {
  admissionBedSchema,
  admissionSchema,
  admissionTransitionSchema,
  bedSchema,
  bedStatusSchema,
  handoffSchema,
  nursingAssessmentSchema,
  nursingTaskSchema,
  nursingTaskUpdateSchema,
  uuidSchema,
  wardSchema,
} from "@medveris/contracts";
import { assertMembershipAdmin, assertWardAccess } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const inpatientRoutes = new Hono<AppEnv>();

inpatientRoutes.get("/wards", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select w.id, w.name, w.ward_type, w.description, w.status, w.created_at,
      (select count(*)::int from beds b where b.ward_id = w.id) as bed_count,
      (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'available') as available_beds
      from wards w where w.tenant_id = ${auth.activeTenant!.id}
     order by w.name
  `);
  return c.json({ wards: rows });
});

inpatientRoutes.post("/wards", async (c) => {
  requireStaff(c);
  assertMembershipAdmin(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, wardSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into wards (id, tenant_id, name, ward_type, description, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.name}, ${body.wardType}, ${body.description || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ward.create", {
      resourceType: "Ward", resourceId: id, metadata: { wardType: body.wardType },
    }));
  });
  return c.json({ ok: true, ward: { id } }, 201);
});

inpatientRoutes.post("/wards/:id/beds", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const wardId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, bedSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const ward = await tx`select id from wards where id = ${wardId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!ward[0]) throw new NotFoundError("Ward not found");
    await tx`
      insert into beds (id, tenant_id, ward_id, label, features)
      values (${id}, ${auth.activeTenant!.id}, ${wardId}, ${body.label}, ${tx.json(body.features as never)})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "bed.create", {
      resourceType: "Bed", resourceId: id, metadata: { wardId, label: body.label },
    }));
  });
  return c.json({ ok: true, bed: { id } }, 201);
});

inpatientRoutes.get("/beds", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const wardId = c.req.query("wardId");
  const rows = await withStaffActor(c, async (tx) => tx`
    select b.id, b.ward_id, b.label, b.status, b.status_reason, b.version, w.name as ward_name, w.ward_type
      from beds b join wards w on w.id = b.ward_id
     where b.tenant_id = ${auth.activeTenant!.id}
       ${wardId ? tx`and b.ward_id = ${wardId}` : tx``}
     order by w.name, b.label
  `);
  return c.json({ beds: rows });
});

inpatientRoutes.patch("/beds/:id/status", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, bedStatusSchema);
  await withStaffActor(c, async (tx) => {
    const rows = await tx`select id, version, status from beds where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update`;
    const bed = await requireRows(rows, "Bed not found");
    if (body.expectedVersion) ensureMatch(body.expectedVersion, Number(bed.version));
    if (bed.status === "occupied" && body.status !== "occupied") {
      const active = await tx`select 1 from bed_assignments where bed_id = ${id} and released_at is null`;
      if (active.length) throw new ConflictError("Release the active admission before changing an occupied bed");
    }
    await tx`
      update beds set status = ${body.status}, status_reason = ${body.reason || null},
        version = version + 1, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "bed.status.update", {
      resourceType: "Bed", resourceId: id, metadata: { status: body.status, reason: body.reason ?? null },
    }));
  });
  return c.json({ ok: true });
});

inpatientRoutes.get("/admissions", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select a.id, a.patient_id, a.encounter_id, a.ward_type, a.status, a.version, a.reason, a.admitted_at,
           a.discharged_at, p.public_id, p.given_name, p.family_name, u.display_name as attending_name,
           b.label as bed_label, w.name as ward_name
      from admissions a
      join patients p on p.id = a.patient_id
      left join users u on u.id = a.attending_user_id
      left join bed_assignments ba on ba.admission_id = a.id and ba.released_at is null
      left join beds b on b.id = ba.bed_id
      left join wards w on w.id = b.ward_id
     where a.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and a.status = ${status}` : tx``}
     order by a.admitted_at desc limit 200
  `);
  return c.json({ admissions: rows });
});

inpatientRoutes.post("/admissions", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, admissionSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const encounters = await tx`
      select id, patient_id, state from encounters
       where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id} for update
    `;
    const encounter = await requireRows(encounters, "Encounter not found");
    if (String(encounter.patientId) !== body.patientId) throw new ValidationError("Encounter does not belong to the selected patient");
    if (["completed", "cancelled", "entered-in-error"].includes(String(encounter.state))) {
      throw new ConflictError("A closed encounter cannot be admitted");
    }
    const existing = await tx`
      select 1 from admissions where encounter_id = ${body.encounterId}
       and status = 'admitted'
    `;
    if (existing.length) throw new ConflictError("This encounter already has an active admission");
    await tx`
      insert into admissions (id, tenant_id, patient_id, encounter_id, ward_type, attending_user_id, reason, admitted_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId}, ${body.wardType},
        ${body.attendingUserId ?? auth.user.id}, ${body.reason}, ${auth.user.id})
    `;
    await tx`
      update encounters set type = 'inpatient', state = case when state in ('planned','arrived') then 'in-progress' else state end,
        version = version + 1, updated_at = now() where id = ${body.encounterId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "admission.create", {
      subjectPatientId: body.patientId, resourceType: "Admission", resourceId: id,
      metadata: { encounterId: body.encounterId, wardType: body.wardType },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "admission.created", aggregateId: id, payload: { patientId: body.patientId } });
  });
  return c.json({ ok: true, admission: { id } }, 201);
});

inpatientRoutes.get("/admissions/:id", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select a.*, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex
        from admissions a join patients p on p.id = a.patient_id
       where a.id = ${id} and a.tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    const beds = await tx`
      select ba.id, ba.bed_id, ba.assigned_at, ba.released_at, b.label, w.name as ward_name
        from bed_assignments ba join beds b on b.id = ba.bed_id join wards w on w.id = b.ward_id
       where ba.admission_id = ${id} order by ba.assigned_at desc
    `;
    const assessments = await tx`
      select na.*, u.display_name as nurse_name from nursing_assessments na join users u on u.id = na.nurse_user_id
       where na.admission_id = ${id} order by na.created_at desc limit 50
    `;
    const tasks = await tx`
      select nt.*, u.display_name as created_by_name from nursing_tasks nt join users u on u.id = nt.created_by
       where nt.admission_id = ${id} order by nt.status, nt.due_at nulls last, nt.created_at desc
    `;
    const handoffs = await tx`
      select nh.*, f.display_name as from_name, t.display_name as to_name
        from nursing_handoffs nh join users f on f.id = nh.from_user_id join users t on t.id = nh.to_user_id
       where nh.admission_id = ${id} order by nh.created_at desc
    `;
    return { admission, beds, assessments, tasks, handoffs };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "admission.read", {
    subjectPatientId: String(data.admission.patientId), resourceType: "Admission", resourceId: id,
  })));
  return c.json(data);
});

inpatientRoutes.post("/admissions/:id/bed", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, admissionBedSchema);
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status, version from admissions
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Only active admissions can be assigned a bed");
    ensureMatch(body.expectedVersion, Number(admission.version));
    const bed = await requireRows(await tx`
      select id, status from beds where id = ${body.bedId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Bed not found");
    const current = await tx`
      select id, bed_id from bed_assignments where admission_id = ${id} and released_at is null for update
    `;
    if (current[0]?.bedId === body.bedId) throw new ConflictError("The patient is already in this bed");
    if (bed.status !== "available" && current[0]?.bedId !== body.bedId) throw new ConflictError("The selected bed is not available");
    const now = new Date();
    if (current[0]) {
      await tx`update bed_assignments set released_at = ${now}, release_reason = ${body.reason || "transfer"} where id = ${current[0].id}`;
      await tx`update beds set status = 'available', version = version + 1, updated_at = now() where id = ${current[0].bedId}`;
    }
    await tx`
      insert into bed_assignments (id, tenant_id, admission_id, bed_id, assigned_by, assigned_at)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.bedId}, ${auth.user.id}, ${now})
    `;
    await tx`update beds set status = 'occupied', status_reason = null, version = version + 1, updated_at = now() where id = ${body.bedId}`;
    await tx`update admissions set version = version + 1, updated_at = now() where id = ${id}`;
    if (current[0]) {
      await tx`
        insert into bed_transfers (id, tenant_id, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${current[0].bedId}, ${body.bedId}, ${body.reason || "Bed transfer"}, ${auth.user.id})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "admission.bed.assign", {
      subjectPatientId: String(admission.patientId), resourceType: "Admission", resourceId: id,
      metadata: { bedId: body.bedId, transferred: Boolean(current[0]) },
    }));
  });
  return c.json({ ok: true });
});

inpatientRoutes.post("/admissions/:id/transition", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, admissionTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, encounter_id, status, version from admissions
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Only active admissions can be closed");
    ensureMatch(body.expectedVersion, Number(admission.version));
    const now = new Date();
    await tx`
      update admissions set status = ${body.status}, version = version + 1, discharged_at = ${now},
        summary = ${body.summary || null}, disposition_reason = ${body.reason || null}, updated_at = now()
       where id = ${id}
    `;
    const activeBeds = await tx`select id, bed_id from bed_assignments where admission_id = ${id} and released_at is null for update`;
    for (const bed of activeBeds) {
      await tx`update bed_assignments set released_at = ${now}, release_reason = ${`admission-${body.status}`} where id = ${bed.id}`;
      await tx`update beds set status = 'cleaning', version = version + 1, updated_at = now() where id = ${bed.bedId}`;
    }
    if (["discharged", "transferred-out", "cancelled"].includes(body.status)) {
      await tx`update encounters set state = 'completed', closed_at = ${now}, version = version + 1, updated_at = now() where id = ${admission.encounterId} and state not in ('completed','cancelled','entered-in-error')`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `admission.${body.status}`, {
      subjectPatientId: String(admission.patientId), resourceType: "Admission", resourceId: id,
      metadata: { reason: body.reason ?? null, hasSummary: Boolean(body.summary) },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: `admission.${body.status}`, aggregateId: id, payload: { patientId: String(admission.patientId) } });
  });
  return c.json({ ok: true });
});

inpatientRoutes.post("/admissions/:id/assessments", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, nursingAssessmentSchema);
  const assessmentId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Nursing assessments require an active admission");
    await tx`
      insert into nursing_assessments (id, tenant_id, admission_id, patient_id, shift, notes, pain_score, mobility, skin, nurse_user_id)
      values (${assessmentId}, ${auth.activeTenant!.id}, ${id}, ${admission.patientId}, ${body.shift}, ${body.notes},
        ${body.painScore ?? null}, ${body.mobility || null}, ${body.skin || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.assessment.create", {
      subjectPatientId: String(admission.patientId), resourceType: "NursingAssessment", resourceId: assessmentId,
    }));
  });
  return c.json({ ok: true, assessment: { id: assessmentId } }, 201);
});

inpatientRoutes.post("/admissions/:id/tasks", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, nursingTaskSchema);
  const taskId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Nursing tasks require an active admission");
    await tx`
      insert into nursing_tasks (id, tenant_id, admission_id, description, due_at, created_by)
      values (${taskId}, ${auth.activeTenant!.id}, ${id}, ${body.description}, ${body.dueAt ? new Date(body.dueAt) : null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.task.create", {
      subjectPatientId: String(admission.patientId), resourceType: "NursingTask", resourceId: taskId,
    }));
  });
  return c.json({ ok: true, task: { id: taskId } }, 201);
});

inpatientRoutes.patch("/admissions/:id/tasks/:taskId", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const taskId = uuidSchema.parse(c.req.param("taskId"));
  const body = await parseJson(c, nursingTaskUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const task = await requireRows(await tx`
      select nt.id, a.patient_id, nt.status from nursing_tasks nt join admissions a on a.id = nt.admission_id
       where nt.id = ${taskId} and nt.admission_id = ${id} and nt.tenant_id = ${auth.activeTenant!.id} for update
    `, "Nursing task not found");
    if (task.status !== "pending") throw new ConflictError("Only pending tasks can be updated");
    await tx`
      update nursing_tasks set status = ${body.status}, completed_by = ${auth.user.id}, completed_at = now(), note = ${body.note || null}
       where id = ${taskId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.task.complete", {
      subjectPatientId: String(task.patientId), resourceType: "NursingTask", resourceId: taskId,
      metadata: { status: body.status },
    }));
  });
  return c.json({ ok: true });
});

inpatientRoutes.post("/admissions/:id/handoffs", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, handoffSchema);
  const handoffId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Handoffs require an active admission");
    const recipient = await tx`
      select m.user_id from memberships m where m.tenant_id = ${auth.activeTenant!.id} and m.user_id = ${body.toUserId} and m.status = 'active'
    `;
    if (!recipient[0]) throw new ValidationError("The handoff recipient is not an active facility member");
    await tx`
      insert into nursing_handoffs (id, tenant_id, admission_id, from_user_id, to_user_id, summary)
      values (${handoffId}, ${auth.activeTenant!.id}, ${id}, ${auth.user.id}, ${body.toUserId}, ${body.summary})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.handoff.create", {
      subjectPatientId: String(admission.patientId), resourceType: "NursingHandoff", resourceId: handoffId,
      metadata: { toUserId: body.toUserId },
    }));
  });
  return c.json({ ok: true, handoff: { id: handoffId } }, 201);
});
