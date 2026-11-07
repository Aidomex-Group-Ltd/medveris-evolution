import { Hono } from "hono";
import {
  allergySchema,
  amendEntrySchema,
  conditionSchema,
  createDraftEntrySchema,
  enteredInErrorSchema,
  followUpSchema,
  observationSchema,
  referralSchema,
  signEntrySchema,
  updateDraftEntrySchema,
  uuidSchema,
  aiAssistSchema,
} from "@medveris/contracts";import { assertClinicalRead, assertClinicalWrite, assertSign as _assertSign, assertAuthorized, type ActorContext } from "@medveris/authz";
import { recordProfessionalDesignation } from "../services/clinical.js";
import { canonicalJson, contentDigest, type ClinicalEntryStatus, computePartographState as _computePartographState, buildAiNoteSuggestion, assessBmiRisk } from "@medveris/domain";
import { hmacHex } from "@medveris/auth";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, ensureMatch, parseJson } from "../lib/http.js";
import { logEvent } from "@medveris/platform";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { insertAllergy, insertObservation, validateClinicalCoding } from "../services/clinical.js";
import { loadStaffAccessActor } from "../services/access.js";
import { isIntegrationOperational } from "../integrations/registry.js";
import type { AppEnv } from "../types.js";

export const clinicalRoutes = new Hono<AppEnv>();




function actor(c: Parameters<typeof requireStaff>[0]): ActorContext {
  const auth = c.get("auth")!;
  return {
    userId: auth.user.id,
    roles: auth.activeTenant?.roles ?? [],
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId,
    mfaVerified: auth.mfaVerified,
    mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
    platformRoles: auth.platformRoles,
  };
}

async function encounterFor(tx: Tx, tenantId: string, encounterId: string) {
  const rows = await tx`select id, patient_id, state, version from encounters where id = ${encounterId} and tenant_id = ${tenantId} for update`;
  if (!rows[0]) throw new NotFoundError("Encounter not found");
  return rows[0];
}

async function currentEntry(tx: Tx, tenantId: string, entryId: string) {
  const rows = await tx`
    select ce.id, ce.patient_id, ce.encounter_id, ce.current_version, ce.status, ce.created_by, e.state as encounter_state
      from clinical_entries ce join encounters e on e.id = ce.encounter_id
     where ce.id = ${entryId} and ce.tenant_id = ${tenantId} for update
  `;
  if (!rows[0]) throw new NotFoundError("Clinical entry not found");
  return rows[0];
}

function _computeAgeInYears(birthDate: Date, asOf: Date): number {
  const years = asOf.getFullYear() - birthDate.getFullYear();
  const monthDiff = asOf.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < birthDate.getDate())) return years - 1;
  return years;
}

