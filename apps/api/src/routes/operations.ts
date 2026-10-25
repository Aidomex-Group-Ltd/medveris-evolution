import { Hono } from "hono";
import {
  bedReadinessSchema,
  cleaningTaskSchema,
  cleaningTransitionSchema,
  cssdCycleSchema,
  cssdReleaseSchema,
  engineeringAssetSchema,
  maintenanceOrderSchema,
  maintenanceTransitionSchema,
  mortuaryCaseSchema,
  mortuaryEffectsSchema,
  mortuaryMovementSchema,
  mortuaryReleaseSchema,
  porterTaskSchema,
  porterTransitionSchema,
  uuidSchema,
} from "@medveris/contracts";
import { canTransitionBed, randomMortuaryReference } from "@medveris/domain";
import { assertMortuaryAccess, assertPorterAccess, assertTechnicalServices } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const operationsRoutes = new Hono<AppEnv>();

type Tx = Parameters<Parameters<typeof withStaffActor>[1]>[0];

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function requireAnyRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): void {
  if (!hasRole(c, ...roles)) throw new ForbiddenError(`This action requires one of: ${roles.join(", ")}`);
}

async function nextMortuaryReference(tx: Tx, tenantId: string): Promise<string> {
  const year = new Date().getFullYear();
  await tx`select pg_advisory_xact_lock(hashtext(${`mortuary:${tenantId}:${year}`}))`;
  const [row] = await tx`
    select count(*)::int as count from mortuary_cases
     where tenant_id = ${tenantId} and case_ref like ${`MOR-${year}-%`}
  `;
  return randomMortuaryReference(Number(row?.count ?? 0) + 1, year);
}

operationsRoutes.get("/operations/beds", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "clinician", "nurse", "facility_admin", "housekeeping", "porter");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select b.id, b.label, b.status, b.status_reason, b.version, w.name as ward_name, w.ward_type,
           (select e.created_at from bed_readiness_events e where e.bed_id = b.id order by e.created_at desc limit 1) as last_change_at,
           (select e.to_status from bed_readiness_events e where e.bed_id = b.id order by e.created_at desc limit 1) as last_change_to
      from beds b join wards w on w.id = b.ward_id
     where b.tenant_id = ${auth.activeTenant!.id}
     order by w.name, b.label
  `);
  return c.json({ beds: rows });
});

operationsRoutes.post("/operations/beds/:id/readiness", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "clinician", "nurse", "facility_admin", "housekeeping");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, bedReadinessSchema);
  await withStaffActor(c, async (tx) => {
    const bed = await requireRows(await tx`
      select id, status, version from beds where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Bed not found");
    if (body.expectedVersion) ensureMatch(body.expectedVersion, Number(bed.version));
    if (!canTransitionBed(String(bed.status) as never, body.status as never)) {
      throw new ConflictError(`Cannot move a bed from ${bed.status} to ${body.status}`);
    }
    if (String(bed.status) === "occupied" && body.status === "vacated") {
      const active = await tx`select 1 from bed_assignments where bed_id = ${id} and released_at is null`;
      if (active[0]) throw new ConflictError("Release the active admission before marking the bed vacated");
    }
    await tx`
      update beds set status = ${body.status}, status_reason = ${body.reason || null}, version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await tx`
      insert into bed_readiness_events (id, tenant_id, bed_id, from_status, to_status, actor_id, cleaning_task_id, note)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${bed.status}, ${body.status}, ${auth.user.id},
        ${body.cleaningTaskId ?? null}, ${body.reason || null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "bed.readiness.update", {
      resourceType: "Bed", resourceId: id, metadata: { from: bed.status, to: body.status, reason: body.reason ?? null },
    }));
  });
  return c.json({ ok: true });
});

operationsRoutes.get("/housekeeping/tasks", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "housekeeping", "facility_admin", "clinician", "nurse", "porter");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select t.id, t.bed_id, t.location_id, t.zone, t.task_type, t.risk_level, t.status, t.instructions,
           t.started_at, t.completed_at, t.verified_at, t.notes, t.created_at,
           b.label as bed_label, w.name as ward_name, u.display_name as assigned_to_name
      from cleaning_tasks t
      left join beds b on b.id = t.bed_id
      left join wards w on w.id = b.ward_id
      left join users u on u.id = t.assigned_to_user_id
     where t.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and t.status = ${status}` : tx``}
     order by t.created_at desc limit 200
  `);
  return c.json({ tasks: rows });
});

