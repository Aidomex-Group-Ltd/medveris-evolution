import { Hono } from "hono";
import {
  administrationOmissionSchema,
  admissionBedSchema,
  admissionSchema,
  admissionTransitionSchema,
  bedSchema,
  bedStatusSchema,
  fluidBalanceSchema,
  handoffSchema,
  medicationAdministrationSchema,
  medicationScheduleSchema,
  nursingAssessmentSchema,
  nursingTaskAssignSchema,
  nursingTaskEscalateSchema,
  nursingTaskOmitSchema,
  nursingTaskSchema,
  nursingTaskUpdateSchema,
  uuidSchema,
  wardSchema,
  wardUpdateSchema,
} from "@medveris/contracts";
import { assertMembershipAdmin, assertWardAccess, assertWardView } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const inpatientRoutes = new Hono<AppEnv>();

inpatientRoutes.get("/directory/clinical-members", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select u.id, u.display_name, m.roles
      from memberships m join users u on u.id = m.user_id
     where m.tenant_id = ${auth.activeTenant!.id} and m.status = 'active'
       and m.roles && ARRAY['clinician','nurse']::text[]
     order by u.display_name
  `);
  return c.json({ members: rows });
});

inpatientRoutes.get("/wards/dashboard", async (c) => {
  requireStaff(c);
  assertWardView(requestActor(c));
  const auth = c.get("auth")!;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const data = await withStaffActor(c, async (tx) => {
    const wards = await tx`
      select w.id, w.name, w.ward_type, w.status,
        (select count(*)::int from beds b where b.ward_id = w.id) as bed_count,
        (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'available') as available_beds,
        (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'occupied') as occupied_beds,
        (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'reserved') as reserved_beds,
        (select count(*)::int from beds b where b.ward_id = w.id and b.status in ('unavailable','out-of-service')) as unavailable_beds,
        (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'cleaning') as cleaning_beds,
        (select count(*)::int from admissions a where a.tenant_id = ${auth.activeTenant!.id} and a.status = 'admitted'
          and (a.ward_id = w.id or exists (select 1 from bed_assignments ba join beds b on b.id = ba.bed_id where ba.admission_id = a.id and ba.released_at is null and b.ward_id = w.id))) as census,
        (select count(*)::int from admissions a where a.tenant_id = ${auth.activeTenant!.id} and a.admitted_at >= ${since}
          and (a.ward_id = w.id or exists (select 1 from bed_assignments ba join beds b on b.id = ba.bed_id where ba.admission_id = a.id and ba.released_at is null and b.ward_id = w.id))) as admissions_last_24h,
        (select count(*)::int from admissions a where a.tenant_id = ${auth.activeTenant!.id} and a.discharged_at >= ${since}
          and (a.ward_id = w.id or exists (select 1 from bed_assignments ba join beds b on b.id = ba.bed_id where ba.admission_id = a.id and b.ward_id = w.id))) as discharges_last_24h
      from wards w where w.tenant_id = ${auth.activeTenant!.id}
      order by w.name
    `;
    const totals = wards[0] ? {
      totalBeds: wards.reduce((sum: number, w: any) => sum + Number(w.bedCount ?? w.bed_count ?? 0), 0),
      availableBeds: wards.reduce((sum: number, w: any) => sum + Number(w.availableBeds ?? w.available_beds ?? 0), 0),
      occupiedBeds: wards.reduce((sum: number, w: any) => sum + Number(w.occupiedBeds ?? w.occupied_beds ?? 0), 0),
      reservedBeds: wards.reduce((sum: number, w: any) => sum + Number(w.reservedBeds ?? w.reserved_beds ?? 0), 0),
      unavailableBeds: wards.reduce((sum: number, w: any) => sum + Number(w.unavailableBeds ?? w.unavailable_beds ?? 0), 0),
      census: wards.reduce((sum: number, w: any) => sum + Number(w.census ?? 0), 0),
    } : { totalBeds: 0, availableBeds: 0, occupiedBeds: 0, reservedBeds: 0, unavailableBeds: 0, census: 0 };
    const overdueTasks = await tx`
      select count(*)::int as count from nursing_tasks nt
        join admissions a on a.id = nt.admission_id
       where a.tenant_id = ${auth.activeTenant!.id} and a.status = 'admitted'
         and nt.status = 'pending' and nt.due_at is not null and nt.due_at < now()
    `;
    const staffOnDuty = await tx`
      select count(distinct m.user_id)::int as count from memberships m
       where m.tenant_id = ${auth.activeTenant!.id} and m.status = 'active'
         and m.roles && ARRAY['clinician','nurse']::text[]
    `;
    return { wards, totals, overdueTasks: Number(overdueTasks[0]?.count ?? 0), staffOnDuty: Number(staffOnDuty[0]?.count ?? 0) };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "ward.dashboard.read", {
    resourceType: "Ward", resourceId: auth.activeTenant!.id,
  })));
  return c.json(data);
});

inpatientRoutes.get("/wards/:id/capacity", async (c) => {
  requireStaff(c);
  assertWardView(requestActor(c));
  const auth = c.get("auth")!;
  const wardId = uuidSchema.parse(c.req.param("id"));
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const data = await withStaffActor(c, async (tx) => {
    const ward = await requireRows(await tx`
      select id, name, ward_type, status, description from wards where id = ${wardId} and tenant_id = ${auth.activeTenant!.id}
    `, "Ward not found");
    const beds = await tx`
      select status, count(*)::int as count from beds where ward_id = ${wardId} and tenant_id = ${auth.activeTenant!.id} group by status
    `;
    const bedCounts = Object.fromEntries(beds.map((row: any) => [String(row.status), Number(row.count)]));
    const totalBeds = beds.reduce((sum: number, row: any) => sum + Number(row.count), 0);
    const census = await tx`
      select count(*)::int as count from admissions a
       where a.tenant_id = ${auth.activeTenant!.id} and a.status = 'admitted'
         and (a.ward_id = ${wardId} or exists (select 1 from bed_assignments ba join beds b on b.id = ba.bed_id where ba.admission_id = a.id and ba.released_at is null and b.ward_id = ${wardId}))
    `;
    const admissionsLast24h = await tx`
      select count(*)::int as count from admissions
       where tenant_id = ${auth.activeTenant!.id} and admitted_at >= ${since} and ward_id = ${wardId}
    `;
    const dischargesLast24h = await tx`
      select count(*)::int as count from admissions
       where tenant_id = ${auth.activeTenant!.id} and discharged_at >= ${since} and ward_id = ${wardId}
    `;
    const transfersLast24h = await tx`
      select count(*)::int as count from bed_transfers bt
        join admissions a on a.id = bt.admission_id
       where a.tenant_id = ${auth.activeTenant!.id} and bt.created_at >= ${since}
         and (a.ward_id = ${wardId} or bt.to_bed_id in (select id from beds where ward_id = ${wardId}))
    `;
    const overdueTasks = await tx`
      select count(*)::int as count from nursing_tasks nt
        join admissions a on a.id = nt.admission_id
       where a.tenant_id = ${auth.activeTenant!.id} and a.status = 'admitted' and a.ward_id = ${wardId}
         and nt.status = 'pending' and nt.due_at is not null and nt.due_at < now()
    `;
    const awaitingDischarge = await tx`
      select count(*)::int as count from admissions
       where tenant_id = ${auth.activeTenant!.id} and status = 'admitted' and ward_id = ${wardId}
    `;
    return {
      ward,
      capacity: {
        totalBeds,
        availableBeds: bedCounts.available ?? 0,
        occupiedBeds: bedCounts.occupied ?? 0,
        reservedBeds: bedCounts.reserved ?? 0,
        unavailableBeds: (bedCounts.unavailable ?? 0) + (bedCounts["out-of-service"] ?? 0),
        cleaningBeds: bedCounts.cleaning ?? 0,
        occupancyRate: totalBeds > 0 ? Math.round((bedCounts.occupied ?? 0) / totalBeds * 100) / 100 : 0,
      },
      census: Number(census[0]?.count ?? 0),
      admissionsLast24h: Number(admissionsLast24h[0]?.count ?? 0),
      dischargesLast24h: Number(dischargesLast24h[0]?.count ?? 0),
      transfersLast24h: Number(transfersLast24h[0]?.count ?? 0),
      overdueTasks: Number(overdueTasks[0]?.count ?? 0),
      awaitingDischarge: Number(awaitingDischarge[0]?.count ?? 0),
    };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "ward.capacity.read", {
    resourceType: "Ward", resourceId: wardId,
  })));
  return c.json(data);
});

inpatientRoutes.get("/wards", async (c) => {
  requireStaff(c);
  assertWardView(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select w.id, w.name, w.ward_type, w.description, w.status, w.created_at,
      (select count(*)::int from beds b where b.ward_id = w.id) as bed_count,
      (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'available') as available_beds,
      (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'occupied') as occupied_beds,
      (select count(*)::int from beds b where b.ward_id = w.id and b.status = 'reserved') as reserved_beds,
      (select count(*)::int from beds b where b.ward_id = w.id and b.status in ('unavailable','out-of-service')) as unavailable_beds
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

inpatientRoutes.patch("/wards/:id", async (c) => {
  requireStaff(c);
  assertMembershipAdmin(requestActor(c));
  const auth = c.get("auth")!;
  const wardId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, wardUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const ward = await requireRows(await tx`
      select id from wards where id = ${wardId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Ward not found");
    void ward;
    if (body.name !== undefined) await tx`update wards set name = ${body.name} where id = ${wardId}`;
    if (body.status !== undefined) await tx`update wards set status = ${body.status} where id = ${wardId}`;
    if (body.description !== undefined) await tx`update wards set description = ${body.description || null} where id = ${wardId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ward.update", {
      resourceType: "Ward", resourceId: wardId, metadata: body as Record<string, unknown>,
    }));
  });
  return c.json({ ok: true });
});

inpatientRoutes.post("/wards/:id/beds", async (c) => {
  requireStaff(c);
  assertWardView(requestActor(c));
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
  assertWardView(requestActor(c));
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
  assertWardView(requestActor(c));
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
  const wardId = c.req.query("wardId");
  const attendingUserId = c.req.query("attendingUserId");
  const rows = await withStaffActor(c, async (tx) => tx`
    select a.id, a.patient_id, a.encounter_id, a.ward_type, a.ward_id, a.status, a.version, a.reason, a.admitted_at,
           a.discharged_at, p.public_id, p.given_name, p.family_name, u.display_name as attending_name,
           b.label as bed_label, coalesce(wa.name, w.name) as ward_name
      from admissions a
      join patients p on p.id = a.patient_id
      left join users u on u.id = a.attending_user_id
      left join bed_assignments ba on ba.admission_id = a.id and ba.released_at is null
      left join beds b on b.id = ba.bed_id
      left join wards w on w.id = b.ward_id
      left join wards wa on wa.id = a.ward_id
     where a.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and a.status = ${status}` : tx``}
       ${wardId ? tx`and a.ward_id = ${uuidSchema.parse(wardId)}` : tx``}
       ${attendingUserId ? tx`and a.attending_user_id = ${uuidSchema.parse(attendingUserId)}` : tx``}
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
    if (body.wardId) {
      const ward = await tx`select id, ward_type, status from wards where id = ${body.wardId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!ward[0]) throw new NotFoundError("Ward not found");
      const wardType = String((ward[0] as any).wardType ?? (ward[0] as any).ward_type);
      if (wardType !== body.wardType) throw new ValidationError("Ward type does not match the admission ward type");
      if (String(ward[0].status) !== "open") throw new ConflictError("Admissions to a closed ward are not permitted");
    }
    await tx`
      insert into admissions (id, tenant_id, patient_id, encounter_id, ward_type, ward_id, attending_user_id, reason, admitted_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId}, ${body.wardType}, ${body.wardId ?? null},
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
    if (!["available", "reserved"].includes(bed.status) && current[0]?.bedId !== body.bedId) throw new ConflictError("The selected bed is not available");
    const now = new Date();
    if (current[0]) {
      await tx`update bed_assignments set released_at = ${now}, release_reason = ${body.reason || "transfer"} where id = ${current[0].id}`;
      await tx`update beds set status = 'available', version = version + 1, updated_at = now() where id = ${current[0].bedId}`;
    }
    const bedWard = await tx`select ward_id from beds where id = ${body.bedId}`;
    await tx`
      insert into bed_assignments (id, tenant_id, admission_id, bed_id, assigned_by, assigned_at)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.bedId}, ${auth.user.id}, ${now})
    `;
    await tx`update beds set status = 'occupied', status_reason = null, version = version + 1, updated_at = now() where id = ${body.bedId}`;
    await tx`update admissions set version = version + 1, ward_id = ${bedWard[0]?.ward_id ?? null}, updated_at = now() where id = ${id}`;
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

// Fluid balance entries attached to an active admission.
inpatientRoutes.get("/admissions/:id/fluid-balance", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const window = c.req.query("window") ?? "24h";
  const data = await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Fluid balance requires an active admission");
    let since = new Date();
    if (window === "24h") since.setHours(since.getHours() - 24);
    else if (window === "7d") since.setDate(since.getDate() - 7);
    else if (window === "all") since = new Date(0);
    const entries = await tx`
      select fe.*, u.display_name as recorded_by_name
        from fluid_balance_entries fe join users u on u.id = fe.recorded_by
       where fe.admission_id = ${id} and fe.occurred_at >= ${since}
       order by fe.occurred_at desc
    `;
    const totals = await tx`
      select
        coalesce(sum(nullif(fe.intake_ml, null)), 0) as total_intake_ml,
        coalesce(sum(nullif(fe.output_ml, null)), 0) as total_output_ml
        from fluid_balance_entries fe
       where fe.admission_id = ${id} and fe.occurred_at >= ${since}
    `;
    const t = totals[0] ?? { total_intake_ml: 0, total_output_ml: 0 };
    return {
      entries,
      summary: {
        totalIntakeMl: Number(t.total_intake_ml),
        totalOutputMl: Number(t.total_output_ml),
        netBalanceMl: Number(t.total_intake_ml) - Number(t.total_output_ml),
        periodStart: since.toISOString(),
        periodEnd: new Date().toISOString(),
      },
    };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "admission.fluid_balance.read", {
    subjectPatientId: String(data.entries[0]?.patientId ?? ""), resourceType: "FluidBalanceQuery", resourceId: id,
  })));
  return c.json(data);
});

inpatientRoutes.post("/admissions/:id/fluid-balance", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, fluidBalanceSchema);
  const entryId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Fluid balance requires an active admission");
    if (body.intakeMl == null && body.outputMl == null) throw new ValidationError("Record at least one of intake or output");
    await tx`
      insert into fluid_balance_entries (id, tenant_id, admission_id, patient_id, occurred_at, intake_ml, output_ml, source, notes, recorded_by)
      values (${entryId}, ${auth.activeTenant!.id}, ${id}, ${admission.patientId}, ${new Date(body.occurredAt)}, ${body.intakeMl ?? null}, ${body.outputMl ?? null}, ${body.source}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "fluid_balance.create", {
      subjectPatientId: String(admission.patientId), resourceType: "FluidBalanceEntry", resourceId: entryId,
      metadata: { source: body.source, intakeMl: body.intakeMl ?? null, outputMl: body.outputMl ?? null },
    }));
  });
  return c.json({ ok: true, entry: { id: entryId } }, 201);
});