async function attachEntryVersion(
  c: Parameters<typeof requireStaff>[0],
  tx: Tx,
  input: {
    entryId: string;
    tenantId: string;
    patientId: string;
    encounterId: string;
    authorId: string;
    version: number;
    previousVersionId: string | null;
    status: ClinicalEntryStatus;
    changeNote: string;
    title: string;
    subjective: string;
    objective: string;
    assessment: string;
    plan: string;
    occurredAt: Date;
    signedAt: Date | null;
    aiDeps?: { available: boolean; baseUrl: string | null; token: string | null };
  },
): Promise<{ versionId: string; digest: string }> {
  // Optional AI-assisted clinical note suggestions. These are decision support only,
  // used only to fill fields the clinician left blank, and never replace authored content.
  const suggestion = await buildAiNoteSuggestion(
    {
      patientId: input.patientId,
      encounterId: input.encounterId,
      encounterState: "in-progress",
      existingContent: input.subjective + " " + input.objective,
    },
    {
      aiAvailable: input.aiDeps?.available ?? false,
      aiToken: input.aiDeps?.token ?? null,
      aiBaseUrl: input.aiDeps?.baseUrl ?? null,
    },
  );
  const content: Record<string, unknown> = {
    schemaVersion: "urn:medveris:schema:outpatient-note:1",
    title: input.title || suggestion.title || "Clinical note",
    subjective: input.subjective || suggestion.subjective || "",
    objective: input.objective || suggestion.objective || "",
    assessment: input.assessment || suggestion.assessment || "",
    plan: input.plan || suggestion.plan || "",
  };
  if (suggestion.reasoning) {
    content.reasoning = suggestion.reasoning;
  }
  const digest = await contentDigest(content);
  const versionId = crypto.randomUUID();
  const signaturePayload = canonicalJson({
    entryId: input.entryId,
    version: input.version,
    contentDigest: digest,
    authorId: input.authorId,
    occurredAt: input.occurredAt.toISOString(),
    status: input.status,
  });
  const signature = input.signedAt
    ? await hmacHex(c.get("deps").config.auditSigningKey, signaturePayload)
    : null;
  await tx`
    insert into clinical_entry_versions (id, entry_id, tenant_id, patient_id, encounter_id, version, previous_version_id,
      author_id, occurred_at, recorded_at, signed_at, status, change_note, title, content_schema, content, content_digest,
      signature, signature_key_id)
    values (${versionId}, ${input.entryId}, ${input.tenantId}, ${input.patientId}, ${input.encounterId}, ${input.version},
      ${input.previousVersionId}, ${input.authorId}, ${input.occurredAt}, ${new Date()}, ${input.signedAt}, ${input.status},
      ${input.changeNote}, ${input.title}, 'urn:medveris:schema:outpatient-note:1', ${tx.json(content as never)}, ${digest},
      ${signature}, ${signature ? c.get("deps").config.auditSigningKeyId : null})
  `;
  await tx`update clinical_entries set current_version = ${input.version}, status = ${input.status}, updated_at = now() where id = ${input.entryId}`;
  return { versionId, digest };
}

clinicalRoutes.post("/encounters/:id/entries", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, createDraftEntrySchema);
  const entryId = crypto.randomUUID();
  let bmiScreening: { bmi: number; riskLevel: "low" | "moderate" | "high" } | null = null;
  await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    if (!["triaged", "in-progress"].includes(String(encounter.state))) {
      throw new ConflictError("Triage must be completed before a clinical note can be documented");
    }
    if (String(encounter.state) === "triaged") {
      await tx`update encounters set state = 'in-progress', version = version + 1, clinician_user_id = coalesce(clinician_user_id, ${auth.user.id}), updated_at = now() where id = ${encounterId}`;
      await tx`update queue_entries set status = 'with-clinician', updated_at = now() where encounter_id = ${encounterId} and status not in ('completed','cancelled')`;
    }
    await tx`
      insert into clinical_entries (id, tenant_id, patient_id, encounter_id, current_version, status, created_by)
      values (${entryId}, ${auth.activeTenant!.id}, ${encounter.patientId}, ${encounterId}, 1, 'draft', ${auth.user.id})
    `;
    const patientRows = await tx`select public_id, date_of_birth, sex from patients where id = ${encounter.patientId} limit 1`;
    if (patientRows[0]) {
      const weight = Number(body.subjective?.match(/weight[: ]+(\d+(\.\d+)?)\s*(?:kg| Kilograms)/i)?.[1] ?? body.objective?.match(/weight[: ]+(\d+(\.\d+)?)\s*(?:kg| Kilograms)/i)?.[1] ?? 0);
      const height = Number(body.subjective?.match(/height[: ]+(\d+(\.\d+)?)\s*(?:m| meters|cm| centimetres)/i)?.[1] ?? body.objective?.match(/height[: ]+(\d+(\.\d+)?)\s*(?:m| meters)/i)?.[1] ?? 0);
      const weightKg = Number(body.objective?.match(/weight[: ]+(\d+(\.\d+)?)\s*kg/i)?.[1] ?? 0);
      const heightM = Number(body.objective?.match(/height[: ]+(\d+(\.\d+)?)\s*m/i)?.[1] ?? 0);
      const effectiveWeightKg = weightKg || weight || 0;
      const effectiveHeightM = heightM || (height > 3 ? height / 100 : height) || 0;
      if (effectiveWeightKg > 0 && effectiveHeightM > 0) {
        const bmiResult = assessBmiRisk(String(patientRows[0].sex), effectiveWeightKg, effectiveHeightM);
        if (bmiResult) {
          bmiScreening = bmiResult;
          await tx`
            insert into clinical_bmi_screenings (id, tenant_id, patient_id, encounter_id, entry_id, bmi, risk_level,
              weight_kg, height_m, computed_by, recorded_at)
            values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${encounter.patientId}, ${encounterId}, ${entryId},
              ${bmiResult.bmi}, ${bmiResult.riskLevel}, ${effectiveWeightKg}, ${effectiveHeightM}, ${auth.user.id}, now())
          `;
          await logEvent("info", "bmi.screened", {
            patientId: String(encounter.patientId),
            bmi: bmiResult.bmi,
            riskLevel: bmiResult.riskLevel,
          });
        }
      }
    }
    await attachEntryVersion(c, tx, {
      entryId,
      tenantId: auth.activeTenant!.id,
      patientId: String(encounter.patientId),
      encounterId,
      authorId: auth.user.id,
      version: 1,
      previousVersionId: null,
      status: "draft",
      changeNote: body.changeNote,
      title: body.title,
      subjective: body.subjective,
      objective: body.objective,
      assessment: body.assessment,
      plan: body.plan,
      occurredAt: new Date(body.clinicalOccurredAt),
      signedAt: null,
      aiDeps: {
        available: isIntegrationOperational(deps.config, "ai"),
        baseUrl: deps.config.ai.baseUrl,
        token: deps.config.ai.token,
      },
    });
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.entry.draft.create",
      subjectPatientId: String(encounter.patientId),
      resourceType: "ClinicalEntry",
      resourceId: entryId,
      ...auditMeta(c),
      metadata: { encounterId, version: 1 },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "clinical.entry.drafted",
      aggregateId: entryId,
      aggregateVersion: 1,
      payload: { entryId, encounterId },
    });
  });
  return c.json({ ok: true, entryId, version: 1, bmi: bmiScreening ?? null }, 201);
});

