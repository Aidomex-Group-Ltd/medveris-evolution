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
} from "@medveris/contracts";
import { assertClinicalRead, assertClinicalWrite, assertSign, type ActorContext } from "@medveris/authz";
import { canonicalJson, contentDigest, type ClinicalEntryStatus } from "@medveris/domain";
import { hmacHex } from "@medveris/auth";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { insertAllergy, insertObservation, validateClinicalCoding } from "../services/clinical.js";
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
  },
): Promise<{ versionId: string; digest: string }> {
  const content = {
    schemaVersion: "urn:medveris:schema:outpatient-note:1",
    title: input.title,
    subjective: input.subjective,
    objective: input.objective,
    assessment: input.assessment,
    plan: input.plan,
  };
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
  return c.json({ ok: true, entryId, version: 1 }, 201);
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
  assertSign(actor(c));
  const auth = c.get("auth")!;
  const deps = c.get("deps");
  const entryId = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, signEntrySchema);
  const result = await withStaffActor(c, async (tx) => {
    const entry = await currentEntry(tx, auth.activeTenant!.id, entryId);
    ensureMatch(body.expectedVersion, Number(entry.currentVersion));
    if (entry.status !== "draft") throw new ConflictError("Only a draft can be signed");
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
  assertSign(actor(c));
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
  assertSign(actor(c));
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
