import { Hono, type Context } from "hono";
import {
  radiologyAcknowledgeSchema,
  radiologyAcquisitionSchema,
  radiologyAddendumSchema,
  radiologyCorrectionSchema,
  radiologyCriticalSchema,
  radiologyDraftSchema,
  radiologyEscalateSchema,
  radiologyReleaseSchema,
  radiologyReportCreateSchema,
  radiologySignSchema,
  radiologyStudySchema,
  radiologyTemplateApprovalSchema,
  radiologyWorklistSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertDiagnostics, permissionsForRoles, type Permission } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import {
  RADIOLOGY_CATALOGUE_VERSION,
  RADIOLOGY_TEMPLATE_CATALOGUE,
  canTransitionRadiologyReport,
  checkRadiologyContent,
  configureRadiologyTemplate,
  contentDigest,
  radiologyAccession,
  radiologyTemplate,
  type RadiologyReportContent,
  type RadiologyReportStatus,
  type RadiologyTemplateDefinition,
} from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import { ensureMatch, parseJson, parseQuery } from "../lib/http.js";
import { uniqueViolation } from "../lib/idempotency.js";
import { integrationStatus } from "../integrations/registry.js";
import type { AppEnv } from "../types.js";

export const radiologyRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

function can(c: C, permission: Permission): boolean {
  return permissionsForRoles(requestActor(c).roles).has(permission);
}

function requirePermission(c: C, permission: Permission, message: string): void {
  if (!can(c, permission)) throw new ForbiddenError(message);
}

function staff(c: C) {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  return { auth, tenantId: auth.activeTenant!.id, config: c.get("deps").config };
}

function definitionOf(row: Record<string, unknown>): RadiologyTemplateDefinition {
  return row.definition as RadiologyTemplateDefinition;
}

function contentProblems(definition: RadiologyTemplateDefinition, content: RadiologyReportContent, signing: boolean): void {
  const problems = checkRadiologyContent(definition, content);
  if (problems.invalid.length) throw new ValidationError("The report content does not match its template", problems.invalid.map((message) => ({ path: "content", message })));
  if (signing && problems.missing.length) {
    throw new ValidationError("Required report sections are incomplete", problems.missing.map((label) => ({ path: "content", message: `${label} is required` })));
  }
}

function imagesState(c: C) {
  const status = integrationStatus(c.get("deps").config, "dicomweb");
  return { state: status.state, reason: status.reason, available: status.state === "available" };
}

async function lockReport(tx: Tx, tenantId: string, id: string) {
  return requireRows(await tx`
    select r.*, t.definition, t.version as template_version, t.name as template_name
      from radiology_reports r join radiology_templates t on t.id = r.template_id
     where r.id = ${id} and r.tenant_id = ${tenantId} for update of r
  `, "Radiology report not found");
}

// ---------------------------------------------------------------- templates

radiologyRoutes.get("/radiology/catalogue", async (c) => {
  const { tenantId } = staff(c);
  const approved = await withStaffActor(c, async (tx) => tx`
    select code, version, approved_at, approved_by from radiology_templates where tenant_id = ${tenantId} and status = 'approved'
  `);
  const byCode = new Map(approved.map((row) => [String(row.code), row]));
  return c.json({
    catalogueVersion: RADIOLOGY_CATALOGUE_VERSION,
    templates: RADIOLOGY_TEMPLATE_CATALOGUE.map((definition) => ({
      ...definition,
      facilityApproval: byCode.get(definition.code) ?? null,
    })),
    notice: "Catalogue templates are structures only. A radiologist must approve each one before it can be used.",
  });
});

radiologyRoutes.get("/radiology/templates", async (c) => {
  const { tenantId } = staff(c);
  const rows = await withStaffActor(c, async (tx) => tx`
    select t.id, t.code, t.version, t.catalogue_version, t.name, t.modality, t.body_region, t.definition, t.approved_at,
           t.approval_note, u.display_name as approved_by_name
      from radiology_templates t join users u on u.id = t.approved_by
     where t.tenant_id = ${tenantId} and t.status = 'approved'
     order by t.modality, t.name
  `);
  return c.json({ templates: rows });
});