clinicalRoutes.put("/entries/:id/draft", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const entryId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, updateDraftEntrySchema);
  const result = await withStaffActor(c, async (tx) => {
    const entry = await currentEntry(tx, auth.activeTenant!.id, entryId);
    ensureMatch(body.expectedVersion, Number(entry.currentVersion));
    if (entry.status !== "draft") throw new ConflictError("Only a draft can be edited in place. Signed entries require an amendment.");
    const previous = await tx`select id from clinical_entry_versions where entry_id = ${entryId} and version = ${entry.currentVersion}`;
    const next = Number(entry.currentVersion) + 1;
    const attached = await attachEntryVersion(c, tx, {
      entryId,
      tenantId: auth.activeTenant!.id,
      patientId: String(entry.patientId),
      encounterId: String(entry.encounterId),
      authorId: auth.user.id,
      version: next,
      previousVersionId: String(previous[0]!.id),
      status: "draft",
      changeNote: body.changeNote,
      title: body.title,
      subjective: body.subjective,
      objective: body.objective,
      assessment: body.assessment,
      plan: body.plan,
      occurredAt: new Date(body.clinicalOccurredAt),
      signedAt: null,
    });
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.entry.draft.update",
      subjectPatientId: String(entry.patientId),
      resourceType: "ClinicalEntry",
      resourceId: entryId,
      ...auditMeta(c),
      metadata: { version: next, previousVersion: entry.currentVersion, digest: attached.digest },
    });
    return { version: next, versionId: attached.versionId };
  });
  return c.json({ ok: true, ...result });
});

