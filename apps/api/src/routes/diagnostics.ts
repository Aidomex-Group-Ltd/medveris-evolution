import { Hono } from "hono";
import {
  criticalAcknowledgementSchema,
  criticalCommunicationSchema,
  diagnosticAssignmentSchema,
  diagnosticReleaseSchema,
  diagnosticReportCorrectionSchema,
  diagnosticReportSchema,
  imagingStudySchema,
  labResultCorrectionSchema,
  labResultFinalizeSchema,
  labResultSchema,
  labTestSchema,
  orderTransitionSchema,
  serviceOrderSchema,
  specimenSchema,
  specimenTransitionSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertDiagnostics, permissionsForRoles, type Permission } from "@medveris/authz";
import { contentDigest } from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { assertIntegrationAvailable } from "../integrations/registry.js";
import type { AppEnv } from "../types.js";

export const diagnosticsRoutes = new Hono<AppEnv>();

const ORDER_FLOW: Record<string, string[]> = {
  ordered: ["collected", "cancelled"],
  collected: ["in-progress", "cancelled"],
  "in-progress": ["resulted", "cancelled"],
  resulted: [],
  cancelled: [],
};

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function can(c: Parameters<typeof requireStaff>[0], permission: Permission): boolean {
  return permissionsForRoles(requestActor(c).roles).has(permission);
}

async function loadOrderItem(c: Parameters<typeof requireStaff>[0], tx: Parameters<Parameters<typeof withStaffActor>[1]>[0], itemId: string) {
  const auth = c.get("auth")!;
  const rows = await tx`
    select i.id, i.order_id, i.status, i.lab_test_id, i.name, o.patient_id, o.encounter_id, o.order_type, o.status as order_status
      from service_order_items i join service_orders o on o.id = i.order_id
     where i.id = ${itemId} and i.tenant_id = ${auth.activeTenant!.id} for update
  `;
  return requireRows(rows, "Diagnostic order item not found");
}

diagnosticsRoutes.get("/lab-tests", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select * from lab_tests where tenant_id = ${auth.activeTenant!.id} order by name
  `);
  return c.json({ tests: rows });
});

diagnosticsRoutes.post("/lab-tests", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "laboratory", "facility_admin")) throw new ForbiddenError("The laboratory role is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, labTestSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into lab_tests (id, tenant_id, name, loinc_system, loinc_version, loinc_code, specimen_type, method, unit_code, mapped_reviewed, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.name}, ${body.loincSystem}, ${body.loincVersion}, ${body.loincCode},
        ${body.specimenType}, ${body.method || null}, ${body.unitCode}, ${body.mappedReviewed}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.test.create", {
      resourceType: "LabTest", resourceId: id,
      metadata: { loincCode: body.loincCode, loincVersion: body.loincVersion, mappedReviewed: body.mappedReviewed },
    }));
  });
  return c.json({ ok: true, test: { id } }, 201);
});

diagnosticsRoutes.get("/diagnostic-orders", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const type = c.req.query("type");
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select o.id, o.patient_id, o.encounter_id, o.order_type, o.priority, o.clinical_note, o.status, o.version,
           o.ordered_by, o.created_at, p.public_id, p.given_name, p.family_name, u.display_name as ordered_by_name,
           (select count(*)::int from service_order_items i where i.order_id = o.id) as item_count
      from service_orders o join patients p on p.id = o.patient_id join users u on u.id = o.ordered_by
     where o.tenant_id = ${auth.activeTenant!.id}
       ${type ? tx`and o.order_type = ${type}` : tx``}
       ${status ? tx`and o.status = ${status}` : tx``}
     order by o.created_at desc limit 200
  `);
  return c.json({ orders: rows });
});