operationsRoutes.post("/housekeeping/tasks", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "housekeeping", "facility_admin", "nurse");
  const auth = c.get("auth")!;
  const body = await parseJson(c, cleaningTaskSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.bedId) {
      const bed = await tx`select id, status from beds where id = ${body.bedId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!bed[0]) throw new ValidationError("The selected bed does not exist");
    }
    if (body.assignedToUserId) {
      const member = await tx`
        select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.assignedToUserId} and status = 'active'
      `;
      if (!member[0]) throw new ValidationError("The assignee is not an active facility member");
    }
    await tx`
      insert into cleaning_tasks (id, tenant_id, bed_id, location_id, zone, task_type, risk_level, assigned_to_user_id, instructions, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.bedId ?? null}, ${body.locationId ?? null}, ${body.zone}, ${body.taskType},
        ${body.riskLevel}, ${body.assignedToUserId ?? null}, ${body.instructions || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "housekeeping.task.create", {
      resourceType: "CleaningTask", resourceId: id, metadata: { zone: body.zone, taskType: body.taskType, riskLevel: body.riskLevel },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "housekeeping.task.created", aggregateId: id });
  });
  return c.json({ ok: true, task: { id } }, 201);
});

operationsRoutes.post("/housekeeping/tasks/:id/transition", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "housekeeping", "facility_admin", "nurse");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, cleaningTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const task = await requireRows(await tx`
      select id, status, bed_id, assigned_to_user_id from cleaning_tasks
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Cleaning task not found");
    const from = String(task.status);
    const allowed: Record<string, string[]> = {
      assigned: ["in-progress", "cancelled"],
      "in-progress": ["completed", "cancelled"],
      completed: ["verified"],
      verified: [],
      cancelled: [],
    };
    if (!(allowed[from] ?? []).includes(body.status)) throw new ConflictError(`Cannot move a cleaning task from ${from} to ${body.status}`);
    if (body.status === "verified" && !hasRole(c, "nurse", "facility_admin")) {
      throw new ForbiddenError("Cleaning verification requires a nurse or facility administrator");
    }
    await tx`
      update cleaning_tasks set status = ${body.status},
        started_at = case when ${body.status === "in-progress"} then coalesce(started_at, now()) else started_at end,
        completed_at = case when ${body.status === "completed"} then now() else completed_at end,
        verified_by = case when ${body.status === "verified"} then ${auth.user.id}::uuid else verified_by end,
        verified_at = case when ${body.status === "verified"} then now() else verified_at end,
        notes = ${body.note || null}
       where id = ${id}
    `;
    if (task.bedId) {
      const bed = await tx`select id, status, version from beds where id = ${task.bedId} for update`;
      if (bed[0]) {
        const current = String(bed[0].status);
        const target = body.status === "completed" ? "ready" : body.status === "verified" ? "available" : null;
        if (target && canTransitionBed(current as never, target as never)) {
          await tx`
            update beds set status = ${target}, status_reason = ${null}, version = version + 1, updated_at = now()
             where id = ${task.bedId}
          `;
          await tx`
            insert into bed_readiness_events (id, tenant_id, bed_id, from_status, to_status, actor_id, cleaning_task_id, note)
            values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${task.bedId}, ${current}, ${target}, ${auth.user.id},
              ${id}, ${`Cleaning task ${body.status}`})
          `;
        }
      }
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `housekeeping.task.${body.status}`, {
      resourceType: "CleaningTask", resourceId: id, metadata: { from, to: body.status, note: body.note ?? null },
    }));
  });
  return c.json({ ok: true });
});

operationsRoutes.get("/porter/tasks", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "porter", "nurse", "facility_admin", "clinician");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select t.id, t.request_type, t.patient_id, t.encounter_id, t.from_location, t.to_location, t.status,
           t.identity_checked, t.specimen_custody, t.pickup_at, t.delivered_at, t.delay_reason, t.notes, t.created_at,
           p.public_id, p.given_name, p.family_name, u.display_name as assigned_to_name
      from porter_tasks t
      left join patients p on p.id = t.patient_id
      left join users u on u.id = t.assigned_to_user_id
     where t.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and t.status = ${status}` : tx``}
     order by t.created_at desc limit 200
  `);
  return c.json({ tasks: rows });
});

operationsRoutes.post("/porter/tasks", async (c) => {
  requireStaff(c);
  assertPorterAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, porterTaskSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.patientId) {
      const patient = await tx`select id from patients where id = ${body.patientId} and created_tenant_id = ${auth.activeTenant!.id}`;
      if (!patient[0]) throw new ValidationError("The patient does not belong to this facility");
    }
    if (body.assignedToUserId) {
      const member = await tx`
        select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.assignedToUserId} and status = 'active'
      `;
      if (!member[0]) throw new ValidationError("The assignee is not an active facility member");
    }
    await tx`
      insert into porter_tasks (id, tenant_id, request_type, patient_id, encounter_id, from_location, to_location,
        assigned_to_user_id, requested_by, specimen_custody, notes)
      values (${id}, ${auth.activeTenant!.id}, ${body.requestType}, ${body.patientId ?? null}, ${body.encounterId ?? null},
        ${body.fromLocation}, ${body.toLocation}, ${body.assignedToUserId ?? null}, ${auth.user.id}, ${body.specimenCustody},
        ${body.notes || null})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "porter.task.create", {
      subjectPatientId: body.patientId ?? null, resourceType: "PorterTask", resourceId: id,
      metadata: { requestType: body.requestType, specimenCustody: body.specimenCustody },
    }));
  });
  return c.json({ ok: true, task: { id } }, 201);
});