radiologyRoutes.post("/radiology/templates", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.template.manage", "Only a radiologist can approve report templates");
  const body = await parseJson(c, radiologyTemplateApprovalSchema);
  const base = radiologyTemplate(body.code);
  if (!base) throw new ValidationError(`Unknown catalogue template ${body.code}`);
  let definition: RadiologyTemplateDefinition;
  try {
    definition = configureRadiologyTemplate(base, body.requiredFields);
  } catch (error) {
    throw new ValidationError((error as Error).message);
  }
  const id = crypto.randomUUID();
  const version = await withStaffActor(c, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`radiology-template:${tenantId}:${body.code}`}))`;
    const [latest] = await tx`select max(version)::int as version from radiology_templates where tenant_id = ${tenantId} and code = ${body.code}`;
    const next = Number(latest?.version ?? 0) + 1;
    await tx`update radiology_templates set status = 'retired', retired_at = now() where tenant_id = ${tenantId} and code = ${body.code} and status = 'approved'`;
    await tx`
      insert into radiology_templates (id, tenant_id, code, catalogue_version, version, name, modality, body_region, definition, approved_by, approval_note)
      values (${id}, ${tenantId}, ${definition.code}, ${RADIOLOGY_CATALOGUE_VERSION}, ${next}, ${definition.name}, ${definition.modality},
        ${definition.bodyRegion}, ${tx.json(definition as never)}, ${auth.user.id}, ${body.approvalNote})
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.template.approve", {
      resourceType: "RadiologyTemplate", resourceId: id,
      metadata: { code: body.code, version: next, catalogueVersion: RADIOLOGY_CATALOGUE_VERSION },
    }));
    return next;
  });
  return c.json({ ok: true, template: { id, code: body.code, version } }, 201);
});

// ---------------------------------------------------------------- studies

radiologyRoutes.post("/radiology/studies", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.study.register", "Study registration requires a radiographer or radiologist");
  const body = await parseJson(c, radiologyStudySchema);
  const id = crypto.randomUUID();
  const scheduled = Boolean(body.scheduledAt && new Date(body.scheduledAt).getTime() > Date.now());
  let accession = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    accession = radiologyAccession(auth.activeTenant!.slug);
    try {
      await withStaffActor(c, async (tx) => {
        const item = await requireRows(await tx`
          select i.id, i.status, o.order_type, o.patient_id from service_order_items i join service_orders o on o.id = i.order_id
           where i.id = ${body.orderItemId} and i.tenant_id = ${tenantId} for update of i
        `, "Imaging order item not found");
        if (item.orderType !== "imaging") throw new ValidationError("Studies can only be registered for imaging orders");
        if (item.status === "cancelled") throw new ConflictError("The imaging order was cancelled");
        const existing = await tx`select 1 from imaging_studies where order_item_id = ${body.orderItemId} and acquisition_status <> 'cancelled'`;
        if (existing.length) throw new ConflictError("This order item already has a registered study");
        await tx`
          insert into imaging_studies (id, tenant_id, order_item_id, modality, body_site, accession, pacs_state, acquisition_status,
            scheduled_at, protocol, preparation_notes, created_by)
          values (${id}, ${tenantId}, ${body.orderItemId}, ${body.modality}, ${body.bodySite}, ${accession}, 'not-configured',
            ${scheduled ? "scheduled" : "registered"}, ${body.scheduledAt ? new Date(body.scheduledAt) : null},
            ${body.protocol || null}, ${body.preparationNotes || null}, ${auth.user.id})
        `;
        await tx`update service_order_items set status = 'in-progress' where id = ${body.orderItemId} and status = 'ordered'`;
        await writeAudit(tx, config, requestAudit(c, "radiology.study.register", {
          subjectPatientId: String(item.patientId), resourceType: "ImagingStudy", resourceId: id,
          metadata: { accession, modality: body.modality, scheduled },
        }));
      });
      return c.json({ ok: true, study: { id, accession, acquisitionStatus: scheduled ? "scheduled" : "registered" } }, 201);
    } catch (error) {
      if (uniqueViolation(error) !== "imaging_studies_accession") throw error;
    }
  }
  throw new ConflictError("Could not allocate a unique accession number; retry the registration");
});