clinicalRoutes.post("/entries/:id/sign", async (c) => {
  requireStaff(c);
  const access = await loadStaffAccessActor(c);
  assertAuthorized(access.actor, "clinical.note.sign", {
    kind: "clinical-record",
    tenantId: access.actor.tenantId,
    patientId: access.actor.patientId,
    requiresCredential: true,
  });
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const entryId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, signEntrySchema);
  const result = await withStaffActor(c, async (tx) => {
    const entry = await currentEntry(tx, auth.activeTenant!.id, entryId);
    ensureMatch(body.expectedVersion, Number(entry.currentVersion));
    if (entry.status !== "draft") throw new ConflictError("Only a draft can be signed");
    const encounterId = String(entry.encounterId);
    const version = await tx`
      select id, content_digest from clinical_entry_versions where entry_id = ${entryId} and version = ${entry.currentVersion} and status = 'draft'
    `;
    if (!version[0]) throw new ConflictError("The expected draft version could not be found");
    const signedAt = new Date();
    const signature = await hmacHex(
      deps.config.auditSigningKey,
      canonicalJson({ entryId, version: entry.currentVersion, contentDigest: version[0].contentDigest, authorId: auth.user.id, signedAt: signedAt.toISOString() }),
    );
    await tx`update clinical_entry_versions set status = 'signed', signed_at = ${signedAt}, signature = ${signature}, signature_key_id = ${deps.config.auditSigningKeyId} where id = ${version[0].id} and status = 'draft'`;
    await tx`update clinical_entries set status = 'signed', updated_at = now() where id = ${entryId}`;
    const primaryDepartment = access.summary?.departments?.[0];
    // staff_persons.id, not the user id: the designation snapshot FK references staff_persons.
    // loadStaffAccessActor already resolved it from staff_persons.user_id for this account.
    const practitionerStaffPersonId = access.summary.staffPersonId;
    if (!practitionerStaffPersonId) {
      throw new ForbiddenError("Signing requires a staff profile linked to this account");
    }
    await recordProfessionalDesignation(tx, {
      tenantId: auth.activeTenant!.id,
      practitionerStaffPersonId,
      practitionerUserId: auth.user.id,
      encounterId: encounterId,
      version: entry.currentVersion,
      designationCode: primaryDepartment?.cadreCode ?? "unknown",
      designationName: primaryDepartment?.cadreName ?? auth.user.id,
      category: primaryDepartment?.cadreCode
        ? (access.actor.cadreCodes?.[0] ?? "administrative")
        : "administrative",
      specialtyCodes: access.summary?.specialties ?? [],
    });
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.entry.sign",
      subjectPatientId: String(entry.patientId),
      resourceType: "ClinicalEntryVersion",
      resourceId: String(version[0].id),
      ...auditMeta(c),
      metadata: { entryId, version: entry.currentVersion, digest: version[0].contentDigest, signatureKeyId: deps.config.auditSigningKeyId },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "clinical.entry.signed",
      aggregateId: entryId,
      aggregateVersion: Number(entry.currentVersion),
      payload: { entryId, versionId: version[0].id, patientId: entry.patientId },
    });
    return { version: Number(entry.currentVersion), digest: version[0].contentDigest };
  });
  return c.json({ ok: true, signed: result });
});

clinicalRoutes.post("/entries/:id/amendments", async (c) => {
  requireStaff(c);
  const access = await loadStaffAccessActor(c);
  assertAuthorized(access.actor, "clinical.note.amend", {
    kind: "clinical-record",
    tenantId: access.actor.tenantId,
    patientId: access.actor.patientId,
    requiresCredential: true,
  });
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const entryId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, amendEntrySchema);
  const result = await withStaffActor(c, async (tx) => {
    const entry = await currentEntry(tx, auth.activeTenant!.id, entryId);
    ensureMatch(body.expectedVersion, Number(entry.currentVersion));
    if (entry.status !== "signed" && entry.status !== "amended") throw new ConflictError("Only a signed entry can be amended");
    const previous = await tx`select id from clinical_entry_versions where entry_id = ${entryId} and version = ${entry.currentVersion}`;
    const next = Number(entry.currentVersion) + 1;
    const attached = await attachEntryVersion(c, tx, {
      entryId,
      tenantId: auth.activeTenant!.id,
      patientId: String(entry.patientId),
      encounterId: String(entry.encounterId),
      authorId: auth.user.id,
      version: next,
      previousVersionId: String(previous[0]!.id),
      status: "amended",
      changeNote: body.changeNote,
      title: body.title,
      subjective: body.subjective,
      objective: body.objective,
      assessment: body.assessment,
      plan: body.plan,
      occurredAt: new Date(body.clinicalOccurredAt),
      signedAt: new Date(),
    });
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.entry.amend",
      subjectPatientId: String(entry.patientId),
      resourceType: "ClinicalEntryVersion",
      resourceId: attached.versionId,
      ...auditMeta(c),
      metadata: { entryId, version: next, previousVersion: entry.currentVersion, reason: body.changeNote, digest: attached.digest },
    });
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id,
      eventType: "clinical.entry.amended",
      aggregateId: entryId,
      aggregateVersion: next,
      payload: { entryId, versionId: attached.versionId, patientId: entry.patientId },
    });
    return { version: next, versionId: attached.versionId, digest: attached.digest };
  });
  return c.json({ ok: true, amendment: result }, 201);
});