operationsRoutes.post("/porter/tasks/:id/transition", async (c) => {
  requireStaff(c);
  assertPorterAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, porterTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const task = await requireRows(await tx`
      select id, status, request_type, identity_checked from porter_tasks
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Porter task not found");
    const from = String(task.status);
    const allowed: Record<string, string[]> = {
      requested: ["accepted", "cancelled"],
      accepted: ["in-progress", "cancelled"],
      "in-progress": ["completed", "cancelled"],
      completed: [],
      cancelled: [],
    };
    if (!(allowed[from] ?? []).includes(body.status)) throw new ConflictError(`Cannot move a porter task from ${from} to ${body.status}`);
    const identityChecked = body.identityChecked ?? Boolean(task.identityChecked);
    if (task.requestType === "patient-transfer" && body.status === "completed" && !identityChecked) {
      throw new ConflictError("Patient-transfer completion requires identity verification");
    }
    await tx`
      update porter_tasks set status = ${body.status}, identity_checked = ${identityChecked},
        assigned_to_user_id = case when ${body.status === "accepted"} then ${auth.user.id}::uuid else assigned_to_user_id end,
        pickup_at = case when ${body.status === "in-progress"} then coalesce(pickup_at, now()) else pickup_at end,
        delivered_at = case when ${body.status === "completed"} then now() else delivered_at end,
        delay_reason = ${body.delayReason || null}, notes = ${body.note || null}
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `porter.task.${body.status}`, {
      resourceType: "PorterTask", resourceId: id,
      metadata: { from, to: body.status, identityChecked, delayReason: body.delayReason ?? null },
    }));
  });
  return c.json({ ok: true });
});

operationsRoutes.get("/mortuary/cases", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "mortuary", "facility_admin", "auditor");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select m.id, m.case_ref, m.patient_id, m.deceased_name, m.identity_status, m.received_at, m.received_from,
           m.storage_location, m.status, m.version, m.created_at,
           p.public_id,
           (select count(*)::int from mortuary_movements x where x.case_id = m.id) as movement_count,
           exists (select 1 from mortuary_releases r where r.case_id = m.id) as released
      from mortuary_cases m left join patients p on p.id = m.patient_id
     where m.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and m.status = ${status}` : tx``}
     order by m.received_at desc limit 200
  `);
  return c.json({ cases: rows });
});

