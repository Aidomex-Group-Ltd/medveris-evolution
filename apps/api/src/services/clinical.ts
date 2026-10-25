import type { Context } from "hono";
import type { Coding } from "@medveris/contracts";
import type { Tx } from "@medveris/db";
import type { AppEnv } from "../types.js";
import { ValidationError } from "../lib/errors.js";
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