radiologyRoutes.post("/radiology/studies/:id/acquisition", async (c) => {
  const { tenantId, config } = staff(c);
  requirePermission(c, "radiology.study.register", "Acquisition status requires a radiographer or radiologist");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyAcquisitionSchema);
  const FLOW: Record<string, string[]> = {
    scheduled: ["registered", "acquired", "cancelled"],
    registered: ["acquired", "incomplete", "cancelled"],
    incomplete: ["acquired", "cancelled"],
    acquired: ["incomplete"],
    cancelled: [],
  };
  await withStaffActor(c, async (tx) => {
    const study = await requireRows(await tx`
      select s.id, s.acquisition_status, s.version, o.patient_id
        from imaging_studies s join service_order_items i on i.id = s.order_item_id join service_orders o on o.id = i.order_id
       where s.id = ${id} and s.tenant_id = ${tenantId} for update of s
    `, "Imaging study not found");
    ensureMatch(body.expectedVersion, Number(study.version));
    if (!(FLOW[String(study.acquisitionStatus)] ?? []).includes(body.status)) {
      throw new ConflictError(`Cannot move a study from ${study.acquisitionStatus} to ${body.status}`);
    }
    const signed = await tx`select 1 from radiology_reports where study_id = ${id} and status in ('final', 'corrected')`;
    if (signed.length) throw new ConflictError("The study has a signed report; its acquisition status can no longer change");
    await tx`
      update imaging_studies set acquisition_status = ${body.status}, version = version + 1, updated_at = now(),
        acquired_at = case when ${body.status} = 'acquired' then now() else acquired_at end,
        reconciliation_note = coalesce(${body.note || null}, reconciliation_note)
       where id = ${id}
    `;
    await writeAudit(tx, config, requestAudit(c, `radiology.study.${body.status}`, {
      subjectPatientId: String(study.patientId), resourceType: "ImagingStudy", resourceId: id,
      metadata: { from: study.acquisitionStatus, note: body.note || null },
    }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- worklist

radiologyRoutes.get("/radiology/worklist", async (c) => {
  const { tenantId } = staff(c);
  const query = parseQuery(c, radiologyWorklistSchema);
  const rows = await withStaffActor(c, async (tx) => tx`
    with items as (
      select i.id as order_item_id, i.name as examination, o.id as order_id, o.priority, o.created_at as ordered_at,
             o.clinical_note, o.patient_id, p.public_id, p.given_name, p.family_name,
             s.id as study_id, s.accession, s.modality, s.body_site, s.acquisition_status, s.scheduled_at, s.acquired_at, s.version as study_version,
             r.id as report_id, r.status as report_status, r.urgency, r.draft_version, r.signed_at, r.released_at,
             r.reporting_radiologist_id, ru.display_name as radiologist_name,
             case
               when s.id is null then 'awaiting-study'
               when s.acquisition_status in ('scheduled', 'registered', 'incomplete') then 'awaiting-acquisition'
               when r.id is null then 'awaiting-report'
               when r.status in ('final', 'corrected') and r.released_at is not null then 'released'
               when r.status in ('final', 'corrected') then 'signed'
               else r.status
             end as stage,
             (select count(*)::int from radiology_critical_communications cc where cc.report_id = r.id and cc.acknowledged_at is null) as open_critical
        from service_order_items i
        join service_orders o on o.id = i.order_id
        join patients p on p.id = o.patient_id
        left join imaging_studies s on s.order_item_id = i.id and s.acquisition_status <> 'cancelled'
        left join radiology_reports r on r.study_id = s.id and r.status <> 'cancelled'
        left join users ru on ru.id = r.reporting_radiologist_id
       where i.tenant_id = ${tenantId} and o.order_type = 'imaging' and i.status <> 'cancelled' and o.status <> 'cancelled'
    )
    select *,
           round(extract(epoch from (coalesce(signed_at, now()) - ordered_at)) / 60)::int as minutes_order_to_sign,
           case when acquired_at is not null then round(extract(epoch from (coalesce(signed_at, now()) - acquired_at)) / 60)::int end as minutes_acquired_to_sign
      from items
     where (${query.status} = 'all' or stage = ${query.status})
       and (${query.modality ?? null}::text is null or modality = ${query.modality ?? null}::text)
       and (${query.priority ?? null}::text is null or priority = ${query.priority ?? null}::text)
       and (${query.radiologistId ?? null}::uuid is null or reporting_radiologist_id = ${query.radiologistId ?? null}::uuid)
     order by case priority when 'emergency' then 0 when 'urgent' then 1 else 2 end, ordered_at
     limit ${query.limit + 1} offset ${query.offset}
  `);
  return c.json({ items: rows.slice(0, query.limit), hasMore: rows.length > query.limit, limit: query.limit, offset: query.offset });
});

// ---------------------------------------------------------------- reports

radiologyRoutes.post("/radiology/reports", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.draft", "Report drafting requires radiology staff");
  const body = await parseJson(c, radiologyReportCreateSchema);
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      const study = await requireRows(await tx`
        select s.id, s.acquisition_status, i.id as order_item_id, o.id as order_id, o.patient_id, o.encounter_id
          from imaging_studies s join service_order_items i on i.id = s.order_item_id join service_orders o on o.id = i.order_id
         where s.id = ${body.studyId} and s.tenant_id = ${tenantId} for update of s
      `, "Imaging study not found");
      if (study.acquisitionStatus === "cancelled") throw new ConflictError("The study was cancelled");
      await requireRows(await tx`
        select id from radiology_templates where id = ${body.templateId} and tenant_id = ${tenantId} and status = 'approved'
      `, "Approved report template not found");
      await tx`
        insert into radiology_reports (id, tenant_id, patient_id, encounter_id, order_id, order_item_id, study_id, template_id,
          content, created_by, last_edited_by)
        values (${id}, ${tenantId}, ${study.patientId}, ${study.encounterId}, ${study.orderId}, ${study.orderItemId}, ${body.studyId},
          ${body.templateId}, ${tx.json({ fields: {}, measurements: [] } as never)}, ${auth.user.id}, ${auth.user.id})
      `;
      await writeAudit(tx, config, requestAudit(c, "radiology.report.create", {
        subjectPatientId: String(study.patientId), resourceType: "RadiologyReport", resourceId: id,
        metadata: { studyId: body.studyId, templateId: body.templateId },
      }));
    });
  } catch (error) {
    if (uniqueViolation(error) === "radiology_reports_one_per_study") throw new ConflictError("This study already has a report");
    throw error;
  }
  return c.json({ ok: true, report: { id } }, 201);
});

radiologyRoutes.get("/radiology/reports/:id", async (c) => {
  const { tenantId, config } = staff(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const report = await requireRows(await tx`
      select r.*, t.definition, t.name as template_name, t.version as template_version, t.code as template_code,
             s.accession, s.modality, s.body_site, s.acquisition_status, s.acquired_at, s.scheduled_at, s.protocol, s.pacs_state,
             o.priority, o.clinical_note, o.created_at as ordered_at, i.name as examination,
             p.public_id, p.given_name, p.family_name, to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth, p.sex,
             ru.display_name as radiologist_name, cu.display_name as created_by_name
        from radiology_reports r
        join radiology_templates t on t.id = r.template_id
        join imaging_studies s on s.id = r.study_id
        join service_order_items i on i.id = r.order_item_id
        join service_orders o on o.id = r.order_id
        join patients p on p.id = r.patient_id
        left join users ru on ru.id = r.reporting_radiologist_id
        join users cu on cu.id = r.created_by
       where r.id = ${id} and r.tenant_id = ${tenantId}
    `, "Radiology report not found");
    const versions = await tx`
      select v.version, v.kind, v.content, v.content_hash, v.urgency, v.change_reason, v.signed_at, u.display_name as signed_by_name
        from radiology_report_versions v join users u on u.id = v.signed_by where v.report_id = ${id} order by v.version
    `;
    const addenda = await tx`
      select a.id, a.applies_to_version, a.text, a.reason, a.signed_at, u.display_name as signed_by_name
        from radiology_report_addenda a join users u on u.id = a.signed_by where a.report_id = ${id} order by a.signed_at
    `;
    const critical = await tx`
      select cc.*, ru.display_name as recipient_name, cu.display_name as communicated_by_name, au.display_name as acknowledged_by_name,
             eu.display_name as escalated_to_name
        from radiology_critical_communications cc
        join users ru on ru.id = cc.recipient_user_id
        join users cu on cu.id = cc.communicated_by
        left join users au on au.id = cc.acknowledged_by
        left join users eu on eu.id = cc.escalated_to
       where cc.report_id = ${id} order by cc.communicated_at
    `;
    const priors = await tx`
      select r.id, r.signed_at, r.status, t.name as template_name, s.modality, s.body_site, s.accession,
             (select v.content->'fields'->>'impression' from radiology_report_versions v where v.report_id = r.id order by v.version desc limit 1) as impression
        from radiology_reports r join radiology_templates t on t.id = r.template_id join imaging_studies s on s.id = r.study_id
       where r.tenant_id = ${tenantId} and r.patient_id = ${report.patientId} and r.id <> ${id} and r.status in ('final', 'corrected')
       order by r.signed_at desc limit 10
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.report.read", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: id,
    }));
    return { report, versions, addenda, critical, priors };
  });
  return c.json({
    ...data,
    images: imagesState(c),
    permissions: { draft: can(c, "radiology.report.draft"), sign: can(c, "radiology.report.sign"), addend: can(c, "radiology.report.addend") },
    criticalAcknowledgementMinutes: config.radiologyCriticalAckMinutes,
  });
});

radiologyRoutes.put("/radiology/reports/:id/draft", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.draft", "Report drafting requires radiology staff");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyDraftSchema);
  const version = await withStaffActor(c, async (tx) => {
    const report = await lockReport(tx, tenantId, id);
    if (!["draft", "preliminary"].includes(String(report.status))) {
      throw new ConflictError("A signed report cannot be edited; add an addendum or a correction");
    }
    ensureMatch(body.expectedVersion, Number(report.draftVersion));
    contentProblems(definitionOf(report), body.content, false);
    await tx`
      update radiology_reports set content = ${tx.json(body.content as never)}, urgency = ${body.urgency},
        draft_version = draft_version + 1, last_edited_by = ${auth.user.id}, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.report.draft.save", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: id,
      metadata: { draftVersion: Number(report.draftVersion) + 1, urgency: body.urgency },
    }));
    return Number(report.draftVersion) + 1;
  });
  return c.json({ ok: true, draftVersion: version });
});