clinicalRoutes.post("/entries/:id/entered-in-error", async (c) => {
  requireStaff(c);
  const access = await loadStaffAccessActor(c);
  assertAuthorized(access.actor, "clinical.note.error", {
    kind: "clinical-record",
    tenantId: access.actor.tenantId,
    patientId: access.actor.patientId,
    requiresCredential: true,
  });
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const entryId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, enteredInErrorSchema);
  const result = await withStaffActor(c, async (tx) => {
    const entry = await currentEntry(tx, auth.activeTenant!.id, entryId);
    ensureMatch(body.expectedVersion, Number(entry.currentVersion));
    if (entry.status !== "signed" && entry.status !== "amended") throw new ConflictError("Only a signed entry can be marked entered-in-error");
    const current = await tx`select id, title, content, occurred_at from clinical_entry_versions where entry_id = ${entryId} and version = ${entry.currentVersion}`;
    const versionId = crypto.randomUUID();
    const content = { ...(current[0]!.content as Record<string, unknown>), enteredInError: true };
    const digest = await contentDigest(content);
    await tx`
      insert into clinical_entry_versions (id, entry_id, tenant_id, patient_id, encounter_id, version, previous_version_id, author_id,
        occurred_at, recorded_at, signed_at, status, change_note, title, content_schema, content, content_digest, signature, signature_key_id)
      values (${versionId}, ${entryId}, ${auth.activeTenant!.id}, ${entry.patientId}, ${entry.encounterId}, ${Number(entry.currentVersion) + 1},
        ${current[0]!.id}, ${auth.user.id}, ${current[0]!.occurredAt}, ${new Date()}, ${new Date()}, 'entered-in-error', ${body.reason},
        ${current[0]!.title}, 'urn:medveris:schema:outpatient-note:1', ${tx.json(content as never)}, ${digest}, null, ${deps.config.auditSigningKeyId})
    `;
    await tx`update clinical_entries set current_version = ${Number(entry.currentVersion) + 1}, status = 'entered-in-error', updated_at = now() where id = ${entryId}`;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.entry.entered-in-error",
      subjectPatientId: String(entry.patientId),
      resourceType: "ClinicalEntryVersion",
      resourceId: versionId,
      ...auditMeta(c),
      metadata: { entryId, reason: body.reason, previousVersion: entry.currentVersion },
    });
    return { version: Number(entry.currentVersion) + 1, versionId };
  });
  return c.json({ ok: true, enteredInError: result });
});

clinicalRoutes.get("/entries/:id/versions", async (c) => {
  requireStaff(c);
  assertClinicalRead(actor(c));
  const auth = c.get("auth")!;
  const entryId = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const versions = await tx`
      select v.id, v.patient_id, v.version, v.previous_version_id, v.author_id, u.display_name as author_name, v.occurred_at, v.recorded_at,
             v.signed_at, v.status, v.change_note, v.title, v.content, v.content_digest, v.signature_key_id
        from clinical_entry_versions v join users u on u.id = v.author_id
       where v.entry_id = ${entryId} and v.tenant_id = ${auth.activeTenant!.id}
       order by v.version
    `;
    if (!versions.length) throw new NotFoundError("Clinical entry not found");
    await writeAudit(tx, c.get("deps").config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.entry.history.read",
      subjectPatientId: String(versions[0]!.patientId ?? ""),
      resourceType: "ClinicalEntry",
      resourceId: entryId,
      ...auditMeta(c),
    });
    return versions;
  });
  return c.json({ versions: data });
});

clinicalRoutes.post("/encounters/:id/observations", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, observationSchema);
  const id = await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    const observationId = await insertObservation(c, tx, {
      tenantId: auth.activeTenant!.id,
      patientId: String(encounter.patientId),
      encounterId,
      authorId: auth.user.id,
      coding: body.coding,
      value: body.value,
      unit: body.unit,
      occurredAt: new Date(body.occurredAt),
      source: "clinician",
    });
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "observation.create",
      subjectPatientId: String(encounter.patientId),
      resourceType: "Observation",
      resourceId: observationId,
      ...auditMeta(c),
      metadata: { code: body.coding.code, system: body.coding.system, unit: body.unit.code },
    });
    return observationId;
  });
  return c.json({ ok: true, observationId: id }, 201);
});