diagnosticsRoutes.post("/diagnostic-orders", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "clinician", "nurse")) throw new ForbiddenError("Only clinical staff may place diagnostic orders");
  const auth = c.get("auth")!;
  const body = await parseJson(c, serviceOrderSchema);
  const orderId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const encounter = await requireRows(await tx`
      select id, patient_id from encounters where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id}
    `, "Encounter not found");
    if (String(encounter.patientId) !== body.patientId) throw new ValidationError("Encounter does not belong to the selected patient");
    if (body.orderType === "laboratory") {
      for (const item of body.items) {
        if (item.labTestId) {
          const test = await tx`select 1 from lab_tests where id = ${item.labTestId} and tenant_id = ${auth.activeTenant!.id}`;
          if (!test[0]) throw new ValidationError("A referenced laboratory test does not exist");
        }
      }
    }
    await tx`
      insert into service_orders (id, tenant_id, patient_id, encounter_id, order_type, priority, clinical_note, ordered_by)
      values (${orderId}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId}, ${body.orderType},
        ${body.priority}, ${body.clinicalNote}, ${auth.user.id})
    `;
    for (const item of body.items) {
      await tx`
        insert into service_order_items (id, tenant_id, order_id, lab_test_id, name, specimen_type)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${orderId}, ${item.labTestId ?? null}, ${item.name}, ${item.specimenType || null})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.order.create", {
      subjectPatientId: body.patientId, resourceType: "ServiceOrder", resourceId: orderId,
      metadata: { orderType: body.orderType, priority: body.priority, items: body.items.length },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "diagnostic.order.created", aggregateId: orderId, payload: { type: body.orderType } });
  });
  return c.json({ ok: true, order: { id: orderId } }, 201);
});

diagnosticsRoutes.get("/diagnostic-orders/:id", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select o.*, p.public_id, p.given_name, p.family_name from service_orders o join patients p on p.id = o.patient_id
       where o.id = ${id} and o.tenant_id = ${auth.activeTenant!.id}
    `, "Diagnostic order not found");
    const items = await tx`
      select i.*, (select row_to_json(r) from lab_results r where r.order_item_id = i.id order by r.version desc limit 1) as latest_result,
             (select row_to_json(s) from specimens s where s.order_item_id = i.id order by s.created_at desc limit 1) as latest_specimen,
             (select row_to_json(st) from imaging_studies st where st.order_item_id = i.id order by st.created_at desc limit 1) as imaging_study,
             (select row_to_json(dr) from diagnostic_reports dr where dr.order_item_id = i.id order by dr.version desc limit 1) as latest_report
        from service_order_items i where i.order_id = ${id} order by i.created_at
    `;
    return { order, items };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.order.read", {
    subjectPatientId: String(data.order.patientId), resourceType: "ServiceOrder", resourceId: id,
  })));
  return c.json(data);
});