radiologyRoutes.post("/radiology/reports/:id/sign", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.sign", "Only a radiologist can sign radiology reports");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologySignSchema);
  const result = await withStaffActor(c, async (tx) => {
    const report = await lockReport(tx, tenantId, id);
    ensureMatch(body.expectedVersion, Number(report.draftVersion));
    if (!canTransitionRadiologyReport(report.status as RadiologyReportStatus, body.kind)) {
      throw new ConflictError(`A ${report.status} report cannot be signed as ${body.kind}`);
    }
    const [study] = await tx`select acquisition_status from imaging_studies where id = ${report.studyId}`;
    if (body.kind === "final" && study?.acquisitionStatus !== "acquired") {
      throw new ConflictError("A final report requires the study to be marked acquired");
    }
    const content = report.content as RadiologyReportContent;
    contentProblems(definitionOf(report), content, true);
    const signedVersion = Number(report.signedVersion) + 1;
    const hash = await contentDigest({ content, urgency: report.urgency, templateId: report.templateId, kind: body.kind });
    await tx`
      insert into radiology_report_versions (id, tenant_id, report_id, version, kind, template_id, content, content_hash, urgency, signed_by)
      values (${crypto.randomUUID()}, ${tenantId}, ${id}, ${signedVersion}, ${body.kind}, ${report.templateId},
        ${tx.json(content as never)}, ${hash}, ${report.urgency}, ${auth.user.id})
    `;
    await tx`
      update radiology_reports set status = ${body.kind}, signed_version = ${signedVersion}, reporting_radiologist_id = ${auth.user.id},
        preliminary_at = case when ${body.kind} = 'preliminary' then now() else preliminary_at end,
        signed_at = case when ${body.kind} = 'final' then now() else signed_at end,
        draft_version = draft_version + 1, updated_at = now()
       where id = ${id}
    `;
    if (body.kind === "final") {
      await tx`update service_order_items set status = 'resulted' where id = ${report.orderItemId}`;
      const [remaining] = await tx`
        select count(*)::int as count from service_order_items where order_id = ${report.orderId} and status not in ('resulted', 'cancelled')
      `;
      if (Number(remaining?.count) === 0) await tx`update service_orders set status = 'resulted', version = version + 1, updated_at = now() where id = ${report.orderId}`;
    }
    await writeAudit(tx, config, requestAudit(c, `radiology.report.sign.${body.kind}`, {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: id,
      metadata: { signedVersion, contentHash: hash, urgency: report.urgency, attested: true },
    }));
    await writeOutbox(tx, { tenantId, eventType: `radiology.report.${body.kind}`, aggregateId: id, aggregateVersion: signedVersion, payload: { urgency: report.urgency } });
    return { signedVersion, contentHash: hash };
  });
  return c.json({ ok: true, ...result });
});