clinicalRoutes.post("/encounters/:id/conditions", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, conditionSchema);
  const id = await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    const coding = await validateClinicalCoding(c, body.coding, "diagnosis");
    const conditionId = crypto.randomUUID();
    await tx`
      insert into conditions (id, tenant_id, patient_id, encounter_id, snomed_version, snomed_code, display, original_text, coding,
        clinical_status, onset_date, note, author_id)
      values (${conditionId}, ${auth.activeTenant!.id}, ${encounter.patientId}, ${encounterId}, ${coding.version}, ${coding.code},
        ${coding.display}, ${coding.text ?? coding.display}, ${tx.json(coding as never)}, ${body.clinicalStatus}, ${body.onsetDate ?? null},
        ${body.note || null}, ${auth.user.id})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "condition.create",
      subjectPatientId: String(encounter.patientId),
      resourceType: "Condition",
      resourceId: conditionId,
      ...auditMeta(c),
      metadata: { code: coding.code, system: coding.system },
    });
    return conditionId;
  });
  return c.json({ ok: true, conditionId: id }, 201);
});

clinicalRoutes.post("/encounters/:id/allergies", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, allergySchema);
  const id = await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    const allergyId = await insertAllergy(c, tx, {
      tenantId: auth.activeTenant!.id,
      patientId: String(encounter.patientId),
      encounterId,
      authorId: auth.user.id,
      state: body.state,
      substance: body.substance ?? null,
      reaction: body.reaction ?? null,
      severity: body.severity,
      note: body.note || null,
    });
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "allergy.record",
      subjectPatientId: String(encounter.patientId),
      resourceType: "AllergyIntolerance",
      resourceId: allergyId,
      ...auditMeta(c),
      metadata: { state: body.state },
    });
    return allergyId;
  });
  return c.json({ ok: true, allergyId: id }, 201);
});

clinicalRoutes.post("/encounters/:id/follow-ups", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, followUpSchema);
  const id = await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    const followUpId = crypto.randomUUID();
    await tx`
      insert into follow_ups (id, tenant_id, patient_id, encounter_id, due_date, instructions, author_id)
      values (${followUpId}, ${auth.activeTenant!.id}, ${encounter.patientId}, ${encounterId}, ${body.dueDate}, ${body.instructions}, ${auth.user.id})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "follow-up.create",
      subjectPatientId: String(encounter.patientId),
      resourceType: "FollowUp",
      resourceId: followUpId,
      ...auditMeta(c),
    });
    return followUpId;
  });
  return c.json({ ok: true, followUpId: id }, 201);
});

clinicalRoutes.post("/encounters/:id/referrals", async (c) => {
  requireStaff(c);
  assertClinicalWrite(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, referralSchema);
  const id = await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    const referralId = crypto.randomUUID();
    await tx`
      insert into referrals (id, tenant_id, patient_id, encounter_id, to_facility, reason, priority, author_id)
      values (${referralId}, ${auth.activeTenant!.id}, ${encounter.patientId}, ${encounterId}, ${body.toFacility}, ${body.reason}, ${body.priority}, ${auth.user.id})
    `;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "referral.create",
      subjectPatientId: String(encounter.patientId),
      resourceType: "Referral",
      resourceId: referralId,
      ...auditMeta(c),
    });
    return referralId;
  });
  return c.json({ ok: true, referralId: id }, 201);
});

