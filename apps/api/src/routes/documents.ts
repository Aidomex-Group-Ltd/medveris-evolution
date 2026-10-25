import { Hono } from "hono";
import {
  documentAmendSchema,
  documentCreateSchema,
  documentDraftUpdateSchema,
  documentErrorSchema,
  documentSignSchema,
  templatePublishSchema,
  templateSchema,
  uuidSchema,
} from "@medveris/contracts";
import { canTransitionTemplate, contentDigest, nextDocumentStatus, validateDocumentContent, validateTemplateFields, type DocumentStatus, type TemplateStatus } from "@medveris/domain";
import { hmacHex } from "@medveris/auth";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const documentRoutes = new Hono<AppEnv>();

type Tx = Parameters<Parameters<typeof withStaffActor>[1]>[0];

function authorAllowed(c: Parameters<typeof requireStaff>[0], roles: unknown): boolean {
  if (!Array.isArray(roles) || roles.length === 0) return true;
  const actorRoles = requestActor(c).roles as string[];
  return roles.map(String).some((role) => actorRoles.includes(role));
}

async function loadTemplate(tx: Tx, tenantId: string, templateId: string) {
  const rows = await tx`
    select t.id, t.template_key, t.name, t.description, t.department_id, t.context, t.purpose, t.sensitivity,
           t.status, t.current_version, v.id as version_id, v.version, v.fields, v.author_roles, v.reviewer_roles,
           v.signing_required, v.countersign_required, v.amendment_rules, v.retention_class, v.effective_from
      from document_templates t
      join document_template_versions v on v.template_id = t.id and v.version = t.current_version
     where t.id = ${templateId} and t.tenant_id = ${tenantId}
  `;
  return requireRows(rows, "Document template not found");
}

async function latestVersion(tx: Tx, documentId: string) {
  const rows = await tx`
    select id, version, status, content, content_digest, change_note
      from document_versions where document_id = ${documentId} order by version desc limit 1
  `;
  return requireRows(rows, "Document version not found");
}

async function insertVersion(
  tx: Tx,
  input: {
    tenantId: string; documentId: string; version: number; previousVersionId: string | null;
    status: DocumentStatus; content: Record<string, unknown>; changeNote: string; authorUserId: string;
    signedAt?: Date | null; signature?: string | null; signatureKeyId?: string | null;
  },
): Promise<{ id: string; digest: string }> {
  const id = crypto.randomUUID();
  const digest = await contentDigest(input.content);
  await tx`
    insert into document_versions (id, document_id, tenant_id, version, previous_version_id, status, content,
      content_digest, change_note, author_user_id, signed_at, signature, signature_key_id)
    values (${id}, ${input.documentId}, ${input.tenantId}, ${input.version}, ${input.previousVersionId}, ${input.status},
      ${tx.json(input.content as never)}, ${digest}, ${input.changeNote}, ${input.authorUserId},
      ${input.signedAt ?? null}, ${input.signature ?? null}, ${input.signatureKeyId ?? null})
  `;
  return { id, digest };
}

documentRoutes.get("/document-templates", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const context = c.req.query("context");
  const rows = await withStaffActor(c, async (tx) => tx`
    select t.id, t.template_key, t.name, t.description, t.department_id, t.context, t.purpose, t.sensitivity,
           t.status, t.current_version, t.updated_at,
           v.fields, v.author_roles, v.reviewer_roles, v.signing_required, v.countersign_required, v.retention_class,
           (select count(*)::int from documents d where d.template_id = t.id) as document_count
      from document_templates t
      join document_template_versions v on v.template_id = t.id and v.version = t.current_version
     where t.tenant_id = ${auth.activeTenant!.id}
       ${context ? tx`and t.context = ${context}` : tx``}
     order by t.context, t.name
  `);
  return c.json({ templates: rows });
});