radiologyRoutes.post("/radiology/reports/:id/corrections", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.sign", "Only a radiologist can correct a signed report");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyCorrectionSchema);
  const result = await withStaffActor(c, async (tx) => {
    const report = await lockReport(tx, tenantId, id);
    if (!canTransitionRadiologyReport(report.status as RadiologyReportStatus, "corrected")) {
      throw new ConflictError("Only a final report can be corrected");
    }
    ensureMatch(body.expectedSignedVersion, Number(report.signedVersion));
    contentProblems(definitionOf(report), body.content, true);
    const signedVersion = Number(report.signedVersion) + 1;
    const hash = await contentDigest({ content: body.content, urgency: body.urgency, templateId: report.templateId, kind: "correction", reason: body.reason });
    await tx`
      insert into radiology_report_versions (id, tenant_id, report_id, version, kind, template_id, content, content_hash, urgency, change_reason, signed_by)
      values (${crypto.randomUUID()}, ${tenantId}, ${id}, ${signedVersion}, 'correction', ${report.templateId},
        ${tx.json(body.content as never)}, ${hash}, ${body.urgency}, ${body.reason}, ${auth.user.id})
    `;
    await tx`
      update radiology_reports set status = 'corrected', signed_version = ${signedVersion}, content = ${tx.json(body.content as never)},
        urgency = ${body.urgency}, draft_version = draft_version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.report.correct", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: id,
      metadata: { signedVersion, contentHash: hash, reason: body.reason, attested: true },
    }));
    await writeOutbox(tx, { tenantId, eventType: "radiology.report.corrected", aggregateId: id, aggregateVersion: signedVersion, payload: { urgency: body.urgency } });
    return { signedVersion, contentHash: hash };
  });
  return c.json({ ok: true, ...result });
});

radiologyRoutes.post("/radiology/reports/:id/addenda", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.addend", "Only a radiologist can add an addendum");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyAddendumSchema);
  const addendumId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const report = await lockReport(tx, tenantId, id);
    if (!["final", "corrected"].includes(String(report.status))) throw new ConflictError("Addenda can only be added to a signed final report");
    const hash = await contentDigest({ text: body.text, reason: body.reason, appliesToVersion: Number(report.signedVersion) });
    await tx`
      insert into radiology_report_addenda (id, tenant_id, report_id, applies_to_version, text, reason, content_hash, signed_by)
      values (${addendumId}, ${tenantId}, ${id}, ${report.signedVersion}, ${body.text}, ${body.reason}, ${hash}, ${auth.user.id})
    `;
    await tx`update radiology_reports set updated_at = now() where id = ${id}`;
    await writeAudit(tx, config, requestAudit(c, "radiology.report.addendum", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: id,
      metadata: { addendumId, appliesToVersion: Number(report.signedVersion), contentHash: hash, attested: true },
    }));
    await writeOutbox(tx, { tenantId, eventType: "radiology.report.addendum", aggregateId: id, payload: { addendumId } });
  });
  return c.json({ ok: true, addendum: { id: addendumId } }, 201);
});

radiologyRoutes.post("/radiology/reports/:id/release", async (c) => {
  const { tenantId, config } = staff(c);
  if (!can(c, "radiology.report.sign") && !requestActor(c).roles.includes("clinician")) {
    throw new ForbiddenError("Report release requires a radiologist or clinician");
  }
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyReleaseSchema);
  await withStaffActor(c, async (tx) => {
    const report = await lockReport(tx, tenantId, id);
    if (!["final", "corrected"].includes(String(report.status))) throw new ConflictError("Only a signed final report can be released");
    if (report.releasedAt) throw new ConflictError("This report has already been released");
    if (report.urgency === "critical") {
      const communicated = await tx`select 1 from radiology_critical_communications where report_id = ${id}`;
      if (!communicated.length) throw new ConflictError("A critical report must have a recorded critical-finding communication before release");
    }
    await tx`update radiology_reports set released_at = now(), updated_at = now() where id = ${id}`;
    await tx`update service_orders set reported_at = coalesce(reported_at, now()) where id = ${report.orderId}`;
    await writeAudit(tx, config, requestAudit(c, "radiology.report.release", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: id,
      metadata: { releaseNote: body.releaseNote, signedVersion: Number(report.signedVersion) },
    }));
    await writeOutbox(tx, { tenantId, eventType: "radiology.report.released", aggregateId: id });
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- critical findings

radiologyRoutes.post("/radiology/reports/:id/critical-communications", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.sign", "Critical-finding communication is recorded by the reporting radiologist");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyCriticalSchema);
  const communicationId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const report = await lockReport(tx, tenantId, id);
    if (!["preliminary", "final", "corrected"].includes(String(report.status))) {
      throw new ConflictError("Sign the report (preliminary or final) before recording a critical-finding communication");
    }
    const recipient = await tx`
      select 1 from memberships where tenant_id = ${tenantId} and user_id = ${body.recipientUserId} and status = 'active'
         and roles && ARRAY['clinician', 'nurse', 'specialist_clinician', 'midwife']
    `;
    if (!recipient.length) throw new ValidationError("The recipient must be an active clinical member of this facility");
    await tx`
      insert into radiology_critical_communications (id, tenant_id, report_id, recipient_user_id, method, finding_summary, communicated_by)
      values (${communicationId}, ${tenantId}, ${id}, ${body.recipientUserId}, ${body.method}, ${body.findingSummary}, ${auth.user.id})
    `;
    if (report.urgency !== "critical") await tx`update radiology_reports set urgency = 'critical', updated_at = now() where id = ${id}`;
    await writeAudit(tx, config, requestAudit(c, "radiology.critical.communicate", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyCriticalCommunication", resourceId: communicationId,
      metadata: { reportId: id, recipientUserId: body.recipientUserId, method: body.method },
    }));
    await writeOutbox(tx, { tenantId, eventType: "radiology.critical.communicated", aggregateId: communicationId, payload: { reportId: id } });
  });
  return c.json({ ok: true, communication: { id: communicationId } }, 201);
});

radiologyRoutes.get("/radiology/critical-communications", async (c) => {
  const { tenantId, config } = staff(c);
  const state = c.req.query("state") === "all" ? "all" : "open";
  const rows = await withStaffActor(c, async (tx) => tx`
    select cc.id, cc.report_id, cc.method, cc.finding_summary, cc.communicated_at, cc.acknowledged_at, cc.escalated_at,
           cc.recipient_user_id, cc.escalated_to, ru.display_name as recipient_name, eu.display_name as escalated_to_name,
           p.public_id, p.given_name, p.family_name, s.accession,
           round(extract(epoch from (coalesce(cc.acknowledged_at, now()) - cc.communicated_at)) / 60)::int as minutes_open,
           (cc.acknowledged_at is null and cc.communicated_at < now() - make_interval(mins => ${config.radiologyCriticalAckMinutes})) as overdue
      from radiology_critical_communications cc
      join radiology_reports r on r.id = cc.report_id
      join patients p on p.id = r.patient_id
      join imaging_studies s on s.id = r.study_id
      join users ru on ru.id = cc.recipient_user_id
      left join users eu on eu.id = cc.escalated_to
     where cc.tenant_id = ${tenantId} and (${state} = 'all' or cc.acknowledged_at is null)
     order by cc.communicated_at
     limit 200
  `);
  return c.json({ communications: rows, acknowledgementMinutes: config.radiologyCriticalAckMinutes });
});

radiologyRoutes.post("/radiology/critical-communications/:id/acknowledge", async (c) => {
  const { auth, tenantId, config } = staff(c);
  const roles = requestActor(c).roles;
  if (!roles.some((role) => ["clinician", "nurse"].includes(role))) throw new ForbiddenError("Acknowledgement requires clinical staff");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyAcknowledgeSchema);
  await withStaffActor(c, async (tx) => {
    const communication = await requireRows(await tx`
      select cc.id, cc.recipient_user_id, cc.escalated_to, cc.acknowledged_at, r.patient_id, cc.report_id
        from radiology_critical_communications cc join radiology_reports r on r.id = cc.report_id
       where cc.id = ${id} and cc.tenant_id = ${tenantId} for update of cc
    `, "Critical communication not found");
    if (communication.acknowledgedAt) throw new ConflictError("This critical finding has already been acknowledged");
    if (![String(communication.recipientUserId), String(communication.escalatedTo ?? "")].includes(auth.user.id)) {
      throw new ForbiddenError("Only the clinician the finding was communicated or escalated to can acknowledge it");
    }
    await tx`
      update radiology_critical_communications set acknowledged_at = now(), acknowledged_by = ${auth.user.id}, acknowledgement_note = ${body.note}
       where id = ${id}
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.critical.acknowledge", {
      subjectPatientId: String(communication.patientId), resourceType: "RadiologyCriticalCommunication", resourceId: id,
      metadata: { reportId: String(communication.reportId) },
    }));
  });
  return c.json({ ok: true });
});