diagnosticsRoutes.post("/diagnostic-orders/:id/transitions", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, orderTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select id, patient_id, order_type, status, version from service_orders
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Diagnostic order not found");
    ensureMatch(body.expectedVersion, Number(order.version));
    if (!(ORDER_FLOW[String(order.status)] ?? []).includes(body.status)) {
      throw new ConflictError(`Cannot move an order from ${order.status} to ${body.status}`);
    }
    if (body.status === "cancelled" && !body.reason) throw new ValidationError("A cancellation reason is required");
    await tx`
      update service_orders set status = ${body.status}, version = version + 1, updated_at = now() where id = ${id}
    `;
    if (body.status !== "cancelled") {
      await tx`update service_order_items set status = ${body.status} where order_id = ${id}`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `diagnostic.order.${body.status}`, {
      subjectPatientId: String(order.patientId), resourceType: "ServiceOrder", resourceId: id,
      metadata: { reason: body.reason ?? null, orderType: order.orderType },
    }));
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.post("/specimens", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "laboratory", "nurse", "clinician")) throw new ForbiddenError("Specimen collection requires laboratory or clinical staff");
  const auth = c.get("auth")!;
  const body = await parseJson(c, specimenSchema);
  const specimenId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const item = await loadOrderItem(c, tx, body.orderItemId);
    if (item.orderType !== "laboratory") throw new ValidationError("Specimens can only be linked to laboratory orders");
    await tx`
      insert into specimens (id, tenant_id, order_item_id, specimen_type, collected_at, created_by)
      values (${specimenId}, ${auth.activeTenant!.id}, ${body.orderItemId}, ${body.specimenType},
        ${body.collectedAt ? new Date(body.collectedAt) : new Date()}, ${auth.user.id})
    `;
    await tx`update service_order_items set status = 'collected' where id = ${body.orderItemId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "specimen.collect", {
      subjectPatientId: String(item.patientId), resourceType: "Specimen", resourceId: specimenId,
    }));
  });
  return c.json({ ok: true, specimen: { id: specimenId } }, 201);
});

diagnosticsRoutes.patch("/specimens/:id", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "laboratory")) throw new ForbiddenError("Specimen receipt requires the laboratory role");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, specimenTransitionSchema);
  await withStaffActor(c, async (tx) => {
    const specimen = await requireRows(await tx`
      select s.id, s.status, i.order_id, o.patient_id from specimens s
        join service_order_items i on i.id = s.order_item_id join service_orders o on o.id = i.order_id
       where s.id = ${id} and s.tenant_id = ${auth.activeTenant!.id} for update
    `, "Specimen not found");
    if (specimen.status !== "collected") throw new ConflictError("Only collected specimens can be received or rejected");
    if (body.status === "rejected" && !body.reason) throw new ValidationError("A specimen rejection reason is required");
    await tx`
      update specimens set status = ${body.status}, received_at = now(), rejection_reason = ${body.reason || null} where id = ${id}
    `;
    if (body.status === "received") await tx`update service_orders set status = 'in-progress', version = version + 1, updated_at = now() where id = ${specimen.orderId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `specimen.${body.status}`, {
      subjectPatientId: String(specimen.patientId), resourceType: "Specimen", resourceId: id, metadata: { reason: body.reason ?? null },
    }));
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.post("/lab-results", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, labResultSchema);
  const resultId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const item = await loadOrderItem(c, tx, body.orderItemId);
    if (item.orderType !== "laboratory") throw new ValidationError("Laboratory results require a laboratory order item");
    const specimen = await tx`
      select status from specimens where order_item_id = ${body.orderItemId} order by created_at desc limit 1
    `;
    if (!specimen[0] || specimen[0].status !== "received") throw new ConflictError("A received specimen is required before a result can be entered");
    if (body.status === "final") {
      throw new ForbiddenError("Enter the result as preliminary; it must be validated by someone other than the person who entered it");
    }
    if (!body.valueText && body.valueNum == null) throw new ValidationError("A numeric or textual result value is required");
    const previous = await tx`select id from lab_results where order_item_id = ${body.orderItemId} for update`;
    if (previous[0]) throw new ConflictError("A result already exists; use the correction workflow");
    const content = {
      valueNum: body.valueNum ?? null, valueText: body.valueText || null, unitCode: body.unitCode || null,
      referenceRange: body.referenceRange || null, interpretation: body.interpretation,
      critical: body.critical, status: "preliminary",
    };
    await tx`
      insert into lab_results (id, tenant_id, order_item_id, patient_id, value_num, value_text, unit_code, reference_range,
        interpretation, critical, status, authored_by)
      values (${resultId}, ${auth.activeTenant!.id}, ${body.orderItemId}, ${item.patientId},
        ${body.valueNum ?? null}, ${body.valueText || null}, ${body.unitCode || null}, ${body.referenceRange || null},
        ${body.interpretation}, ${body.critical}, 'preliminary', ${auth.user.id})
    `;
    await tx`
      insert into lab_result_versions (id, tenant_id, result_id, version, content, change_reason, author_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${resultId}, 1, ${tx.json(content as never)}, 'Initial result', ${auth.user.id})
    `;
    await tx`update service_order_items set status = 'resulted' where id = ${body.orderItemId}`;
    const remaining = await tx`
      select count(*)::int as count from service_order_items where order_id = ${item.orderId} and status <> 'resulted' and status <> 'cancelled'
    `;
    if (Number(remaining[0]?.count) === 0) await tx`update service_orders set status = 'resulted', version = version + 1, updated_at = now() where id = ${item.orderId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.result.create", {
      subjectPatientId: String(item.patientId), resourceType: "LabResult", resourceId: resultId,
      metadata: { critical: body.critical, status: body.status, interpretation: body.interpretation },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "lab.result.created", aggregateId: resultId, payload: { critical: body.critical } });
  });
  return c.json({ ok: true, result: { id: resultId } }, 201);
});

diagnosticsRoutes.post("/lab-results/:id/finalize", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!can(c, "diagnostic.result.validate")) {
    throw new ForbiddenError("Final laboratory result verification requires a clinician or laboratory validator");
  }
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, labResultFinalizeSchema);
  await withStaffActor(c, async (tx) => {
    const result = await requireRows(await tx`
      select id, patient_id, version, status, authored_by from lab_results
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Laboratory result not found");
    ensureMatch(body.expectedVersion, Number(result.version));
    if (String(result.authoredBy) === auth.user.id) {
      throw new ForbiddenError("A result must be validated by someone other than the person who entered it");
    }
    if (result.status !== "preliminary") throw new ConflictError("Only preliminary results can be finalized");
    await tx`
      update lab_results set status = 'final', verified_by = ${auth.user.id}, verified_at = now(), updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.result.finalize", {
      subjectPatientId: String(result.patientId), resourceType: "LabResult", resourceId: id,
      metadata: { note: body.note || null },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "lab.result.finalized", aggregateId: id });
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.post("/lab-results/:id/correct", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "clinician")) throw new ForbiddenError("Laboratory result corrections require a clinician");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, labResultCorrectionSchema);
  await withStaffActor(c, async (tx) => {
    const result = await requireRows(await tx`
      select id, patient_id, order_item_id, version, status from lab_results
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Laboratory result not found");
    ensureMatch(body.expectedVersion, Number(result.version));
    if (result.status !== "final") throw new ConflictError("Only final results can be corrected");
    const version = Number(result.version) + 1;
    const content = {
      valueNum: body.valueNum ?? null, valueText: body.valueText || null, unitCode: body.unitCode || null,
      referenceRange: body.referenceRange || null, interpretation: body.interpretation, critical: body.critical,
      status: "final", changeReason: body.changeReason,
    };
    await tx`
      update lab_results set value_num = ${body.valueNum ?? null}, value_text = ${body.valueText || null},
        unit_code = ${body.unitCode || null}, reference_range = ${body.referenceRange || null},
        interpretation = ${body.interpretation}, critical = ${body.critical}, version = ${version},
        verified_by = ${auth.user.id}, verified_at = now(), updated_at = now()
       where id = ${id}
    `;
    await tx`
      insert into lab_result_versions (id, tenant_id, result_id, version, content, change_reason, author_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${version}, ${tx.json(content as never)}, ${body.changeReason}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.result.correct", {
      subjectPatientId: String(result.patientId), resourceType: "LabResult", resourceId: id,
      metadata: { version, changeReason: body.changeReason },
    }));
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.post("/lab-results/:id/critical-communications", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "clinician", "nurse", "laboratory")) throw new ForbiddenError("Critical result communication requires clinical or laboratory staff");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, criticalCommunicationSchema);
  const commId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const result = await requireRows(await tx`
      select id, patient_id, critical, status from lab_results where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `, "Laboratory result not found");
    if (!result.critical) throw new ConflictError("Only critical results require a critical-result communication record");
    if (result.status !== "final") throw new ConflictError("Final verification is required before communicating a critical result");
    const recipient = await tx`
      select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.recipientUserId} and status = 'active'
    `;
    if (!recipient[0]) throw new ValidationError("The recipient is not an active facility member");
    await tx`
      insert into critical_communications (id, tenant_id, result_id, recipient_user_id, method, notes, communicated_by)
      values (${commId}, ${auth.activeTenant!.id}, ${id}, ${body.recipientUserId}, ${body.method}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.critical.communicate", {
      subjectPatientId: String(result.patientId), resourceType: "CriticalCommunication", resourceId: commId,
      metadata: { recipientUserId: body.recipientUserId, method: body.method },
    }));
  });
  return c.json({ ok: true, communication: { id: commId } }, 201);
});

