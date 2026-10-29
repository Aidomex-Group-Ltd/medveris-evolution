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
  pacsFrameQuerySchema,
  pacsLinkSchema,
  pacsStudySearchSchema,
  pacsUnlinkSchema,
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
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { ensureMatch, parseJson, parseQuery } from "../lib/http.js";
import { uniqueViolation } from "../lib/idempotency.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { IntegrationUnavailableError, integrationStatus, type IntegrationStatus } from "../integrations/registry.js";
import { compareIdentity, dicomwebClientFor, isDicomUid, type DicomwebClient } from "../integrations/dicomweb.js";
import { loadVerifications } from "../integrations/verification.js";
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

async function pacsStatus(c: C): Promise<IntegrationStatus> {
  const deps = c.get("deps");
  const verifications = await loadVerifications(deps.sql, deps.config);
  return integrationStatus(deps.config, "dicomweb", verifications.dicomweb);
}

async function imagesState(c: C) {
  const status = await pacsStatus(c);
  return { state: status.state, reason: status.reason, available: status.state === "available", verifiedAt: status.lastSuccessfulVerificationAt };
}

async function requirePacs(c: C, operation: string, outcome: string): Promise<DicomwebClient> {
  const status = await pacsStatus(c);
  const client = status.state === "available" ? dicomwebClientFor(c.get("deps").config, c.get("deps").dicomweb) : null;
  if (!client) throw new IntegrationUnavailableError(status, operation, outcome);
  return client;
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
  const pacsState = (await pacsStatus(c)).state === "available" ? "pending" : "not-configured";
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
          values (${id}, ${tenantId}, ${body.orderItemId}, ${body.modality}, ${body.bodySite}, ${accession}, ${pacsState},
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
             s.id as study_id, s.accession, s.modality, s.body_site, s.acquisition_status, s.scheduled_at, s.acquired_at, s.version as study_version, s.pacs_state,
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
             s.accession, s.modality, s.body_site, s.acquisition_status, s.acquired_at, s.scheduled_at, s.protocol, s.pacs_state, s.version as study_version,
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
    images: await imagesState(c),
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
         and roles && ARRAY['clinician', 'nurse']
    `;
    if (!recipient.length) throw new ValidationError("The recipient must be an active clinician or nurse of this facility, who can open and acknowledge the finding");
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
         and roles && ARRAY['clinician']
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
  return c.json({ signedReport: data, images: await imagesState(c) });
});

// ---------------------------------------------------------------- PACS images

radiologyRoutes.get("/radiology/images/status", async (c) => {
  staff(c);
  return c.json({ images: await imagesState(c) });
});

interface StudyRow {
  id: string;
  accession: string | null;
  modality: string;
  bodySite: string;
  acquisitionStatus: string;
  pacsState: string;
  studyInstanceUid: string | null;
  pacsLinkedAt: Date | null;
  pacsIdentity: unknown;
  version: number;
  patientId: string;
  publicId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string | null;
  sex: string | null;
  examination: string;
  linkedByName: string | null;
  reportId: string | null;
}

async function loadStudy(tx: Tx, tenantId: string, id: string, lock = false): Promise<StudyRow> {
  const rows = lock
    ? await tx`
      select s.id, s.accession, s.modality, s.body_site, s.acquisition_status, s.pacs_state, s.study_instance_uid, s.pacs_linked_at,
             s.pacs_identity, s.version, o.patient_id
        from imaging_studies s join service_order_items i on i.id = s.order_item_id join service_orders o on o.id = i.order_id
       where s.id = ${id} and s.tenant_id = ${tenantId} for update of s`
    : await tx`
      select s.id, s.accession, s.modality, s.body_site, s.acquisition_status, s.pacs_state, s.study_instance_uid, s.pacs_linked_at,
             s.pacs_identity, s.version, o.patient_id, p.public_id, p.given_name, p.family_name,
             to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth, p.sex, i.name as examination, lu.display_name as linked_by_name,
             (select r.id from radiology_reports r where r.study_id = s.id and r.status <> 'cancelled' limit 1) as report_id
        from imaging_studies s join service_order_items i on i.id = s.order_item_id join service_orders o on o.id = i.order_id
        join patients p on p.id = o.patient_id left join users lu on lu.id = s.pacs_linked_by
       where s.id = ${id} and s.tenant_id = ${tenantId}`;
  return requireRows(rows, "Imaging study not found") as unknown as StudyRow;
}

async function patientIdentity(tx: Tx, patientId: string) {
  const [patient] = await tx`
    select given_name, family_name, to_char(date_of_birth, 'YYYY-MM-DD') as date_of_birth, sex from patients where id = ${patientId}
  `;
  if (!patient) throw new NotFoundError("Patient not found");
  return { givenName: String(patient.givenName), familyName: String(patient.familyName), dateOfBirth: patient.dateOfBirth as string | null, sex: patient.sex as string | null };
}

function requireImageAccess(c: C): void {
  requirePermission(c, "radiology.images.view", "Viewing images requires clinical or radiology staff");
}

radiologyRoutes.get("/radiology/studies/:id", async (c) => {
  const { tenantId } = staff(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const study = await withStaffActor(c, async (tx) => loadStudy(tx, tenantId, id));
  return c.json({
    study,
    images: await imagesState(c),
    permissions: { link: can(c, "radiology.study.register"), view: can(c, "radiology.images.view") },
  });
});

radiologyRoutes.get("/radiology/studies/:id/pacs-candidates", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.study.register", "Searching the PACS requires a radiographer or radiologist");
  const id = uuidSchema.parse(c.req.param("id"));
  const query = parseQuery(c, pacsStudySearchSchema);
  await enforceRateLimit(c, "pacs.search", auth.user.id);
  const client = await requirePacs(c, "radiology.pacs.search", "the PACS was not searched");
  const { study, patient } = await withStaffActor(c, async (tx) => {
    const row = await loadStudy(tx, tenantId, id);
    return { study: row, patient: await patientIdentity(tx, row.patientId) };
  });
  const criteria = { ...query };
  if (!criteria.accession && !criteria.patientId && !criteria.fromDate && !criteria.toDate) criteria.accession = study.accession ?? undefined;
  if (!criteria.accession && !criteria.patientId && !criteria.fromDate && !criteria.toDate) {
    throw new ValidationError("Give an accession number, PACS patient ID or study date range to search the PACS");
  }
  const studies = await client.searchStudies({ ...criteria, limit: 25 });
  await withStaffActor(c, async (tx) => writeAudit(tx, config, requestAudit(c, "radiology.pacs.search", {
    subjectPatientId: study.patientId, resourceType: "ImagingStudy", resourceId: id,
    metadata: { criteria: Object.keys(criteria).filter((key) => criteria[key as keyof typeof criteria]), results: studies.length },
  })));
  return c.json({
    criteria,
    candidates: studies.map((candidate) => ({
      ...candidate,
      accessionMatches: Boolean(study.accession && candidate.accession === study.accession),
      identity: compareIdentity(candidate.patient, patient),
    })),
  });
});

radiologyRoutes.post("/radiology/studies/:id/pacs-link", async (c) => {
  const { auth, tenantId, config } = staff(c);
  requirePermission(c, "radiology.study.register", "Linking a PACS study requires a radiographer or radiologist");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, pacsLinkSchema);
  const client = await requirePacs(c, "radiology.pacs.link", "the study was not linked");
  const pacs = await client.findStudy(body.studyInstanceUid);
  if (!pacs) throw new NotFoundError("The PACS has no study with this Study Instance UID");
  try {
    const result = await withStaffActor(c, async (tx) => {
      const study = await loadStudy(tx, tenantId, id, true);
      ensureMatch(body.expectedVersion, Number(study.version));
      if (study.acquisitionStatus === "cancelled") throw new ConflictError("The study was cancelled");
      if (study.pacsState === "reconciled") throw new ConflictError("This study is already linked to a PACS study; unlink it first");
      const identity = compareIdentity(pacs.patient, await patientIdentity(tx, study.patientId));
      if (!identity.confirmed && !body.identityOverrideReason) {
        throw new ConflictError("The PACS family name or date of birth does not match this patient. Check the study; to link anyway, record why.", { identity });
      }
      const snapshot = {
        patient: pacs.patient,
        accession: pacs.accession,
        studyDate: pacs.studyDate,
        description: pacs.description,
        modalities: pacs.modalities,
        identity,
        overrideReason: body.identityOverrideReason ?? null,
      };
      await tx`
        update imaging_studies set study_instance_uid = ${pacs.studyInstanceUid}, pacs_state = 'reconciled', pacs_linked_at = now(),
          pacs_linked_by = ${auth.user.id}, pacs_identity = ${tx.json(snapshot as never)}, version = version + 1, updated_at = now(),
          reconciliation_note = ${body.identityOverrideReason ?? null}
         where id = ${id}
      `;
      await writeAudit(tx, config, requestAudit(c, "radiology.pacs.link", {
        subjectPatientId: study.patientId, resourceType: "ImagingStudy", resourceId: id,
        metadata: {
          accessionMatches: Boolean(study.accession && pacs.accession === study.accession),
          identity, identityOverride: Boolean(body.identityOverrideReason),
        },
      }));
      return { version: Number(study.version) + 1, identity };
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (uniqueViolation(error) === "imaging_studies_pacs_study") throw new ConflictError("This PACS study is already linked to another imaging study at this facility");
    throw error;
  }
});

radiologyRoutes.post("/radiology/studies/:id/pacs-unlink", async (c) => {
  const { tenantId, config } = staff(c);
  requirePermission(c, "radiology.study.register", "Unlinking a PACS study requires a radiographer or radiologist");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, pacsUnlinkSchema);
  const version = await withStaffActor(c, async (tx) => {
    const study = await loadStudy(tx, tenantId, id, true);
    ensureMatch(body.expectedVersion, Number(study.version));
    if (study.pacsState !== "reconciled") throw new ConflictError("This study is not linked to a PACS study");
    await tx`
      update imaging_studies set study_instance_uid = null, pacs_state = 'pending', pacs_linked_at = null, pacs_linked_by = null,
        pacs_identity = null, reconciliation_note = ${body.reason}, version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, config, requestAudit(c, "radiology.pacs.unlink", {
      subjectPatientId: study.patientId, resourceType: "ImagingStudy", resourceId: id,
      metadata: { reason: body.reason },
    }));
    return Number(study.version) + 1;
  });
  return c.json({ ok: true, version });
});