// Nursing task assignment, escalation and omission.
inpatientRoutes.patch("/admissions/:id/tasks/:taskId/assign", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const taskId = uuidSchema.parse(c.req.param("taskId"));
  const body = await parseJson(c, nursingTaskAssignSchema);
  await withStaffActor(c, async (tx) => {
    const task = await requireRows(await tx`
      select nt.id, a.patient_id, nt.status, nt.assigned_to_user_id from nursing_tasks nt join admissions a on a.id = nt.admission_id
       where nt.id = ${taskId} and nt.admission_id = ${id} and nt.tenant_id = ${auth.activeTenant!.id} for update
    `, "Nursing task not found");
    if (!["pending", "in-progress"].includes(task.status)) throw new ConflictError("Only pending or in-progress tasks can be reassigned");
    const member = await tx`
      select m.user_id from memberships m where m.tenant_id = ${auth.activeTenant!.id} and m.user_id = ${body.assignedToUserId} and m.status = 'active'
    `;
    if (!member[0]) throw new ValidationError("The assignee is not an active facility member");
    await tx`
      update nursing_tasks set assigned_to_user_id = ${body.assignedToUserId}, task_type = ${body.taskType || tx`task_type`}, updated_at = now()
       where id = ${taskId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.task.assign", {
      subjectPatientId: String(task.patientId), resourceType: "NursingTask", resourceId: taskId,
      metadata: { assignedToUserId: body.assignedToUserId, taskType: body.taskType ?? null },
    }));
  });
  return c.json({ ok: true });
});

inpatientRoutes.post("/admissions/:id/tasks/:taskId/escalate", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const taskId = uuidSchema.parse(c.req.param("taskId"));
  const body = await parseJson(c, nursingTaskEscalateSchema);
  await withStaffActor(c, async (tx) => {
    const task = await requireRows(await tx`
      select nt.id, a.patient_id, nt.status, nt.escalated_at, nt.escalated_to_user_id from nursing_tasks nt join admissions a on a.id = nt.admission_id
       where nt.id = ${taskId} and nt.admission_id = ${id} and nt.tenant_id = ${auth.activeTenant!.id} for update
    `, "Nursing task not found");
    if (task.status === "completed" || task.status === "cancelled") throw new ConflictError("Completed or cancelled tasks cannot be escalated");
    const member = await tx`
      select m.user_id from memberships m where m.tenant_id = ${auth.activeTenant!.id} and m.user_id = ${body.escalatedToUserId} and m.status = 'active'
    `;
    if (!member[0]) throw new ValidationError("The escalation recipient is not an active facility member");
    await tx`
      update nursing_tasks set escalated_to_user_id = ${body.escalatedToUserId}, escalated_at = now(), omitted_reason = ${body.reason || null} where id = ${taskId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.task.escalate", {
      subjectPatientId: String(task.patientId), resourceType: "NursingTask", resourceId: taskId,
      metadata: { escalatedToUserId: body.escalatedToUserId },
    }));
  });
  return c.json({ ok: true });
});