documentRoutes.post("/document-templates", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const body = await parseJson(c, templateSchema);
  const fields = validateTemplateFields(body.fields);
  if (!authorAllowed(c, body.authorRoles)) throw new ForbiddenError("Your role is not listed as an author for this template");
  const templateId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.departmentId) {
      const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!department[0]) throw new ValidationError("The selected department does not exist");
    }
    await tx`
      insert into document_templates (id, tenant_id, template_key, name, description, department_id, context, purpose, sensitivity, status, current_version, created_by)
      values (${templateId}, ${auth.activeTenant!.id}, ${body.templateKey}, ${body.name}, ${body.description || null},
        ${body.departmentId ?? null}, ${body.context}, ${body.purpose || null}, ${body.sensitivity}, 'draft', 1, ${auth.user.id})
    `;
    await tx`
      insert into document_template_versions (id, template_id, tenant_id, version, fields, author_roles, reviewer_roles,
        signing_required, countersign_required, amendment_rules, retention_class, effective_from, created_by)
      values (${versionId}, ${templateId}, ${auth.activeTenant!.id}, 1, ${tx.json(fields as never)},
        ${body.authorRoles}, ${body.reviewerRoles}, ${body.signingRequired}, ${body.countersignRequired},
        ${body.amendmentRules || null}, ${body.retentionClass}, ${body.effectiveFrom ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.template.create", {
      resourceType: "DocumentTemplate", resourceId: templateId,
      metadata: { templateKey: body.templateKey, context: body.context, fields: fields.length },
    }));
  });
  return c.json({ ok: true, template: { id: templateId } }, 201);
});

documentRoutes.get("/document-templates/:id", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const template = await loadTemplate(tx, auth.activeTenant!.id, id);
    const versions = await tx`
      select id, version, fields, author_roles, reviewer_roles, signing_required, countersign_required,
             retention_class, published_at, approved_at, created_at
        from document_template_versions where template_id = ${id} order by version desc
    `;
    return { template, versions };
  });
  return c.json(data);
});

documentRoutes.post("/document-templates/:id/versions", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, templateSchema);
  const fields = validateTemplateFields(body.fields);
  if (!authorAllowed(c, body.authorRoles)) throw new ForbiddenError("Your role is not listed as an author for this template");
  const versionId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const template = await requireRows(await tx`
      select id, status, current_version from document_templates where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Document template not found");
    const next = Number(template.currentVersion) + 1;
    await tx`
      insert into document_template_versions (id, template_id, tenant_id, version, fields, author_roles, reviewer_roles,
        signing_required, countersign_required, amendment_rules, retention_class, effective_from, created_by)
      values (${versionId}, ${id}, ${auth.activeTenant!.id}, ${next}, ${tx.json(fields as never)},
        ${body.authorRoles}, ${body.reviewerRoles}, ${body.signingRequired}, ${body.countersignRequired},
        ${body.amendmentRules || null}, ${body.retentionClass}, ${body.effectiveFrom ?? null}, ${auth.user.id})
    `;
    await tx`
      update document_templates set current_version = ${next}, status = 'draft', name = ${body.name},
        description = ${body.description || null}, purpose = ${body.purpose || null}, sensitivity = ${body.sensitivity},
        updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.template.version.create", {
      resourceType: "DocumentTemplate", resourceId: id, metadata: { version: next },
    }));
  });
  return c.json({ ok: true, version: { id: versionId } }, 201);
});

documentRoutes.post("/document-templates/:id/publish", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, templatePublishSchema);
  await withStaffActor(c, async (tx) => {
    const template = await requireRows(await tx`
      select id, status, current_version from document_templates where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Document template not found");
    ensureMatch(body.expectedVersion, Number(template.currentVersion));
    if (!canTransitionTemplate(String(template.status) as TemplateStatus, "published")) {
      throw new ConflictError(`Cannot publish a ${template.status} template`);
    }
    const version = await requireRows(await tx`
      select id from document_template_versions where template_id = ${id} and version = ${template.currentVersion}
    `, "Template version not found");
    await tx`
      update document_template_versions set published_at = now(), approved_by = ${auth.user.id}, approved_at = now()
       where id = ${version.id}
    `;
    await tx`
      update document_templates set status = 'published', updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.template.publish", {
      resourceType: "DocumentTemplate", resourceId: id, metadata: { version: Number(template.currentVersion), note: body.approvalNote },
    }));
  });
  return c.json({ ok: true });
});

documentRoutes.post("/document-templates/:id/retire", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, templatePublishSchema);
  await withStaffActor(c, async (tx) => {
    const template = await requireRows(await tx`
      select id, status, current_version from document_templates where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Document template not found");
    ensureMatch(body.expectedVersion, Number(template.currentVersion));
    if (!canTransitionTemplate(String(template.status) as TemplateStatus, "retired")) {
      throw new ConflictError(`Cannot retire a ${template.status} template`);
    }
    await tx`update document_templates set status = 'retired', updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.template.retire", {
      resourceType: "DocumentTemplate", resourceId: id, metadata: { note: body.approvalNote },
    }));
  });
  return c.json({ ok: true });
});

documentRoutes.get("/documents", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const patientId = c.req.query("patientId");
  const departmentId = c.req.query("departmentId");
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select d.id, d.title, d.status, d.subject_type, d.patient_id, d.encounter_id, d.department_id, d.occurred_at,
           d.recorded_at, d.current_version, t.name as template_name, t.context, t.template_key,
           p.public_id, p.given_name, p.family_name, u.display_name as author_name
      from documents d
      join document_templates t on t.id = d.template_id
      left join patients p on p.id = d.patient_id
      join users u on u.id = d.author_user_id
     where d.tenant_id = ${auth.activeTenant!.id}
       ${patientId ? tx`and d.patient_id = ${patientId}` : tx``}
       ${departmentId ? tx`and d.department_id = ${departmentId}` : tx``}
       ${status ? tx`and d.status = ${status}` : tx``}
     order by d.recorded_at desc limit 200
  `);
  return c.json({ documents: rows });
});