operationsRoutes.post("/mortuary/cases", async (c) => {
  requireStaff(c);
  assertMortuaryAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, mortuaryCaseSchema);
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    if (body.patientId) {
      const patient = await tx`select id from patients where id = ${body.patientId} and created_tenant_id = ${auth.activeTenant!.id}`;
      if (!patient[0]) throw new ValidationError("The patient does not belong to this facility");
    }
    if (body.identityStatus === "verified" && !body.patientId) {
      throw new ValidationError("A verified identity requires a linked patient record");
    }
    const caseRef = await nextMortuaryReference(tx, auth.activeTenant!.id);
    await tx`
      insert into mortuary_cases (id, tenant_id, case_ref, patient_id, deceased_name, identity_status, received_from,
        storage_location, death_confirmed_at, death_document_ref, cause_document_ref, notes, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${caseRef}, ${body.patientId ?? null}, ${body.deceasedName}, ${body.identityStatus},
        ${body.receivedFrom}, ${body.storageLocation}, ${body.deathConfirmedAt ? new Date(body.deathConfirmedAt) : null},
        ${body.deathDocumentRef || null}, ${body.causeDocumentRef || null}, ${body.notes || null}, ${auth.user.id})
    `;
    await tx`
      insert into mortuary_movements (id, tenant_id, case_id, movement_type, to_location, identity_checked, verified_by, notes)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, 'receipt', ${body.storageLocation},
        ${body.identityStatus === "verified"}, ${auth.user.id}, ${"Initial receipt"})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "mortuary.case.create", {
      subjectPatientId: body.patientId ?? null, resourceType: "MortuaryCase", resourceId: id,
      metadata: { caseRef, identityStatus: body.identityStatus, storageLocation: body.storageLocation },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "mortuary.case.created", aggregateId: id, payload: { caseRef } });
    return { caseRef };
  });
  return c.json({ ok: true, case: { id, ...result } }, 201);
});

operationsRoutes.get("/mortuary/cases/:id", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "mortuary", "facility_admin", "auditor");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const record = await requireRows(await tx`
      select m.*, p.public_id, p.given_name, p.family_name
        from mortuary_cases m left join patients p on p.id = m.patient_id
       where m.id = ${id} and m.tenant_id = ${auth.activeTenant!.id}
    `, "Mortuary case not found");
    const movements = await tx`
      select x.*, u.display_name as verified_by_name from mortuary_movements x
        join users u on u.id = x.verified_by where x.case_id = ${id} order by x.occurred_at
    `;
    const effects = await tx`select * from mortuary_effects where case_id = ${id} order by created_at`;
    const release = await tx`select * from mortuary_releases where case_id = ${id}`;
    return { case: record, movements, effects, release: release[0] ?? null };
  });
  return c.json(data);
});

operationsRoutes.post("/mortuary/cases/:id/movements", async (c) => {
  requireStaff(c);
  assertMortuaryAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, mortuaryMovementSchema);
  const movementId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const record = await requireRows(await tx`
      select id, status from mortuary_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Mortuary case not found");
    if (record.status === "released" || record.status === "closed") throw new ConflictError("A released or closed case cannot be moved");
    if (!body.identityChecked) throw new ConflictError("Every movement requires identity verification");
    await tx`
      insert into mortuary_movements (id, tenant_id, case_id, movement_type, from_location, to_location, identity_checked, verified_by, witnessed_by, occurred_at, notes)
      values (${movementId}, ${auth.activeTenant!.id}, ${id}, ${body.movementType}, ${body.fromLocation || null}, ${body.toLocation},
        ${body.identityChecked}, ${auth.user.id}, ${body.witnessedBy || null}, ${body.occurredAt ? new Date(body.occurredAt) : new Date()},
        ${body.notes || null})
    `;
    await tx`update mortuary_cases set storage_location = ${body.toLocation}, version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "mortuary.movement.record", {
      resourceType: "MortuaryMovement", resourceId: movementId, metadata: { caseId: id, movementType: body.movementType },
    }));
  });
  return c.json({ ok: true, movement: { id: movementId } }, 201);
});

operationsRoutes.post("/mortuary/cases/:id/effects", async (c) => {
  requireStaff(c);
  assertMortuaryAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, mortuaryEffectsSchema);
  const effectId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const record = await tx`select id from mortuary_cases where id = ${id} and tenant_id = ${auth.activeTenant!.id}`;
    if (!record[0]) throw new NotFoundError("Mortuary case not found");
    await tx`
      insert into mortuary_effects (id, tenant_id, case_id, description, quantity, notes, recorded_by)
      values (${effectId}, ${auth.activeTenant!.id}, ${id}, ${body.description}, ${body.quantity}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "mortuary.effects.record", {
      resourceType: "MortuaryEffects", resourceId: effectId, metadata: { caseId: id },
    }));
  });
  return c.json({ ok: true, effect: { id: effectId } }, 201);
});