inpatientRoutes.post("/admissions/:id/tasks/:taskId/omit", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const taskId = uuidSchema.parse(c.req.param("taskId"));
  const body = await parseJson(c, nursingTaskOmitSchema);
  await withStaffActor(c, async (tx) => {
    const task = await requireRows(await tx`
      select nt.id, a.patient_id, nt.status from nursing_tasks nt join admissions a on a.id = nt.admission_id
       where nt.id = ${taskId} and nt.admission_id = ${id} and nt.tenant_id = ${auth.activeTenant!.id} for update
    `, "Nursing task not found");
    if (task.status !== "pending") throw new ConflictError("Only pending tasks can be omitted");
    await tx`
      update nursing_tasks set status = 'completed', completed_by = ${auth.user.id}, completed_at = now(), omitted_reason = ${body.note} where id = ${taskId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "nursing.task.omit", {
      subjectPatientId: String(task.patientId), resourceType: "NursingTask", resourceId: taskId,
      metadata: { omitted: true },
    }));
  });
  return c.json({ ok: true });
});

// Admission transfer history.
inpatientRoutes.get("/admissions/:id/transfers", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    const transfers = await tx`
      select bt.*, b_from.label as from_bed_label, b_to.label as to_bed_label,
             w_from.name as from_ward_name, w_to.name as to_ward_name,
             u.display_name as transferred_by_name
        from bed_transfers bt
        join beds b_from on b_from.id = bt.from_bed_id
        join beds b_to on b_to.id = bt.to_bed_id
        join wards w_from on w_from.id = b_from.ward_id
        join wards w_to on w_to.id = b_to.ward_id
        join users u on u.id = bt.transferred_by
       where bt.admission_id = ${id}
       order by bt.created_at desc
    `;
    return { admissionId: id, patientId: String(admission.patientId), transfers };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "admission.transfers.read", {
    subjectPatientId: String(data.patientId), resourceType: "BedTransfer", resourceId: id,
  })));
  return c.json(data);
});

// eMAR omission capture for a medication administration.
// The medication administration APIs live in apps/api/src/routes/pharmacy.ts;
// this endpoint records the clinical omission reason and prevents silent
// re-administration of the same dose.
inpatientRoutes.post("/admissions/:id/administrations/:administrationId/omit", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const administrationId = uuidSchema.parse(c.req.param("administrationId"));
  const body = await parseJson(c, administrationOmissionSchema);
  await withStaffActor(c, async (tx) => {
    const administration = await requireRows(await tx`
      select ma.id, ma.tenant_id, ma.order_id, ma.status, ma.created_at, p.id as patient_id
        from medication_administrations ma
        join medication_orders mo on mo.id = ma.order_id
        join patients p on p.id = mo.patient_id
       where ma.id = ${administrationId} and ma.tenant_id = ${auth.activeTenant!.id}
    `, "Medication administration not found");
    if (String(administration.tenant_id) !== String(auth.activeTenant!.id)) throw new ValidationError("Unknown administration");
    if (administration.status !== "administered") throw new ConflictError("Only an administered dose can be marked omitted");
    if (String(administration.patient_id) !== c.req.param("id")) {
      // The route key is the admission id; confirm the administration belongs
      // to the same patient as the admission.
      const admission = await tx`
        select id from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id} and patient_id = ${administration.patient_id}
      `;
      if (!admission[0]) throw new NotFoundError("Admission not found");
    }
    if (body.expectedVersion && body.expectedVersion !== administration.created_at.getTime() / 1000) {
      throw new ConflictError("The administration version has changed");
    }
    await tx`
      update medication_administrations set status = 'omitted', reason = ${body.reason}, idempotency_key = ${body.expectedVersion ? String(body.expectedVersion) : null} where id = ${administrationId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "medication.administration.omit", {
      subjectPatientId: String(administration.patient_id), resourceType: "MedicationAdministration", resourceId: administrationId,
      metadata: { omitted: true },
    }));
  });
  return c.json({ ok: true });
});

