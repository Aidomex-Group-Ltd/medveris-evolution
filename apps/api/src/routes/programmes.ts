import { Hono } from "hono";
import {
  advanceCareSchema,
  carePlanSchema,
  carePlanUpdateSchema,
  enrolmentSchema,
  programmeEventSchema,
  programmeSchema,
  publicHealthReleaseSchema,
  publicHealthReportSchema,
  publicHealthReviewSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertProgrammeAccess, assertPublicHealth } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const programmeRoutes = new Hono<AppEnv>();

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

programmeRoutes.get("/programmes", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select p.*, (select count(*)::int from programme_enrolments e where e.programme_id = p.id and e.status = 'active') as active_enrolments
      from programmes p where p.tenant_id = ${auth.activeTenant!.id} order by p.name
  `);
  return c.json({ programmes: rows });
});

programmeRoutes.post("/programmes", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, programmeSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into programmes (id, tenant_id, name, programme_type, description, condition_coding, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.name}, ${body.programmeType}, ${body.description || null},
        ${body.conditionCoding ? tx.json(body.conditionCoding as never) : null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "programme.create", {
      resourceType: "Programme", resourceId: id, metadata: { programmeType: body.programmeType },
    }));
  });
  return c.json({ ok: true, programme: { id } }, 201);
});

programmeRoutes.get("/programmes/:id/enrolments", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const rows = await withStaffActor(c, async (tx) => tx`
    select e.*, p.public_id, p.given_name, p.family_name,
           (select cp.version from care_plans cp where cp.enrolment_id = e.id order by cp.version desc limit 1) as latest_care_plan_version
      from programme_enrolments e join patients p on p.id = e.patient_id
     where e.programme_id = ${id} and e.tenant_id = ${auth.activeTenant!.id}
     order by e.created_at desc
  `);
  return c.json({ enrolments: rows });
});

programmeRoutes.post("/programmes/:id/enrolments", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const programmeId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, enrolmentSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const programme = await tx`select 1 from programmes where id = ${programmeId} and tenant_id = ${auth.activeTenant!.id} and active`;
    if (!programme[0]) throw new ValidationError("The programme is not active at this facility");
    const linked = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${body.patientId}`;
    if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
    await tx`
      insert into programme_enrolments (id, tenant_id, patient_id, programme_id, notes, enrolled_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${programmeId}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "programme.enrol", {
      subjectPatientId: body.patientId, resourceType: "ProgrammeEnrolment", resourceId: id,
      metadata: { programmeId },
    }));
  });
  return c.json({ ok: true, enrolment: { id } }, 201);
});

programmeRoutes.post("/enrolments/:id/care-plans", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const enrolmentId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, carePlanSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const enrolment = await requireRows(await tx`
      select id, patient_id, status from programme_enrolments
       where id = ${enrolmentId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Programme enrolment not found");
    if (enrolment.status !== "active") throw new ConflictError("Care plans require an active enrolment");
    const existing = await tx`select 1 from care_plans where enrolment_id = ${enrolmentId}`;
    if (existing[0]) throw new ConflictError("A care plan already exists; update the current plan instead");
    const content = { goals: body.goals, interventions: body.interventions, reviewDue: body.reviewDue ?? null };
    await tx`
      insert into care_plans (id, tenant_id, patient_id, enrolment_id, goals, interventions, review_due, authored_by)
      values (${id}, ${auth.activeTenant!.id}, ${enrolment.patientId}, ${enrolmentId}, ${tx.json(body.goals as never)},
        ${body.interventions}, ${body.reviewDue ?? null}, ${auth.user.id})
    `;
    await tx`
      insert into care_plan_versions (id, tenant_id, care_plan_id, version, content, change_note, author_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, 1, ${tx.json(content as never)}, ${body.changeNote}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care-plan.create", {
      subjectPatientId: String(enrolment.patientId), resourceType: "CarePlan", resourceId: id,
    }));
  });
  return c.json({ ok: true, carePlan: { id } }, 201);
});

programmeRoutes.put("/care-plans/:id", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, carePlanUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const plan = await requireRows(await tx`
      select id, patient_id, version from care_plans where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Care plan not found");
    ensureMatch(body.expectedVersion, Number(plan.version));
    const version = Number(plan.version) + 1;
    const content = { goals: body.goals, interventions: body.interventions, reviewDue: body.reviewDue ?? null, changeNote: body.changeNote };
    await tx`
      update care_plans set goals = ${tx.json(body.goals as never)}, interventions = ${body.interventions},
        review_due = ${body.reviewDue ?? null}, version = ${version}, updated_at = now() where id = ${id}
    `;
    await tx`
      insert into care_plan_versions (id, tenant_id, care_plan_id, version, content, change_note, author_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${version}, ${tx.json(content as never)}, ${body.changeNote}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "care-plan.update", {
      subjectPatientId: String(plan.patientId), resourceType: "CarePlan", resourceId: id, metadata: { version },
    }));
  });
  return c.json({ ok: true });
});

programmeRoutes.post("/enrolments/:id/events", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const enrolmentId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, programmeEventSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const enrolment = await requireRows(await tx`
      select id, patient_id, programme_id, status from programme_enrolments
       where id = ${enrolmentId} and tenant_id = ${auth.activeTenant!.id}
    `, "Programme enrolment not found");
    if (enrolment.status !== "active") throw new ConflictError("Programme events require an active enrolment");
    await tx`
      insert into programme_events (id, tenant_id, patient_id, programme_id, enrolment_id, event_type, details, occurred_at, coding, recorded_by)
      values (${id}, ${auth.activeTenant!.id}, ${enrolment.patientId}, ${enrolment.programmeId}, ${enrolmentId},
        ${body.eventType}, ${body.details}, ${new Date(body.occurredAt)},
        ${body.coding ? tx.json(body.coding as never) : null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "programme.event.create", {
      subjectPatientId: String(enrolment.patientId), resourceType: "ProgrammeEvent", resourceId: id,
      metadata: { eventType: body.eventType, programmeId: enrolment.programmeId },
    }));
  });
  return c.json({ ok: true, event: { id } }, 201);
});