diagnosticsRoutes.post("/imaging-studies", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!can(c, "radiology.study.register")) throw new ForbiddenError("Imaging study registration requires a radiographer or radiologist");
  const auth = c.get("auth")!;
  const body = await parseJson(c, imagingStudySchema);
  if (body.pacsState !== "not-configured") {
    assertIntegrationAvailable(c.get("deps").config, "dicomweb", "imaging-study.pacs-state",
      `the study was not recorded; PACS state '${body.pacsState}' requires a verified PACS connection`);
  }
  const studyId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const item = await loadOrderItem(c, tx, body.orderItemId);
    if (item.orderType !== "imaging") throw new ValidationError("Imaging studies require imaging order items");
    await tx`
      insert into imaging_studies (id, tenant_id, order_item_id, modality, body_site, study_instance_uid, accession, pacs_state, reconciliation_note, created_by)
      values (${studyId}, ${auth.activeTenant!.id}, ${body.orderItemId}, ${body.modality}, ${body.bodySite},
        ${body.studyInstanceUid || null}, ${body.accession || null}, ${body.pacsState}, ${body.reconciliationNote || null}, ${auth.user.id})
    `;
    await tx`update service_order_items set status = 'in-progress' where id = ${body.orderItemId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "imaging.study.create", {
      subjectPatientId: String(item.patientId), resourceType: "ImagingStudy", resourceId: studyId,
      metadata: { modality: body.modality, pacsState: body.pacsState },
    }));
  });
  return c.json({ ok: true, study: { id: studyId } }, 201);
});

diagnosticsRoutes.post("/diagnostic-reports", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!can(c, "radiology.report.draft")) throw new ForbiddenError("Diagnostic reports require radiology staff");
  const auth = c.get("auth")!;
  const body = await parseJson(c, diagnosticReportSchema);
  if (body.status === "final" && !can(c, "radiology.report.sign")) throw new ForbiddenError("Only a radiologist can issue a final report");
  const reportId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const item = await loadOrderItem(c, tx, body.orderItemId);
    if (item.orderType !== "imaging") throw new ValidationError("Diagnostic reports require imaging order items");
    if (body.studyId) {
      const study = await tx`select 1 from imaging_studies where id = ${body.studyId} and order_item_id = ${body.orderItemId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!study[0]) throw new ValidationError("The study does not belong to this order item");
    }
    const existing = await tx`select id from diagnostic_reports where order_item_id = ${body.orderItemId} for update`;
    if (existing[0]) throw new ConflictError("A report already exists; use the correction workflow");
    const content = { findings: body.findings, impression: body.impression, critical: body.critical, status: body.status };
    await tx`
      insert into diagnostic_reports (id, tenant_id, order_item_id, study_id, patient_id, findings, impression, critical,
        status, authored_by, verified_by, verified_at)
      values (${reportId}, ${auth.activeTenant!.id}, ${body.orderItemId}, ${body.studyId ?? null}, ${item.patientId},
        ${body.findings}, ${body.impression}, ${body.critical}, ${body.status}, ${auth.user.id},
        ${body.status === "final" ? auth.user.id : null}, ${body.status === "final" ? new Date() : null})
    `;
    await tx`
      insert into diagnostic_report_versions (id, tenant_id, report_id, version, content, change_reason, author_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${reportId}, 1, ${tx.json(content as never)}, 'Initial report', ${auth.user.id})
    `;
    await tx`update service_order_items set status = 'resulted' where id = ${body.orderItemId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.report.create", {
      subjectPatientId: String(item.patientId), resourceType: "DiagnosticReport", resourceId: reportId,
      metadata: { critical: body.critical, status: body.status },
    }));
  });
  return c.json({ ok: true, report: { id: reportId } }, 201);
});

diagnosticsRoutes.post("/diagnostic-reports/:id/correct", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!can(c, "radiology.report.sign")) throw new ForbiddenError("Diagnostic report corrections require a radiologist");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, diagnosticReportCorrectionSchema);
  await withStaffActor(c, async (tx) => {
    const report = await requireRows(await tx`
      select id, patient_id, version, status from diagnostic_reports where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Diagnostic report not found");
    ensureMatch(body.expectedVersion, Number(report.version));
    if (report.status !== "final") throw new ConflictError("Only final reports can be corrected");
    const version = Number(report.version) + 1;
    const content = { findings: body.findings, impression: body.impression, critical: body.critical, status: "final", changeReason: body.changeReason };
    await tx`
      update diagnostic_reports set findings = ${body.findings}, impression = ${body.impression}, critical = ${body.critical},
        version = ${version}, verified_by = ${auth.user.id}, verified_at = now(), updated_at = now() where id = ${id}
    `;
    await tx`
      insert into diagnostic_report_versions (id, tenant_id, report_id, version, content, change_reason, author_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${version}, ${tx.json(content as never)}, ${body.changeReason}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.report.correct", {
      subjectPatientId: String(report.patientId), resourceType: "DiagnosticReport", resourceId: id,
      metadata: { version, changeReason: body.changeReason },
    }));
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.get("/patients/:id/diagnostics", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("id"));
  const linked = await withStaffActor(c, async (tx) => tx`
    select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${patientId}
  `);
  if (!linked[0]) throw new NotFoundError("Patient is not linked to this facility");
  const data = await withStaffActor(c, async (tx) => {
    const results = await tx`
      select r.*, i.name as test_name, u.display_name as verified_by_name
        from lab_results r join service_order_items i on i.id = r.order_item_id left join users u on u.id = r.verified_by
       where r.patient_id = ${patientId} and r.tenant_id = ${auth.activeTenant!.id} order by r.created_at desc
    `;
    const reports = await tx`
      select r.*, i.name as study_name, u.display_name as verified_by_name
        from diagnostic_reports r join service_order_items i on i.id = r.order_item_id left join users u on u.id = r.verified_by
       where r.patient_id = ${patientId} and r.tenant_id = ${auth.activeTenant!.id} order by r.created_at desc
    `;
    return { results, reports, digest: await contentDigest({ results: results.length, reports: reports.length }) };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.patient.read", {
    subjectPatientId: patientId, resourceType: "DiagnosticSummary", resourceId: patientId,
  })));
  return c.json(data);
});

diagnosticsRoutes.get("/diagnostic-reporting/worklist", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select o.id, o.order_type, o.priority, o.clinical_note, o.status, o.created_at, o.assigned_reporter_id, o.reported_at,
           p.public_id, p.given_name, p.family_name, u.display_name as assigned_reporter_name,
           (select count(*)::int from service_order_items i where i.order_id = o.id) as item_count,
           (select count(*)::int from service_order_items i where i.order_id = o.id and i.status not in ('resulted','cancelled')) as pending_items
      from service_orders o
      join patients p on p.id = o.patient_id
      left join users u on u.id = o.assigned_reporter_id
     where o.tenant_id = ${auth.activeTenant!.id} and o.order_type in ('laboratory','imaging')
       and o.status not in ('cancelled')
     order by case o.priority when 'emergency' then 0 when 'urgent' then 1 else 2 end, o.created_at asc
     limit 200
  `);
  return c.json({ worklist: rows });
});