radiologyRoutes.post("/radiology/critical-communications/:id/escalate", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.report.sign", "Escalation is recorded by a radiologist");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, radiologyEscalateSchema);
  await withStaffActor(c, async (tx) => {
    const communication = await requireRows(await tx`
      select cc.id, cc.acknowledged_at, cc.escalated_at, cc.recipient_user_id, r.patient_id, cc.report_id
        from radiology_critical_communications cc join radiology_reports r on r.id = cc.report_id
       where cc.id = ${id} and cc.tenant_id = ${tenantId} for update of cc
    `, "Critical communication not found");
    if (communication.acknowledgedAt) throw new ConflictError("An acknowledged finding does not need escalation");
    if (body.toUserId === String(communication.recipientUserId)) throw new ValidationError("Escalate to a different clinician");
    const target = await tx`
      select 1 from memberships where tenant_id = ${tenantId} and user_id = ${body.toUserId} and status = 'active'
         and roles && ARRAY['clinician', 'specialist_clinician', 'department_lead']
    `;
    if (!target.length) throw new ValidationError("Escalation must go to an active clinician of this facility");
    await tx`
      update radiology_critical_communications set escalated_at = now(), escalated_to = ${body.toUserId}, escalated_by = ${auth.user.id},
        escalation_note = ${body.note}
       where id = ${id}
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.critical.escalate", {
      subjectPatientId: String(communication.patientId), resourceType: "RadiologyCriticalCommunication", resourceId: id,
      metadata: { reportId: String(communication.reportId), toUserId: body.toUserId, previouslyEscalated: Boolean(communication.escalatedAt) },
    }));
    await writeOutbox(tx, { tenantId, eventType: "radiology.critical.escalated", aggregateId: id, payload: { toUserId: body.toUserId } });
  });
  return c.json({ ok: true });
});

radiologyRoutes.get("/radiology/clinical-recipients", async (c) => {
  const { tenantId } = staff(c);
  const rows = await withStaffActor(c, async (tx) => tx`
    select u.id, u.display_name, m.roles
      from memberships m join users u on u.id = m.user_id
     where m.tenant_id = ${tenantId} and m.status = 'active'
       and m.roles && ARRAY['clinician', 'nurse', 'specialist_clinician', 'midwife', 'department_lead']::text[]
     order by u.display_name
  `);
  return c.json({ members: rows });
});

// ---------------------------------------------------------------- clinician view

radiologyRoutes.get("/radiology/orders/:orderItemId/report", async (c) => {
  const { tenantId, config } = staff(c);
  const orderItemId = uuidSchema.parse(c.req.param("orderItemId"));
  const data = await withStaffActor(c, async (tx) => {
    const [report] = await tx`
      select r.id, r.status, r.urgency, r.signed_at, r.released_at, r.signed_version, r.patient_id, t.definition, t.name as template_name,
             s.accession, s.modality, s.body_site, u.display_name as radiologist_name
        from radiology_reports r join radiology_templates t on t.id = r.template_id join imaging_studies s on s.id = r.study_id
        left join users u on u.id = r.reporting_radiologist_id
       where r.order_item_id = ${orderItemId} and r.tenant_id = ${tenantId} and r.status in ('final', 'corrected')
    `;
    if (!report) return null;
    const [latest] = await tx`select version, kind, content, content_hash, signed_at from radiology_report_versions where report_id = ${report.id} order by version desc limit 1`;
    const addenda = await tx`select text, reason, signed_at from radiology_report_addenda where report_id = ${report.id} order by signed_at`;
    await writeAudit(tx, config, requestAudit(c, "radiology.report.read", {
      subjectPatientId: String(report.patientId), resourceType: "RadiologyReport", resourceId: String(report.id),
    }));
    return { report, latest, addenda };
  });
  return c.json({ signedReport: data, images: imagesState(c) });
});