documentRoutes.post("/documents", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const body = await parseJson(c, documentCreateSchema);
  const documentId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const template = await loadTemplate(tx, auth.activeTenant!.id, body.templateId);
    if (template.status !== "published") throw new ValidationError("Only a published template can be used for documentation");
    if (!authorAllowed(c, template.authorRoles)) throw new ForbiddenError("Your role is not listed as an author for this template");
    const fields = validateTemplateFields(template.fields);
    const validation = validateDocumentContent(fields, body.content);
    if (!validation.valid) throw new ValidationError("Document content validation failed", validation.errors);
    if (body.subjectType === "patient") {
      if (!body.patientId) throw new ValidationError("A patient is required for a patient document");
      const patient = await tx`select id from patients where id = ${body.patientId} and created_tenant_id = ${auth.activeTenant!.id}`;
      if (!patient[0]) throw new ValidationError("The patient does not belong to this facility");
    }
    if (body.encounterId) {
      const encounter = await tx`select id from encounters where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!encounter[0]) throw new ValidationError("The encounter does not belong to this facility");
    }
    if (body.departmentId) {
      const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!department[0]) throw new ValidationError("The selected department does not exist");
    }
    await tx`
      insert into documents (id, tenant_id, template_id, template_version_id, department_id, unit_id, subject_type,
        patient_id, encounter_id, staff_subject_id, title, occurred_at, status, current_version, author_user_id, sensitivity)
      values (${documentId}, ${auth.activeTenant!.id}, ${template.id}, ${template.versionId}, ${body.departmentId ?? null},
        ${body.unitId ?? null}, ${body.subjectType}, ${body.patientId ?? null}, ${body.encounterId ?? null},
        ${body.staffSubjectId ?? null}, ${body.title}, ${new Date(body.occurredAt)}, 'draft', 1, ${auth.user.id}, ${body.sensitivity})
    `;
    await insertVersion(tx, {
      tenantId: auth.activeTenant!.id, documentId, version: 1, previousVersionId: null, status: "draft",
      content: body.content, changeNote: body.changeNote, authorUserId: auth.user.id,
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.create", {
      subjectPatientId: body.patientId ?? null, resourceType: "Document", resourceId: documentId,
      metadata: { templateId: template.id, templateKey: template.templateKey, context: template.context },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "document.created", aggregateId: documentId, payload: { templateKey: template.templateKey } });
  });
  return c.json({ ok: true, document: { id: documentId } }, 201);
});

documentRoutes.get("/documents/:id", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const document = await requireRows(await tx`
      select d.*, t.name as template_name, t.context, t.template_key,
             p.public_id, p.given_name, p.family_name, u.display_name as author_name
        from documents d
        join document_templates t on t.id = d.template_id
        left join patients p on p.id = d.patient_id
        join users u on u.id = d.author_user_id
       where d.id = ${id} and d.tenant_id = ${auth.activeTenant!.id}
    `, "Document not found");
    const versions = await tx`
      select id, version, previous_version_id, status, content, content_digest, change_note, author_user_id,
             signed_at, signature_key_id, created_at
        from document_versions where document_id = ${id} order by version desc
    `;
    return { document, versions };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "document.read", {
    subjectPatientId: data.document.patientId ? String(data.document.patientId) : null,
    resourceType: "Document", resourceId: id,
  })));
  return c.json(data);
});

documentRoutes.patch("/documents/:id/draft", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, documentDraftUpdateSchema);
  await withStaffActor(c, async (tx) => {
    const document = await requireRows(await tx`
      select d.id, d.status, d.current_version, d.template_version_id, d.author_user_id
        from documents d where d.id = ${id} and d.tenant_id = ${auth.activeTenant!.id} for update
    `, "Document not found");
    ensureMatch(body.expectedVersion, Number(document.currentVersion));
    if (document.status !== "draft") throw new ConflictError("Only a draft document can be edited");
    if (String(document.authorUserId) !== auth.user.id && !requestActor(c).roles.includes("facility_admin")) {
      throw new ForbiddenError("Only the author or a facility administrator may edit this draft");
    }
    const versionRow = await requireRows(await tx`
      select fields from document_template_versions where id = ${document.templateVersionId}
    `, "Template version not found");
    const fields = validateTemplateFields(versionRow.fields);
    const validation = validateDocumentContent(fields, body.content);
    if (!validation.valid) throw new ValidationError("Document content validation failed", validation.errors);
    const previous = await latestVersion(tx, id);
    const next = Number(document.currentVersion) + 1;
    await insertVersion(tx, {
      tenantId: auth.activeTenant!.id, documentId: id, version: next, previousVersionId: String(previous.id),
      status: "draft", content: body.content, changeNote: body.changeNote, authorUserId: auth.user.id,
    });
    await tx`
      update documents set title = ${body.title}, occurred_at = ${new Date(body.occurredAt)}, current_version = ${next}, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.draft.update", {
      resourceType: "Document", resourceId: id, metadata: { version: next, changeNote: body.changeNote },
    }));
  });
  return c.json({ ok: true });
});