programmeRoutes.get("/patients/:id/programmes", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("id"));
  const linked = await withStaffActor(c, async (tx) => tx`
    select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${patientId}
  `);
  if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
  const data = await withStaffActor(c, async (tx) => {
    const enrolments = await tx`
      select e.*, p.name as programme_name, p.programme_type
        from programme_enrolments e join programmes p on p.id = e.programme_id
       where e.patient_id = ${patientId} and e.tenant_id = ${auth.activeTenant!.id} order by e.created_at desc
    `;
    const events = await tx`
      select * from programme_events where patient_id = ${patientId} and tenant_id = ${auth.activeTenant!.id} order by occurred_at desc
    `;
    const carePlans = await tx`
      select * from care_plans where patient_id = ${patientId} and tenant_id = ${auth.activeTenant!.id} order by created_at desc
    `;
    const advanceCare = await tx`
      select * from advance_care_documents where patient_id = ${patientId} and tenant_id = ${auth.activeTenant!.id} order by created_at desc
    `;
    return { enrolments, events, carePlans, advanceCare };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "programme.patient.read", {
    subjectPatientId: patientId, resourceType: "ProgrammeSummary", resourceId: patientId,
  })));
  return c.json(data);
});

programmeRoutes.post("/patients/:id/advance-care", async (c) => {
  requireStaff(c);
  assertProgrammeAccess(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, advanceCareSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const linked = await tx`select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${patientId}`;
    if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
    await tx`
      insert into advance_care_documents (id, tenant_id, patient_id, document_type, content, witnessed_by, recorded_by)
      values (${id}, ${auth.activeTenant!.id}, ${patientId}, ${body.documentType}, ${body.content}, ${body.witnessedBy || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "advance-care.create", {
      subjectPatientId: patientId, resourceType: "AdvanceCareDocument", resourceId: id,
      metadata: { documentType: body.documentType },
    }));
  });
  return c.json({ ok: true, document: { id } }, 201);
});

// Aggregate-only statutory reporting. Identifiable rows never leave this route.
programmeRoutes.post("/public-health/reports", async (c) => {
  requireStaff(c);
  assertPublicHealth(requestActor(c));
  if (!hasRole(c, "public_health", "facility_admin")) throw new ForbiddenError("Public-health reporting permission is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, publicHealthReportSchema);
  if (body.periodEnd < body.periodStart) throw new ValidationError("The reporting period end must follow the start");
  const reportId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.programmeId) {
      const programme = await tx`select 1 from programmes where id = ${body.programmeId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!programme[0]) throw new ValidationError("The selected programme does not exist");
    }
    const conditions = await tx`
      select p.sex, (date_part('year', age(current_date, p.date_of_birth)))::int as age
        from conditions c join patients p on p.id = c.patient_id
       where c.tenant_id = ${auth.activeTenant!.id}
         and c.recorded_at >= ${body.periodStart}::date and c.recorded_at < (${body.periodEnd}::date + interval '1 day')
         ${body.conditionSystem ? tx`and c.snomed_system = ${body.conditionSystem}` : tx``}
         ${body.conditionCode ? tx`and c.snomed_code = ${body.conditionCode}` : tx``}
         ${body.programmeId ? tx`and exists (select 1 from programme_enrolments e where e.patient_id = c.patient_id and e.programme_id = ${body.programmeId} and e.status <> 'withdrawn')` : tx``}
         ${body.ageMin != null ? tx`and date_part('year', age(current_date, p.date_of_birth)) >= ${body.ageMin}` : tx``}
         ${body.ageMax != null ? tx`and date_part('year', age(current_date, p.date_of_birth)) <= ${body.ageMax}` : tx``}
    `;
    const minCell = body.minCell;
    const total = conditions.length;
    const band = (age: number) => age < 5 ? "0-4" : age < 15 ? "5-14" : age < 25 ? "15-24" : age < 35 ? "25-34" : age < 45 ? "35-44" : age < 55 ? "45-54" : age < 65 ? "55-64" : "65+";
    const bySex = new Map<string, number>();
    const byAgeBand = new Map<string, number>();
    for (const row of conditions) {
      const sex = String(row.sex ?? "unknown");
      const ageBand = band(Number(row.age ?? 0));
      bySex.set(sex, (bySex.get(sex) ?? 0) + 1);
      byAgeBand.set(ageBand, (byAgeBand.get(ageBand) ?? 0) + 1);
    }
    const suppress = (value: number) => value > 0 && value < minCell ? null : value;
    const aggregate = {
      total: suppress(total),
      suppressedCells: Array.from(byAgeBand.values()).filter((value) => value > 0 && value < minCell).length,
      bySex: Array.from(bySex.entries()).map(([key, value]) => ({ key, count: suppress(value) })),
      byAgeBand: ["0-4", "5-14", "15-24", "25-34", "35-44", "45-54", "55-64", "65+"].map((key) => ({ key, count: suppress(byAgeBand.get(key) ?? 0) })),
      caseDefinitionVersion: body.caseDefinitionVersion,
      minCell,
      generatedAt: new Date().toISOString(),
    };
    await tx`
      insert into public_health_reports (id, tenant_id, programme_id, title, period_start, period_end, condition_system, condition_code,
        age_min, age_max, case_definition_version, min_cell, aggregate, created_by)
      values (${reportId}, ${auth.activeTenant!.id}, ${body.programmeId ?? null}, ${body.title}, ${body.periodStart}, ${body.periodEnd},
        ${body.conditionSystem || null}, ${body.conditionCode || null}, ${body.ageMin ?? null}, ${body.ageMax ?? null},
        ${body.caseDefinitionVersion}, ${body.minCell}, ${tx.json(aggregate as never)}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "public-health.report.create", {
      resourceType: "PublicHealthReport", resourceId: reportId,
      metadata: { programmeId: body.programmeId ?? null, conditionCode: body.conditionCode ?? null, totalSuppressed: aggregate.total == null },
    }));
  });
  return c.json({ ok: true, report: { id: reportId } }, 201);
});

programmeRoutes.get("/public-health/reports", async (c) => {
  requireStaff(c);
  assertPublicHealth(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select r.id, r.title, r.programme_id, r.period_start, r.period_end, r.condition_code, r.case_definition_version,
           r.min_cell, r.status, r.version, r.aggregate, r.created_at, r.reviewed_at, r.released_at, r.released_to,
           p.name as programme_name, u.display_name as created_by_name
      from public_health_reports r left join programmes p on p.id = r.programme_id left join users u on u.id = r.created_by
     where r.tenant_id = ${auth.activeTenant!.id} order by r.created_at desc
  `);
  return c.json({ reports: rows });
});