operationsRoutes.post("/mortuary/cases/:id/release", async (c) => {
  requireStaff(c);
  assertMortuaryAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, mortuaryReleaseSchema);
  const releaseId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const record = await requireRows(await tx`
      select id, patient_id, identity_status, status from mortuary_cases
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Mortuary case not found");
    if (record.status !== "in-custody") throw new ConflictError("Only a case in custody can be released");
    if (record.identityStatus !== "verified") throw new ConflictError("Identity must be verified before release");
    const verifier = await tx`
      select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.identityVerifiedBy} and status = 'active'
    `;
    if (!verifier[0]) throw new ValidationError("The identity verifier is not an active facility member");
    await tx`
      insert into mortuary_releases (id, tenant_id, case_id, released_to_name, relationship, authority_reference,
        identification_method, identity_verified_by, handover_witness, notes, created_by)
      values (${releaseId}, ${auth.activeTenant!.id}, ${id}, ${body.releasedToName}, ${body.relationship},
        ${body.authorityReference}, ${body.identificationMethod}, ${body.identityVerifiedBy}, ${body.handoverWitness},
        ${body.notes || null}, ${auth.user.id})
    `;
    await tx`update mortuary_cases set status = 'released', version = version + 1, updated_at = now() where id = ${id}`;
    await tx`
      insert into mortuary_movements (id, tenant_id, case_id, movement_type, to_location, identity_checked, verified_by, witnessed_by)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, 'release', ${"Released to family"}, true,
        ${body.identityVerifiedBy}, ${body.handoverWitness})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "mortuary.case.release", {
      subjectPatientId: record.patientId ? String(record.patientId) : null,
      resourceType: "MortuaryRelease", resourceId: releaseId,
      metadata: { caseId: id, relationship: body.relationship, authorityReference: body.authorityReference },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "mortuary.case.released", aggregateId: releaseId });
  });
  return c.json({ ok: true, release: { id: releaseId } }, 201);
});