// AI-assisted note suggestion is decision support only. The suggest endpoint uses the AI schema the
// contracts package already defines; it does not accept BMI directly, and BMI is screened in the note
// drafting path where height/weight are observable in the note text.
clinicalRoutes.post("/ai/encounters/:id/suggest", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const encounterId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, aiAssistSchema);
  const result = await withStaffActor(c, async (tx) => {
    const encounter = await encounterFor(tx, auth.activeTenant!.id, encounterId);
    if (!["triaged", "in-progress", "completed"].includes(String(encounter.state))) {
      throw new ConflictError("AI note suggestions are only available for triaged, in-progress or completed encounters");
    }
    const suggestion = await buildAiNoteSuggestion(
      {
        patientId: String(encounter.patientId),
        encounterId,
        encounterState: String(encounter.state),
        existingContent: body.existingContent ?? "",
      },
      {
        aiAvailable: isIntegrationOperational(deps.config, "ai"),
        aiToken: deps.config.ai.token,
        aiBaseUrl: deps.config.ai.baseUrl,
      },
    );
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id,
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant!.roles,
      action: "clinical.ai.suggest",
      subjectPatientId: String(encounter.patientId),
      resourceType: "ClinicalAiSuggestion",
      resourceId: crypto.randomUUID(),
      ...auditMeta(c),
      metadata: {
        encounterId,
        aiAssistAvailable: isIntegrationOperational(deps.config, "ai") || !!(deps.config.ai.baseUrl || deps.config.ai.token),
      },
    });
    return {
      ok: true,
      encounterId,
      patientId: String(encounter.patientId),
      aiAssist: {
        available: isIntegrationOperational(deps.config, "ai") || !!(deps.config.ai.baseUrl || deps.config.ai.token),
        title: suggestion.title ?? null,
        subjective: suggestion.subjective ?? null,
        objective: suggestion.objective ?? null,
        assessment: suggestion.assessment ?? null,
        plan: suggestion.plan ?? null,
        reasoning: suggestion.reasoning ?? null,
      },
      disclaimer: "AI suggestions are decision support only and must be reviewed before any action. They do not replace clinical judgment, local protocols, or validated reference ranges.",
    };
  });
  return c.json(result, 200);
});

// Maternity labour-partograph alerting is decision support only. The thresholds used by the partograph
// helper are illustrative and have not been clinically validated for this deployment, so the route keeps
// the generated alerts visible rather than treating them as actionable findings.
clinicalRoutes.get("/maternity/episodes/:id/alerts", async (c) => {
  requireStaff(c);
  assertClinicalRead(actor(c));
  const auth = c.get("auth")!;
  const episodeId = uuidSchema.parse(c.req.param("id"));
  const alerts = await withStaffActor(c, async (tx) => {
    const episodeRows = await tx`
      select e.tenant_id, e.patient_id, e.status
        from maternity_episodes e
       where e.id = ${episodeId} and e.tenant_id = ${auth.activeTenant!.id}
       limit 1
    `;
    if (!episodeRows[0]) throw new NotFoundError("Maternity episode not found");
    const observations = await tx`
      select maternal, fetal, template_type, clinical_occurred_at, recorded_at, notes
        from labour_observations
       where episode_id = ${episodeId}
       order by clinical_occurred_at
    `;
    const episodeAlerts: { alert: string; severity: "info" | "warning" | "critical"; recordedAt: string; source: string }[] = [];
    for (const obs of observations) {
      const state = _computePartographState(
        (obs.maternal as Record<string, number | string | null>) ?? {},
        (obs.fetal as Record<string, number | string | null>) ?? {},
        (obs.template_type as "labour-care-guide" | "partograph") ?? "partograph",
      );
      for (const alert of state.alerts) {
        episodeAlerts.push({
          alert,
          severity: "warning",
          recordedAt: obs.recorded_at,
          source: "partograph",
        });
      }
      if (state.progressStatus === "arrested") {
        episodeAlerts.push({
          alert: "Labour progress status: arrested",
          severity: "critical",
          recordedAt: obs.recorded_at,
          source: "partograph",
        });
      } else if (state.progressStatus === "delayed") {
        episodeAlerts.push({
          alert: "Labour progress status: delayed",
          severity: "warning",
          recordedAt: obs.recorded_at,
          source: "partograph",
        });
      }
    }
    const storedAlerts = await tx`
      select id, alert, severity, recorded_at as recordedAt
        from labour_alerts
       where episode_id = ${episodeId}
       order by recorded_at desc
    `;
    return {
      episodeId,
      episodeStatus: episodeRows[0].status,
      alerts: [...episodeAlerts, ...storedAlerts.map((row) => ({ alert: row.alert, severity: row.severity, recordedAt: row.recordedAt, source: "manual" }))],
    };
  });
  return c.json(alerts);
});