programmeRoutes.post("/public-health/reports/:id/review", async (c) => {
  requireStaff(c);
  assertPublicHealth(requestActor(c));
  if (!hasRole(c, "public_health", "facility_admin")) throw new ForbiddenError("Public-health reporting permission is required");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, publicHealthReviewSchema);
  await withStaffActor(c, async (tx) => {
    const report = await requireRows(await tx`
      select id, status, version from public_health_reports where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Public-health report not found");
    ensureMatch(body.expectedVersion, Number(report.version));
    if (report.status !== "draft") throw new ConflictError("Only draft reports can be reviewed");
    await tx`
      update public_health_reports set status = ${body.decision}, version = version + 1, reviewed_by = ${auth.user.id},
        reviewed_at = now(), review_note = ${body.note} where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `public-health.report.${body.decision}`, {
      resourceType: "PublicHealthReport", resourceId: id, metadata: { note: body.note },
    }));
  });
  return c.json({ ok: true });
});

programmeRoutes.post("/public-health/reports/:id/release", async (c) => {
  requireStaff(c);
  assertPublicHealth(requestActor(c));
  if (!hasRole(c, "public_health", "facility_admin")) throw new ForbiddenError("Public-health reporting permission is required");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, publicHealthReleaseSchema);
  const disclosureId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const report = await requireRows(await tx`
      select id, status from public_health_reports where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Public-health report not found");
    if (report.status !== "reviewed") throw new ConflictError("Only reviewed reports can be released");
    await tx`
      insert into public_health_disclosures (id, tenant_id, report_id, recipient, purpose, note, disclosed_by)
      values (${disclosureId}, ${auth.activeTenant!.id}, ${id}, ${body.recipient}, ${body.purpose}, ${body.note || null}, ${auth.user.id})
    `;
    await tx`
      update public_health_reports set status = 'released', version = version + 1, released_to = ${body.recipient},
        released_at = now(), release_purpose = ${body.purpose} where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "public-health.report.release", {
      resourceType: "PublicHealthReport", resourceId: id,
      metadata: { recipient: body.recipient, purpose: body.purpose, disclosureId },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "public-health.report.released", aggregateId: id, payload: { recipient: body.recipient } });
  });
  return c.json({ ok: true, disclosure: { id: disclosureId } }, 201);
});