documentRoutes.post("/documents/:id/sign", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, documentSignSchema);
  const signedAt = new Date();
  const result = await withStaffActor(c, async (tx) => {
    const document = await requireRows(await tx`
      select d.id, d.status, d.current_version, d.template_version_id, d.patient_id, v.signing_required, v.author_roles
        from documents d
        join document_templates t on t.id = d.template_id
        join document_template_versions v on v.id = d.template_version_id
       where d.id = ${id} and d.tenant_id = ${auth.activeTenant!.id} for update
    `, "Document not found");
    ensureMatch(body.expectedVersion, Number(document.currentVersion));
    if (!document.signingRequired) throw new ConflictError("This template does not require a signature");
    if (!authorAllowed(c, document.authorRoles)) throw new ForbiddenError("Your role is not listed as an author for this template");
    const status = nextDocumentStatus(String(document.status) as DocumentStatus, "sign");
    const previous = await latestVersion(tx, id);
    const content = previous.content as Record<string, unknown>;
    const digest = await contentDigest(content);
    const next = Number(document.currentVersion) + 1;
    const signature = await hmacHex(
      c.get("deps").config.auditSigningKey,
      JSON.stringify({ documentId: id, version: next, contentDigest: digest, authorId: auth.user.id, signedAt: signedAt.toISOString() }),
    );
    await insertVersion(tx, {
      tenantId: auth.activeTenant!.id, documentId: id, version: next, previousVersionId: String(previous.id),
      status, content, changeNote: body.note || "Signed document version", authorUserId: auth.user.id,
      signedAt, signature, signatureKeyId: c.get("deps").config.auditSigningKeyId,
    });
    await tx`
      update documents set status = ${status}, current_version = ${next}, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.sign", {
      subjectPatientId: document.patientId ? String(document.patientId) : null,
      resourceType: "Document", resourceId: id, metadata: { version: next, digest },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "document.signed", aggregateId: id, payload: { version: next, digest } });
    return { version: next, digest };
  });
  return c.json({ ok: true, signed: result });
});

documentRoutes.post("/documents/:id/amend", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, documentAmendSchema);
  const signedAt = new Date();
  const result = await withStaffActor(c, async (tx) => {
    const document = await requireRows(await tx`
      select d.id, d.status, d.current_version, d.template_version_id, d.patient_id, d.template_id
        from documents d where d.id = ${id} and d.tenant_id = ${auth.activeTenant!.id} for update
    `, "Document not found");
    ensureMatch(body.expectedVersion, Number(document.currentVersion));
    const status = nextDocumentStatus(String(document.status) as DocumentStatus, "amend");
    const versionRow = await requireRows(await tx`
      select fields from document_template_versions where id = ${document.templateVersionId}
    `, "Template version not found");
    const fields = validateTemplateFields(versionRow.fields);
    const validation = validateDocumentContent(fields, body.content);
    if (!validation.valid) throw new ValidationError("Document content validation failed", validation.errors);
    const previous = await latestVersion(tx, id);
    const next = Number(document.currentVersion) + 1;
    const digest = await contentDigest(body.content);
    const signature = await hmacHex(
      c.get("deps").config.auditSigningKey,
      JSON.stringify({ documentId: id, version: next, contentDigest: digest, authorId: auth.user.id, signedAt: signedAt.toISOString() }),
    );
    await insertVersion(tx, {
      tenantId: auth.activeTenant!.id, documentId: id, version: next, previousVersionId: String(previous.id),
      status, content: body.content, changeNote: body.changeNote, authorUserId: auth.user.id,
      signedAt, signature, signatureKeyId: c.get("deps").config.auditSigningKeyId,
    });
    await tx`
      update documents set title = ${body.title}, occurred_at = ${new Date(body.occurredAt)}, status = ${status},
        current_version = ${next}, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.amend", {
      subjectPatientId: document.patientId ? String(document.patientId) : null,
      resourceType: "Document", resourceId: id, metadata: { version: next, changeNote: body.changeNote, digest },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "document.amended", aggregateId: id, payload: { version: next, digest } });
    return { version: next, digest };
  });
  return c.json({ ok: true, amended: result });
});

documentRoutes.post("/documents/:id/error", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, documentErrorSchema);
  const result = await withStaffActor(c, async (tx) => {
    const document = await requireRows(await tx`
      select id, status, current_version, patient_id from documents
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Document not found");
    ensureMatch(body.expectedVersion, Number(document.currentVersion));
    const status = nextDocumentStatus(String(document.status) as DocumentStatus, "error");
    const previous = await latestVersion(tx, id);
    const next = Number(document.currentVersion) + 1;
    await insertVersion(tx, {
      tenantId: auth.activeTenant!.id, documentId: id, version: next, previousVersionId: String(previous.id),
      status, content: previous.content as Record<string, unknown>, changeNote: body.reason,
      authorUserId: auth.user.id, signedAt: new Date(),
    });
    await tx`
      update documents set status = ${status}, current_version = ${next}, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "document.error", {
      subjectPatientId: document.patientId ? String(document.patientId) : null,
      resourceType: "Document", resourceId: id, metadata: { version: next, reason: body.reason },
    }));
    return { version: next };
  });
  return c.json({ ok: true, enteredInError: result });
});