// Lightweight medication schedule + administration record for the ward eMAR.
// These are convenience endpoints layered on the existing prescribing/administration
// tables so the ward page can record schedule-driven administration without
// rebuilding the pharmacy workflow.
inpatientRoutes.post("/admissions/:id/medication-schedules", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, medicationScheduleSchema);
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status, encounter_id from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Medication schedules require an active admission");
    const medicine = await tx`
      select id from medicines where id = ${body.medicineId} and tenant_id = ${auth.activeTenant!.id}
    `;
    if (!medicine[0]) throw new NotFoundError("Medicine not found");
    const orderId = crypto.randomUUID();
    await tx`
      insert into medication_orders (id, tenant_id, patient_id, encounter_id, medicine_id, dose_text, route, frequency, duration_days, status)
      values (${orderId}, ${auth.activeTenant!.id}, ${admission.patientId}, ${admission.encounter_id}, ${body.medicineId}, ${body.doseText}, ${body.route}, ${body.frequency}, ${body.durationDays ?? null}, 'active')
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "medication.schedule.create", {
      subjectPatientId: String(admission.patientId), resourceType: "MedicationOrder", resourceId: orderId,
      metadata: { medicineId: body.medicineId, route: body.route, frequency: body.frequency },
    }));
    // Return the created order plus a transient schedule id the ward eMAR can reference.
    return c.json({ ok: true, order: { id: orderId, medicineId: body.medicineId } }, 201);
  });
});

inpatientRoutes.post("/admissions/:id/administrations", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, medicationAdministrationSchema);
  const administrationId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const admission = await requireRows(await tx`
      select id, patient_id, status, encounter_id from admissions where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Admission not found");
    if (admission.status !== "admitted") throw new ConflictError("Medication administration requires an active admission");
    let orderId = body.orderId ?? null;
    if (!orderId) {
      // Create an ad-hoc order for schedule-driven administration when the caller
      // supplies a medicine id instead of an existing order id.
      if (!body.medicineId) throw new ValidationError("Provide either an existing order id or a medicine id for ad-hoc administration");
      if (!body.route) throw new ValidationError("Ad-hoc administration requires the administration route");
      const medicine = await tx`
        select id from medicines where id = ${body.medicineId} and tenant_id = ${auth.activeTenant!.id}
      `;
      if (!medicine[0]) throw new NotFoundError("Medicine not found");
      orderId = crypto.randomUUID();
      await tx`
        insert into medication_orders (id, tenant_id, patient_id, encounter_id, medicine_id, dose_text, route, frequency, status)
        values (${orderId}, ${auth.activeTenant!.id}, ${admission.patientId}, ${admission.encounter_id}, ${body.medicineId}, ${body.doseText}, ${body.route}, ${body.frequency ?? 'as-ordered'}, 'active')
      `;
    } else {
      const order = await tx`
        select id, patient_id from medication_orders where id = ${orderId} and tenant_id = ${auth.activeTenant!.id}
      `;
      if (!order[0]) throw new NotFoundError("Medication order not found");
      if (String(order[0].patient_id) !== String(admission.patientId)) throw new ValidationError("The selected order does not belong to this patient");
    }
    const existing = await tx`
      select id from medication_administrations where tenant_id = ${auth.activeTenant!.id} and order_id = ${orderId} and administered_at = ${new Date(body.administeredAt)} and dose_text = ${body.doseText}
    `;
    if (existing.length) throw new ConflictError("A matching administration already exists for this dose and time");
    await tx`
      insert into medication_administrations (id, tenant_id, order_id, dose_text, administered_at, site, notes, status, witnessed_by, idempotency_key)
      values (${administrationId}, ${auth.activeTenant!.id}, ${orderId}, ${body.doseText}, ${new Date(body.administeredAt)}, ${body.site || null}, ${body.notes || null}, ${body.status}, ${body.witnessBy || null}, ${crypto.randomUUID()})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "medication.administration.create", {
      subjectPatientId: String(admission.patientId), resourceType: "MedicationAdministration", resourceId: administrationId,
      metadata: { orderId, status: body.status, doseText: body.doseText },
    }));
  });
  return c.json({ ok: true, administration: { id: administrationId } }, 201);
});
