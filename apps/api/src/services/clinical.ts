import type { Context } from "hono";
import type { Coding } from "@medveris/contracts";
import type { Tx } from "@medveris/db";
import type { AppEnv } from "../types.js";
import { ValidationError } from "../lib/errors.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { createTerminology, FIELD_VALUE_SETS, LOINC_SYSTEM, UCUM_SYSTEM, type TerminologyAdapter } from "../terminology/index.js";

export function terminology(c: Context<AppEnv>): TerminologyAdapter {
  return createTerminology(c.get("deps").config);
}

export async function validateClinicalCoding(c: Context<AppEnv>, coding: Coding, field: keyof typeof FIELD_VALUE_SETS): Promise<Coding & { version: string; validationStatus: string; valueSet: string; valueSetVersion: string; validatedAt: string }> {
  const valueSet = FIELD_VALUE_SETS[field];
  if (!valueSet) throw new ValidationError(`Unknown clinical coding field: ${field}`);
  const adapter = terminology(c);
  const result = await adapter.validateCode({
    system: coding.system,
    code: coding.code,
    version: coding.version,
    valueSet,
  });
  if (!result.result) {
    throw new ValidationError(result.message ?? "The clinical code is not valid for this field", {
      system: coding.system,
      code: coding.code,
      valueSet,
      terminologyMode: adapter.mode,
    });
  }
  return {
    ...coding,
    version: result.version || coding.version,
    display: result.display || coding.display,
    text: coding.text ?? coding.display,
    validationStatus: "validated",
    valueSet,
    valueSetVersion: result.valueSetVersion ?? "1.0.0",
    validatedAt: new Date().toISOString(),
  };
}

export async function validateUnit(c: Context<AppEnv>, unit: { code: string; system: string }): Promise<{ code: string; system: string; version: string }> {
  if (unit.system !== UCUM_SYSTEM) throw new ValidationError("Quantitative units must use UCUM");
  const adapter = terminology(c);
  const result = await adapter.validateCode({
    system: UCUM_SYSTEM,
    code: unit.code,
    valueSet: FIELD_VALUE_SETS.unit,
  });
  if (!result.result) throw new ValidationError(result.message ?? "The unit is not valid for this field", { unit: unit.code });
  return { code: unit.code, system: UCUM_SYSTEM, version: result.version };
}

export async function insertObservation(
  c: Context<AppEnv>,
  tx: Tx,
  input: {
    tenantId: string;
    patientId: string;
    encounterId: string;
    authorId: string;
    coding: Coding;
    value: number;
    unit: { code: string; system: string };
    occurredAt: Date;
    source: string;
    sensitivity?: string[];
  },
): Promise<string> {
  const coding = await validateClinicalCoding(c, input.coding, "observation");
  const unit = await validateUnit(c, input.unit);
  if (coding.system !== LOINC_SYSTEM) throw new ValidationError("Observation identity must use LOINC");
  if (Number.isNaN(input.value)) throw new ValidationError("Observation value must be a finite number");
  const id = crypto.randomUUID();
  await tx`
    insert into observations (id, tenant_id, patient_id, encounter_id, loinc_system, loinc_version, loinc_code, display,
      original_text, coding, value_num, unit_code, unit_system, occurred_at, recorded_at, author_id, status, sensitivity)
    values (${id}, ${input.tenantId}, ${input.patientId}, ${input.encounterId}, ${LOINC_SYSTEM}, ${coding.version},
      ${coding.code}, ${coding.display}, ${coding.text ?? coding.display}, ${tx.json(coding as never)},
      ${input.value}, ${unit.code}, ${unit.system}, ${input.occurredAt}, ${new Date()}, ${input.authorId}, 'final',
      ${input.sensitivity ?? []})
  `;
  return id;
}