operationsRoutes.get("/technical/assets", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "biomedical", "facility_admin", "auditor", "cssd");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select a.id, a.asset_ref, a.name, a.category, a.location, a.status, a.next_maintenance_on, a.created_at,
           (select count(*)::int from maintenance_work_orders w where w.asset_id = a.id and w.status not in ('completed','verified','cancelled')) as open_work_orders
      from engineering_assets a where a.tenant_id = ${auth.activeTenant!.id} order by a.name
  `);
  return c.json({ assets: rows });
});

operationsRoutes.post("/technical/assets", async (c) => {
  requireStaff(c);
  assertTechnicalServices(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, engineeringAssetSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into engineering_assets (id, tenant_id, asset_ref, name, category, location, next_maintenance_on, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.assetRef}, ${body.name}, ${body.category}, ${body.location || null},
        ${body.nextMaintenanceOn ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "technical.asset.create", {
      resourceType: "EngineeringAsset", resourceId: id, metadata: { assetRef: body.assetRef, category: body.category },
    }));
  });
  return c.json({ ok: true, asset: { id } }, 201);
});

operationsRoutes.get("/technical/work-orders", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "biomedical", "facility_admin", "auditor", "cssd");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select w.id, w.asset_id, w.fault, w.priority, w.status, w.completed_at, w.release_note, w.created_at,
           a.name as asset_name, a.asset_ref, u.display_name as assigned_to_name
      from maintenance_work_orders w
      join engineering_assets a on a.id = w.asset_id
      left join users u on u.id = w.assigned_to_user_id
     where w.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and w.status = ${status}` : tx``}
     order by w.created_at desc limit 200
  `);
  return c.json({ workOrders: rows });
});

operationsRoutes.post("/technical/work-orders", async (c) => {
  requireStaff(c);
  assertTechnicalServices(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, maintenanceOrderSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const asset = await tx`select id from engineering_assets where id = ${body.assetId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!asset[0]) throw new NotFoundError("Engineering asset not found");
    await tx`
      insert into maintenance_work_orders (id, tenant_id, asset_id, fault, priority, assigned_to_user_id, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.assetId}, ${body.fault}, ${body.priority}, ${body.assignedToUserId ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "technical.work-order.create", {
      resourceType: "MaintenanceWorkOrder", resourceId: id, metadata: { assetId: body.assetId, priority: body.priority },
    }));
  });
  return c.json({ ok: true, workOrder: { id } }, 201);
});

operationsRoutes.post("/technical/work-orders/:id/transition", async (c) => {
  requireStaff(c);
  assertTechnicalServices(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, maintenanceTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select id, status, asset_id from maintenance_work_orders where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Work order not found");
    const from = String(order.status);
    const allowed: Record<string, string[]> = {
      open: ["assigned", "in-progress", "cancelled"],
      assigned: ["in-progress", "cancelled"],
      "in-progress": ["completed", "cancelled"],
      completed: ["verified"],
      verified: [],
      cancelled: [],
    };
    if (!(allowed[from] ?? []).includes(body.status)) throw new ConflictError(`Cannot move a work order from ${from} to ${body.status}`);
    if (body.status === "completed" && !body.releaseNote) throw new ConflictError("A completion note is required");
    await tx`
      update maintenance_work_orders set status = ${body.status},
        assigned_to_user_id = case when ${body.status === "assigned"} then ${auth.user.id}::uuid else assigned_to_user_id end,
        completed_at = case when ${body.status === "completed"} then now() else completed_at end,
        release_note = ${body.releaseNote || null}
       where id = ${id}
    `;
    if (body.status === "completed" || body.status === "cancelled") {
      await tx`update engineering_assets set status = 'in-service' where id = ${order.assetId}`;
    } else if (body.status === "in-progress") {
      await tx`update engineering_assets set status = 'maintenance' where id = ${order.assetId}`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `technical.work-order.${body.status}`, {
      resourceType: "MaintenanceWorkOrder", resourceId: id, metadata: { from, to: body.status, releaseNote: body.releaseNote ?? null },
    }));
  });
  return c.json({ ok: true });
});

operationsRoutes.get("/technical/cssd-cycles", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "cssd", "facility_admin", "auditor");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select c.id, c.sterilizer, c.cycle_ref, c.load_count, c.indicator_result, c.status, c.released_at, c.notes, c.created_at,
           u.display_name as released_by_name
      from cssd_cycles c left join users u on u.id = c.released_by
     where c.tenant_id = ${auth.activeTenant!.id} order by c.created_at desc limit 200
  `);
  return c.json({ cycles: rows });
});

operationsRoutes.post("/technical/cssd-cycles", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "cssd", "facility_admin");
  const auth = c.get("auth")!;
  const body = await parseJson(c, cssdCycleSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into cssd_cycles (id, tenant_id, sterilizer, cycle_ref, load_count, indicator_result, notes, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.sterilizer}, ${body.cycleRef}, ${body.loadCount}, ${body.indicatorResult},
        ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "technical.cssd.cycle.create", {
      resourceType: "CssdCycle", resourceId: id, metadata: { sterilizer: body.sterilizer, indicatorResult: body.indicatorResult },
    }));
  });
  return c.json({ ok: true, cycle: { id } }, 201);
});

operationsRoutes.post("/technical/cssd-cycles/:id/release", async (c) => {
  requireStaff(c);
  requireAnyRole(c, "cssd", "facility_admin");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, cssdReleaseSchema);
  await withStaffActor(c, async (tx) => {
    const cycle = await requireRows(await tx`
      select id, status, indicator_result from cssd_cycles where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "CSSD cycle not found");
    if (cycle.status !== "quarantined") throw new ConflictError("Only a quarantined cycle can be released");
    if (cycle.indicatorResult !== "pass") throw new ConflictError("A passing biological indicator is required before release");
    await tx`
      update cssd_cycles set status = 'released', released_by = ${auth.user.id}, released_at = now(),
        notes = ${body.releaseNote} where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "technical.cssd.cycle.release", {
      resourceType: "CssdCycle", resourceId: id, metadata: { releaseNote: body.releaseNote },
    }));
  });
  return c.json({ ok: true });
});