async function linkedStudyUid(c: C, tenantId: string, id: string): Promise<{ uid: string; patientId: string }> {
  return withStaffActor(c, async (tx) => {
    const [row] = await tx`
      select s.study_instance_uid, s.pacs_state, o.patient_id
        from imaging_studies s join service_order_items i on i.id = s.order_item_id join service_orders o on o.id = i.order_id
       where s.id = ${id} and s.tenant_id = ${tenantId}
    `;
    if (!row) throw new NotFoundError("Imaging study not found");
    if (row.pacsState !== "reconciled" || !isDicomUid(row.studyInstanceUid)) throw new ConflictError("This study is not linked to a PACS study");
    return { uid: String(row.studyInstanceUid), patientId: String(row.patientId) };
  });
}

function seriesParam(c: C, name: string): string {
  const value = c.req.param(name);
  if (!isDicomUid(value)) throw new ValidationError(`Invalid ${name}`);
  return value;
}

radiologyRoutes.get("/radiology/studies/:id/images", async (c) => {
  const { tenantId, config } = staff(c);
  requireImageAccess(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const client = await requirePacs(c, "radiology.images.view", "no images were retrieved");
  const linked = await linkedStudyUid(c, tenantId, id);
  const [study, series] = await Promise.all([client.findStudy(linked.uid), client.searchSeries(linked.uid)]);
  if (!study) throw new NotFoundError("The linked study is no longer in the PACS; unlink it and check the PACS");
  await withStaffActor(c, async (tx) => writeAudit(tx, config, requestAudit(c, "radiology.images.view", {
    subjectPatientId: linked.patientId, resourceType: "ImagingStudy", resourceId: id,
    metadata: { series: series.length },
  })));
  return c.json({ study, series, notice: "Rendered review images from the PACS. Not a validated diagnostic viewer; confirm findings on a diagnostic workstation." });
});

radiologyRoutes.get("/radiology/studies/:id/images/series/:seriesUid", async (c) => {
  const { tenantId } = staff(c);
  requireImageAccess(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const seriesUid = seriesParam(c, "seriesUid");
  const client = await requirePacs(c, "radiology.images.view", "no images were retrieved");
  const linked = await linkedStudyUid(c, tenantId, id);
  const instances = await client.searchInstances(linked.uid, seriesUid);
  return c.json({ instances });
});

radiologyRoutes.get("/radiology/studies/:id/images/series/:seriesUid/instances/:instanceUid/frames/:frame", async (c) => {
  const { auth, tenantId } = staff(c);
  requireImageAccess(c);
  await enforceRateLimit(c, "pacs.frame", auth.user.id);
  const id = uuidSchema.parse(c.req.param("id"));
  const seriesUid = seriesParam(c, "seriesUid");
  const instanceUid = seriesParam(c, "instanceUid");
  const frame = Number(c.req.param("frame"));
  const query = parseQuery(c, pacsFrameQuerySchema);
  const client = await requirePacs(c, "radiology.images.view", "no image was retrieved");
  const linked = await linkedStudyUid(c, tenantId, id);
  const image = await client.renderFrame(linked.uid, seriesUid, instanceUid, frame, {
    viewport: query.size === "thumb" ? 160 : undefined,
    window: query.windowCenter !== undefined && query.windowWidth !== undefined ? { center: query.windowCenter, width: query.windowWidth } : undefined,
  });
  return new Response(image.body, {
    status: 200,
    headers: { "content-type": image.contentType, "cache-control": "no-store, private", "x-content-type-options": "nosniff" },
  });
});