export async function insertAllergy(
  c: Context<AppEnv>,
  tx: Tx,
  input: {
    tenantId: string;
    patientId: string;
    encounterId: string;
    authorId: string;
    state: "unknown" | "none" | "recorded";
    substance: Coding | null;
    reaction: Coding | null;
    severity: "mild" | "moderate" | "severe" | "unknown";
    note: string | null;
    sensitivity?: string[];
  },
): Promise<string> {
  let substance = input.substance;
  let reaction = input.reaction;
  if (input.state === "recorded") {
    if (!substance) throw new ValidationError("A recorded allergy requires a substance");
    substance = await validateClinicalCoding(c, substance, "allergy-substance");
    if (reaction) reaction = await validateClinicalCoding(c, reaction, "allergy-reaction");
  } else {
    substance = null;
    reaction = null;
  }
  const id = crypto.randomUUID();
  await tx`
    insert into allergies (id, tenant_id, patient_id, encounter_id, state, substance_coding, reaction_coding, severity, note,
      author_id, recorded_at, sensitivity)
    values (${id}, ${input.tenantId}, ${input.patientId}, ${input.encounterId}, ${input.state},
      ${substance ? tx.json(substance as never) : null}, ${reaction ? tx.json(reaction as never) : null},
      ${input.severity}, ${input.note}, ${input.authorId}, ${new Date()}, ${input.sensitivity ?? []})
  `;
  return id;
}

/**
 * Complete a triage record and advance the encounter into in-progress so a
 * clinician can take over. This is the persisted "completed triage" the
 * clinician will read back: the record is written with the nurse who acted and
 * the encounter moves to in-progress atomically.
 *
 * The prerequisite is preserved: clinical notes may only be documented once an
 * encounter has been triaged and moved to in-progress, and triage is a
 * persisted completed record rather than a transient UI state.
 */
export async function completeTriage(
  c: Context<AppEnv>,
  tx: Tx,
  input: {
    tenantId: string;
    encounterId: string;
    patientId: string;
    nurseUserId: string;
    complaint: string;
    urgency: string;
    notes: string | null;
    observationIds: string[];
  },
): Promise<{ triageId: string; encounterVersion: number }> {
  const { complaint, urgency, notes, nurseUserId, observationIds } = input;
  const id = crypto.randomUUID();
  await tx`
    insert into triage_records (id, tenant_id, encounter_id, patient_id, complaint, urgency, notes, nurse_user_id)
    values (${id}, ${input.tenantId}, ${input.encounterId}, ${input.patientId}, ${complaint},
      ${urgency}, ${notes || null}, ${nurseUserId})
  `;
  for (const _observationId of observationIds) {
    await tx`
      update clinical_entries set status = 'in-progress', updated_at = now(),
        clinician_user_id = coalesce(clinician_user_id, ${input.nurseUserId}) where id = ${input.encounterId}
    `;
  }
  await tx`
    update encounters set state = 'in-progress', version = version + 1, clinician_user_id = coalesce(clinician_user_id, ${input.nurseUserId}), updated_at = now()
     where id = ${input.encounterId}
  `;
  await tx`
    update queue_entries set status = 'with-clinician', updated_at = now() where encounter_id = ${input.encounterId} and status not in ('completed','cancelled')
  `;
  await writeAudit(tx, c.get("deps").config, {
    tenantId: input.tenantId,
    actorUserId: nurseUserId,
    actorKind: "staff",
    action: "encounter.triaged",
    subjectPatientId: input.patientId,
    resourceType: "Encounter",
    resourceId: input.encounterId,
    metadata: { urgency, observationCount: observationIds.length },
  });
  await writeOutbox(tx, {
    tenantId: input.tenantId,
    eventType: "encounter.triaged",
    aggregateId: input.encounterId,
    aggregateVersion: 1,
    payload: { encounterId: input.encounterId, urgency, observationCount: observationIds.length },
  });
  return { triageId: id, encounterVersion: 1 };
}

/**
 * Capture an immutable snapshot of the signer's professional designation at sign time.
 *
 * This keeps the signed document's title and speciality stable even when the
 * practitioner changes their catalogue assignment later. Inactive catalogue
 * entries never rewrite historical signed documents.
 */
export async function recordProfessionalDesignation(
  tx: Tx,
  input: {
    tenantId: string;
    practitionerStaffPersonId: string;
    practitionerUserId: string;
    encounterId: string;
    version: number;
    designationCode: string;
    designationName: string;
    category: string;
    specialtyCodes: string[];
  },
): Promise<void> {
  const id = crypto.randomUUID();
  await tx`
    insert into professional_designations (id, tenant_id, practitioner_staff_person_id, practitioner_user_id,
      encounter_id, version, designation_code, designation_name, category, specialty_codes)
    values (${id}, ${input.tenantId}, ${input.practitionerStaffPersonId}, ${input.practitionerUserId},
      ${input.encounterId}, ${input.version}, ${input.designationCode}, ${input.designationName},
      ${input.category}, ${tx.array(input.specialtyCodes) ?? '[]'})
  `;
}