diagnosticsRoutes.post("/diagnostic-orders/:id/assign", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "laboratory", "radiology", "facility_admin")) {
    throw new ForbiddenError("Reporter assignment requires laboratory, radiology or facility administration");
  }
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, diagnosticAssignmentSchema);
  await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select id, patient_id, order_type, status from service_orders where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Diagnostic order not found");
    if (["resulted", "cancelled"].includes(String(order.status))) throw new ConflictError("A completed or cancelled order cannot be reassigned");
    const reporter = await tx`
      select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.reporterUserId} and status = 'active'
    `;
    if (!reporter[0]) throw new ValidationError("The reporter is not an active facility member");
    await tx`
      update service_orders set assigned_reporter_id = ${body.reporterUserId}, version = version + 1, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.order.assign", {
      subjectPatientId: String(order.patientId), resourceType: "ServiceOrder", resourceId: id,
      metadata: { orderType: order.orderType, reporterUserId: body.reporterUserId },
    }));
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.get("/critical-communications", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const unacknowledged = c.req.query("unacknowledged") === "true";
  const rows = await withStaffActor(c, async (tx) => tx`
    select c.id, c.result_id, c.recipient_user_id, c.method, c.notes, c.created_at, c.acknowledged_at,
           c.acknowledgement_note, r.value_num, r.value_text, r.unit_code, r.patient_id,
           p.public_id, p.given_name, p.family_name, u.display_name as recipient_name, rv.display_name as acknowledged_by_name
      from critical_communications c
      join lab_results r on r.id = c.result_id
      join patients p on p.id = r.patient_id
      join users u on u.id = c.recipient_user_id
      left join users rv on rv.id = c.acknowledged_by
     where c.tenant_id = ${auth.activeTenant!.id}
       ${unacknowledged ? tx`and c.acknowledged_at is null` : tx``}
     order by c.created_at desc limit 200
  `);
  return c.json({ communications: rows });
});

diagnosticsRoutes.post("/critical-communications/:id/acknowledge", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "clinician", "nurse")) throw new ForbiddenError("Critical-result acknowledgement requires clinical staff");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, criticalAcknowledgementSchema);
  await withStaffActor(c, async (tx) => {
    const communication = await requireRows(await tx`
      select id, recipient_user_id, result_id, acknowledged_at from critical_communications
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Critical communication not found");
    if (communication.acknowledgedAt) throw new ConflictError("This critical result has already been acknowledged");
    await tx`
      update critical_communications set acknowledged_at = now(), acknowledged_by = ${auth.user.id},
        acknowledgement_note = ${body.note} where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.critical.acknowledge", {
      resourceType: "CriticalCommunication", resourceId: id,
      metadata: { resultId: String(communication.resultId), note: body.note },
    }));
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.post("/lab-results/:id/release", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "clinician", "laboratory", "facility_admin")) throw new ForbiddenError("Result release requires laboratory or clinical staff");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, diagnosticReleaseSchema);
  await withStaffActor(c, async (tx) => {
    const result = await requireRows(await tx`
      select id, patient_id, status, version, reported_at from lab_results where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Laboratory result not found");
    if (body.expectedVersion) ensureMatch(body.expectedVersion, Number(result.version));
    if (result.status !== "final") throw new ConflictError("Only a final verified result can be released");
    if (result.reportedAt) throw new ConflictError("This result has already been released");
    await tx`
      update lab_results set reported_at = now(), release_note = ${body.releaseNote}, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "lab.result.release", {
      subjectPatientId: String(result.patientId), resourceType: "LabResult", resourceId: id,
      metadata: { releaseNote: body.releaseNote },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "lab.result.released", aggregateId: id });
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.post("/diagnostic-reports/:id/release", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  if (!hasRole(c, "radiology", "clinician", "facility_admin")) throw new ForbiddenError("Report release requires radiology or clinical staff");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, diagnosticReleaseSchema);
  await withStaffActor(c, async (tx) => {
    const report = await requireRows(await tx`
      select id, patient_id, status, version, reported_at from diagnostic_reports where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Diagnostic report not found");
    if (body.expectedVersion) ensureMatch(body.expectedVersion, Number(report.version));
    if (report.status !== "final") throw new ConflictError("Only a final signed report can be released");
    if (report.reportedAt) throw new ConflictError("This report has already been released");
    await tx`
      update diagnostic_reports set reported_at = now(), release_note = ${body.releaseNote}, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "diagnostic.report.release", {
      subjectPatientId: String(report.patientId), resourceType: "DiagnosticReport", resourceId: id,
      metadata: { releaseNote: body.releaseNote },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "diagnostic.report.released", aggregateId: id });
  });
  return c.json({ ok: true });
});

diagnosticsRoutes.get("/diagnostic-reporting/releasable", async (c) => {
  requireStaff(c);
  assertDiagnostics(requestActor(c));
  const auth = c.get("auth")!;
  const data = await withStaffActor(c, async (tx) => {
    const results = await tx`
      select r.id, 'laboratory' as kind, r.patient_id, r.verified_at, r.created_at, i.name as item_name,
             p.public_id, p.given_name, p.family_name
        from lab_results r
        join service_order_items i on i.id = r.order_item_id
        join patients p on p.id = r.patient_id
       where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'final' and r.reported_at is null
       order by r.created_at
    `;
    const reports = await tx`
      select r.id, 'imaging' as kind, r.patient_id, r.verified_at, r.created_at, i.name as item_name,
             p.public_id, p.given_name, p.family_name
        from diagnostic_reports r
        join service_order_items i on i.id = r.order_item_id
        join patients p on p.id = r.patient_id
       where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'final' and r.reported_at is null
       order by r.created_at
    `;
    return [...results, ...reports];
  });
  return c.json({ releasable: data });
});
