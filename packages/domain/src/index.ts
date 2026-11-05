import { DomainError } from "./errors.js";
export { DomainError } from "./errors.js";
export * from "./catalog.js";
export * from "./onboarding-catalogue.js";
export * from "./radiology.js";
export * from "./facility-classification.js";
export * from "./hmis.js";
export * from "./workflow.js";
export * from "./integrity.js";
export * from "./billing.js";
export * from "./subscription-interval.js";
export * from "./currency.js";
export type EncounterState =
  | "planned"
  | "arrived"
  | "triaged"
  | "in-progress"
  | "completed"
  | "cancelled"
  | "entered-in-error";

const encounterTransitions: Record<EncounterState, EncounterState[]> = {
  planned: ["arrived", "cancelled"],
  arrived: ["triaged", "in-progress", "cancelled"],
  triaged: ["in-progress", "cancelled"],
  "in-progress": ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  "entered-in-error": [],
};

export function canTransitionEncounter(from: EncounterState, to: EncounterState): boolean {
  return encounterTransitions[from]?.includes(to) ?? false;
}

export type ClinicalEntryStatus = "draft" | "signed" | "amended" | "entered-in-error";

export function nextEntryStatus(current: ClinicalEntryStatus, action: "sign" | "amend" | "error"): ClinicalEntryStatus {
  if (action === "sign") {
    if (current !== "draft") throw new DomainError("Only a draft can be signed");
    return "signed";
  }
  if (action === "amend") {
    if (current !== "signed" && current !== "amended") throw new DomainError("Only a signed entry can be amended");
    return "amended";
  }
  if (current !== "signed" && current !== "amended") throw new DomainError("Only a signed entry can be marked entered-in-error");
  return "entered-in-error";
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomPatientPublicId(random = crypto.getRandomValues(new Uint8Array(10))): string {
  if (random.length !== 10) throw new Error("random source must provide 10 bytes");
  let body = "";
  let bits = 0;
  let value = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      body += CROCKFORD[(value >>> bits) & 31];
    }
  }
  if (body.length < 16) body = body.padEnd(16, "0");
  body = body.slice(0, 16);
  return `MV-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

/** A facility medical record number unique within the facility because it carries the whole public ID body. */
export function localMedicalRecordNumber(facilitySlug: string, publicId: string): string {
  if (!isPatientPublicId(publicId)) throw new Error("A patient public ID is required");
  return `MRN-${facilitySlug.slice(0, 8).toUpperCase()}-${publicId.slice(3).replaceAll("-", "")}`;
}

export function isPatientPublicId(value: string): boolean {
  return /^MV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function contentDigest(content: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(content))}`;
}

export function parseCoding(input: unknown): CodingInput {
  if (!input || typeof input !== "object") throw new DomainError("coding is required");
  const obj = input as Record<string, unknown>;
  const system = String(obj.system ?? "");
  const version = String(obj.version ?? "");
  const code = String(obj.code ?? "");
  const display = String(obj.display ?? "");
  const originalText = String(obj.display ?? obj.text ?? "");
  if (!system || !version || !code) throw new DomainError("coding requires system, version and code");
  if (!display) throw new DomainError("coding requires display");
  if (code.length > 100) throw new DomainError("code is too long");
  return {
    system,
    version,
    code,
    display,
    originalText,
    userSelected: obj.userSelected === true,
    validationStatus: (obj.validationStatus as CodingValidationStatus) ?? "unvalidated-local",
    valueSet: obj.valueSet ? String(obj.valueSet) : null,
    valueSetVersion: obj.valueSetVersion ? String(obj.valueSetVersion) : null,
    validatedAt: obj.validatedAt ? String(obj.validatedAt) : null,
  };
}

export type CodingValidationStatus = "validated" | "unvalidated-local" | "inactive" | "invalid";

export interface CodingInput {
  system: string;
  version: string;
  code: string;
  display: string;
  originalText: string;
  userSelected: boolean;
  validationStatus: CodingValidationStatus;
  valueSet: string | null;
  valueSetVersion: string | null;
  validatedAt: string | null;
}

export function categoryAllowed(categories: string[], category: string): boolean {
  return categories.includes("*") || categories.includes(category);
}

export const EXCHANGE_CATEGORIES = [
  "encounter",
  "note",
  "observation",
  "condition",
  "allergy",
  "follow-up",
  "referral",
] as const;
export type ExchangeCategory = (typeof EXCHANGE_CATEGORIES)[number];

export const SENSITIVITY_CATEGORIES = ["mental-health", "reproductive-health", "genetic", "hiv"] as const;

export type FollowUpStatus = "pending" | "completed" | "cancelled";

const followUpTransitions: Record<FollowUpStatus, FollowUpStatus[]> = {
  pending: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionFollowUp(from: FollowUpStatus, to: FollowUpStatus): boolean {
  return followUpTransitions[from]?.includes(to) ?? false;
}

export type ReferralStatus = "pending" | "accepted" | "declined" | "completed" | "cancelled";

const referralTransitions: Record<ReferralStatus, ReferralStatus[]> = {
  pending: ["accepted", "declined", "cancelled"],
  accepted: ["completed", "cancelled"],
  declined: [],
  completed: [],
  cancelled: [],
};

export function canTransitionReferral(from: ReferralStatus, to: ReferralStatus): boolean {
  return referralTransitions[from]?.includes(to) ?? false;
}

export type AppointmentStatus = "scheduled" | "arrived" | "completed" | "cancelled" | "no-show";

const appointmentTransitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ["cancelled", "no-show"],
  arrived: [],
  completed: [],
  cancelled: [],
  "no-show": [],
};

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return appointmentTransitions[from]?.includes(to) ?? false;
}

// Organisation, workforce and document-registry invariants.

export type OnboardingStatus =
  | "invited"
  | "identity"
  | "employment"
  | "professional"
  | "assignments"
  | "credentials"
  | "privileges"
  | "review"
  | "access"
  | "induction"
  | "active"
  | "rejected"
  | "withdrawn";

const onboardingTransitions: Record<OnboardingStatus, OnboardingStatus[]> = {
  invited: ["identity", "withdrawn"],
  identity: ["employment", "withdrawn"],
  employment: ["professional", "withdrawn"],
  professional: ["assignments", "withdrawn"],
  assignments: ["credentials", "withdrawn"],
  credentials: ["privileges", "withdrawn"],
  privileges: ["review", "withdrawn"],
  review: ["access", "rejected", "credentials"],
  access: ["induction", "withdrawn"],
  induction: ["active", "withdrawn"],
  active: ["withdrawn"],
  rejected: [],
  withdrawn: [],
};

export function canAdvanceOnboarding(from: OnboardingStatus, to: OnboardingStatus): boolean {
  return onboardingTransitions[from]?.includes(to) ?? false;
}

export type DocumentStatus = "draft" | "signed" | "amended" | "entered-in-error";

export function nextDocumentStatus(current: DocumentStatus, action: "sign" | "amend" | "error"): DocumentStatus {
  if (action === "sign") {
    if (current !== "draft") throw new DomainError("Only a draft document can be signed");
    return "signed";
  }
  if (action === "amend") {
    if (current !== "signed" && current !== "amended") throw new DomainError("Only a signed document can be amended");
    return "amended";
  }
  if (current !== "signed" && current !== "amended") throw new DomainError("Only a signed document can be marked entered-in-error");
  return "entered-in-error";
}

export type TemplateStatus = "draft" | "published" | "retired";

const templateTransitions: Record<TemplateStatus, TemplateStatus[]> = {
  draft: ["published", "retired"],
  published: ["retired"],
  retired: [],
};

export function canTransitionTemplate(from: TemplateStatus, to: TemplateStatus): boolean {
  return templateTransitions[from]?.includes(to) ?? false;
}

export interface AssignmentPeriod {
  startsOn: string;
  endsOn: string | null;
}

export function assignmentActiveOn(assignment: AssignmentPeriod, date: string): boolean {
  return assignment.startsOn <= date && (assignment.endsOn === null || assignment.endsOn >= date);
}

export function periodsOverlap(a: AssignmentPeriod, b: AssignmentPeriod): boolean {
  const aEnd = a.endsOn ?? "9999-12-31";
  const bEnd = b.endsOn ?? "9999-12-31";
  return a.startsOn <= bEnd && b.startsOn <= aEnd;
}

export type BedStatus =
  | "available"
  | "occupied"
  | "vacated"
  | "awaiting-cleaning"
  | "cleaning-in-progress"
  | "cleaning"
  | "ready"
  | "out-of-service"
  | "unavailable";

const bedTransitions: Record<BedStatus, BedStatus[]> = {
  available: ["occupied", "out-of-service", "unavailable", "awaiting-cleaning"],
  occupied: ["vacated"],
  vacated: ["awaiting-cleaning", "ready"],
  "awaiting-cleaning": ["cleaning-in-progress", "out-of-service"],
  "cleaning-in-progress": ["ready", "out-of-service"],
  cleaning: ["ready", "available", "out-of-service"],
  ready: ["available", "occupied", "out-of-service"],
  "out-of-service": ["ready", "available"],
  unavailable: ["ready", "available", "out-of-service"],
};

export function canTransitionBed(from: BedStatus, to: BedStatus): boolean {
  if (from === to) return true;
  return bedTransitions[from]?.includes(to) ?? false;
}

export interface LabourObservationInput {
  occurredAt: string;
  templateType: "labour-care-guide" | "partograph";
  maternal: Record<string, number | string | null>;
  fetal: Record<string, number | string | null>;
  notes?: string | null;
}

export function validateLabourObservation(input: LabourObservationInput): void {
  if (!["labour-care-guide", "partograph"].includes(input.templateType)) {
    throw new DomainError("Unsupported labour-chart template");
  }
  if (Number.isNaN(Date.parse(input.occurredAt))) throw new DomainError("A valid clinical occurrence time is required");
  for (const [key, value] of Object.entries(input.maternal)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new DomainError(`Invalid maternal value for ${key}`);
  }
  for (const [key, value] of Object.entries(input.fetal)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new DomainError(`Invalid fetal value for ${key}`);
  }
}

const CROCKFORD_STAFF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function randomStaffReference(random = crypto.getRandomValues(new Uint8Array(5))): string {
  if (random.length !== 5) throw new Error("random source must provide 5 bytes");
  let body = "";
  let bits = 0;
  let value = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && body.length < 8) {
      bits -= 5;
      body += CROCKFORD_STAFF[(value >>> bits) & 31];
    }
  }
  body = body.padEnd(8, "0");
  return `STF-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

export function randomMortuaryReference(sequence: number, year = new Date().getFullYear()): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new DomainError("A positive mortuary sequence is required");
  return `MOR-${year}-${String(sequence).padStart(5, "0")}`;
}

export interface TemplateFieldDefinition {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "decimal" | "boolean" | "date" | "datetime" | "select" | "coded" | "quantity" | "repeating-group";
  required?: boolean;
  unit?: string;
  options?: string[];
  section?: string;
  sensitivity?: string;
}

export function validateTemplateFields(fields: unknown): TemplateFieldDefinition[] {
  if (!Array.isArray(fields) || fields.length === 0) throw new DomainError("A template requires at least one field");
  const allowed = new Set(["text", "textarea", "number", "decimal", "boolean", "date", "datetime", "select", "coded", "quantity", "repeating-group"]);
  const keys = new Set<string>();
  return fields.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new DomainError(`Field ${index + 1} is invalid`);
    const field = raw as Record<string, unknown>;
    const key = String(field.key ?? "");
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(key)) throw new DomainError(`Field ${index + 1} has an invalid key`);
    if (keys.has(key)) throw new DomainError(`Duplicate template field key: ${key}`);
    keys.add(key);
    if (!String(field.label ?? "").trim()) throw new DomainError(`Field ${key} requires a label`);
    if (!allowed.has(String(field.type))) throw new DomainError(`Field ${key} has an unsupported type`);
    if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) {
      throw new DomainError(`Select field ${key} requires options`);
    }
    return {
      key,
      label: String(field.label),
      type: field.type as TemplateFieldDefinition["type"],
      required: field.required === true,
      unit: field.unit ? String(field.unit) : undefined,
      options: Array.isArray(field.options) ? field.options.map(String) : undefined,
      section: field.section ? String(field.section) : undefined,
      sensitivity: field.sensitivity ? String(field.sensitivity) : undefined,
    };
  });
}

export function validateDocumentContent(
  fields: TemplateFieldDefinition[],
  content: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const field of fields) {
    const value = content[field.key];
    const missing = value === undefined || value === null || value === "";
    if (field.required && missing) {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (missing) continue;
    switch (field.type) {
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${field.label} must be a number`);
        break;
      case "decimal":
        if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${field.label} must be a decimal value`);
        break;
      case "boolean":
        if (typeof value !== "boolean") errors.push(`${field.label} must be true or false`);
        break;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${field.label} must be a date`);
        break;
      case "datetime":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) errors.push(`${field.label} must be a date and time`);
        break;
      case "quantity":
        if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${field.label} must be a quantity`);
        else if (field.unit && typeof content[`${field.key}Unit`] !== "string") errors.push(`${field.label} requires a unit`);
        break;
      case "select":
        if (typeof value !== "string" || !(field.options ?? []).includes(value)) errors.push(`${field.label} has an unsupported option`);
        break;
      default:
        if (typeof value !== "string") errors.push(`${field.label} must be text`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** BMI risk assessment function for patient intake */
export function assessBmiRisk(sex: string, weightKg: number, heightM: number): { bmi: number; riskLevel: "low" | "moderate" | "high" } | null {
  const bmi = weightKg / (heightM * heightM);
  let riskLevel: "low" | "moderate" | "high";
  if (sex === "female") {
    riskLevel = bmi < 18.5 || bmi > 30 ? "high" : bmi < 25 ? "low" : "moderate";
  } else if (sex === "male") {
    riskLevel = bmi < 18.5 || bmi > 28 ? "high" : bmi < 25 ? "low" : "moderate";
  } else {
    riskLevel = bmi < 18.5 || bmi > 30 ? "high" : bmi < 26 ? "low" : "moderate";
  }
  return { bmi: Number(bmi.toFixed(1)), riskLevel };
}

/** Dynamic partograph automation for maternity care */
export function computePartographState(maternal: Record<string, number | string | null>, fetal: Record<string, number | string | null>, _templateType: "labour-care-guide" | "partograph"): {
  dilation: number;
  station: number;
  fetalHeartRate: number;
  contractionsPer10Min: number;
  progressStatus: "on-track" | "delayed" | "arrested";
  alerts: string[];
  progressRate: number | null;
} {
  const dilation = Number(maternal["dilation"] ?? 0);
  const station = Number(maternal["station"] ?? 0);
  const fetalHeartRate = Number(fetal["fetalHeartRate"] ?? 0);
  const contractions = Number(maternal["contractionsPer10Min"] ?? 0);
  const alerts: string[] = [];
  let progressRate: number | null = null;
  if (maternal["previousDilation"] !== undefined) {
    const prevDilation = Number(maternal["previousDilation"]);
    const timeDiff = 1;
    progressRate = ((dilation - prevDilation) / timeDiff) * 60;
  }
  if (dilation >= 10) {
    alerts.push("Progress arrested: cervix fully dilated");
  }
  if (contractions < 2) {
    alerts.push("Reduced uterine activity");
  }
  if (fetalHeartRate < 110 || fetalHeartRate > 160) {
    alerts.push("Fetal heart rate abnormality");
  }
  if (station > -3) {
    alerts.push("Cephalic descent below -3 station");
  }
  let progressStatus: "on-track" | "delayed" | "arrested" = "on-track";
  if (progressRate !== null && progressRate < 1) {
    progressStatus = "delayed";
  }
  if (dilation >= 10 && !alerts.includes("Progress arrested: cervix fully dilated")) {
    progressStatus = "arrested";
  }
  return {
    dilation,
    station,
    fetalHeartRate,
    contractionsPer10Min: contractions,
    progressStatus,
    alerts,
    progressRate,
  };
}

/**
 * AI-assisted clinical note suggestion generation.
 *
 * Kept for backwards compatibility, but callers should prefer
 * `buildAiNoteSuggestion` when they want a deployment-gated, non-blocking
 * suggestion path. This legacy form is intentionally not wired into routes.
 */
export async function generateAiNoteSuggestion(_input: {
  patientId: string;
  encounterId: string;
  encounterState: string;
  existingContent: string;
}): Promise<{
  title?: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  reasoning?: string;
}> {
  return { reasoning: "AI note generation is not wired in this build; existing content is used as-is" };
}

/**
 * Optional, deployment-gated note suggestions for outpatient notes.
 *
 * This is decision support only. Suggestions never replace the authored note;
 * the clinical route only falls back to a suggestion value when the clinician
 * left that field blank. The feature is enabled only when the AI integration is
 * available and configured with a real token.
 */
export async function buildAiNoteSuggestion(
  input: {
    patientId: string;
    encounterId: string;
    encounterState: string;
    existingContent: string;
  },
  deps: {
    aiAvailable: boolean;
    aiToken: string | null;
    aiBaseUrl: string | null;
  },
): Promise<{
  title?: string;
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  reasoning?: string;
}> {
  if (!deps.aiAvailable || !deps.aiToken || !deps.aiBaseUrl) {
    return { reasoning: "AI note suggestions are not configured; clinical defaults are used" };
  }
  try {
    const aiResponse = await fetch(deps.aiBaseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${deps.aiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        patientId: input.patientId,
        encounterId: input.encounterId,
        encounterState: input.encounterState,
        existingContent: input.existingContent,
      }),
    });
    if (!aiResponse.ok) {
      return { reasoning: "AI service unavailable; clinical defaults are used" };
    }
    const suggestions = (await aiResponse.json()) as {
      title?: string;
      subjective?: string;
      objective?: string;
      assessment?: string;
      plan?: string;
      reasoning?: string;
    };
    return {
      title: suggestions.title,
      subjective: suggestions.subjective,
      objective: suggestions.objective,
      assessment: suggestions.assessment,
      plan: suggestions.plan,
      reasoning: suggestions.reasoning ?? "AI-generated suggestions",
    };
  } catch (error) {
    return { reasoning: `AI suggestor threw: ${(error as Error).message}` };
  }
}

/** Clinical decision support predictive algorithms on composite payloads */
export async function predictClinicalRisk(input: {
  patientId: string;
  encounterId: string;
  presentationData: Record<string, unknown>;
  vitals: Record<string, number | string | null>;
  ultrasoundReport: string | null;
}): Promise<{
  riskLevel: "low" | "moderate" | "high";
  riskFactors: string[];
  recommendations: string[];
  confidence: number;
}> {
  const presentation = input.presentationData;
  const vitals = input.vitals;
  const ultrasound = input.ultrasoundReport || "";
  const riskFactors: string[] = [];
  let riskScore = 0;
  const maxScore = 100;
  if (presentation.size && typeof presentation.size === "number") {
    riskScore += Math.min(20, presentation.size / 10);
    if (presentation.size > 50) riskFactors.push("Large presentation size");
  }
  if (presentation.location && typeof presentation.location === "string") {
    if (presentation.location.includes("critical") || presentation.location.includes("deep")) {
      riskScore += 15;
      riskFactors.push("Deep/invasive location");
    }
  }
  const { temperature, heartRate, bloodPressure, oxygenSaturation } = vitals;
  if (temperature && typeof temperature === "number") {
    if (temperature > 38 || temperature < 35) {
      riskScore += 10;
      riskFactors.push("Fever or hypothermia");
    }
  }
  if (heartRate && typeof heartRate === "number") {
    if (heartRate > 120 || heartRate < 50) {
      riskScore += 15;
      riskFactors.push("Tachycardia or bradycardia");
    }
  }
  if (bloodPressure && typeof bloodPressure === "number") {
    if (bloodPressure > 140 || bloodPressure < 90) {
      riskScore += 10;
      riskFactors.push("Hypotension or hypertension");
    }
  }
  if (oxygenSaturation && typeof oxygenSaturation === "number") {
    if (oxygenSaturation < 95) {
      riskScore += 20;
      riskFactors.push("Hypoxemia");
    }
  }
  if (ultrasound) {
    const lowerUS = ultrasound.toLowerCase();
    if (lowerUS.includes("complex") || lowerUS.includes("mass")) {
      riskScore += 15;
      riskFactors.push("Complex ultrasound findings");
    }
    if (lowerUS.includes("normal") || lowerUS.includes("unremarkable")) {
      riskScore -= 5;
    }
  }
  riskScore = Math.min(Math.max(riskScore, 0), maxScore);
  let riskLevel: "low" | "moderate" | "high";
  const confidence = Math.round((riskScore / maxScore) * 100);
  if (riskScore >= 70) {
    riskLevel = "high";
  } else if (riskScore >= 40) {
    riskLevel = "moderate";
  } else {
    riskLevel = "low";
  }
  const recommendations: string[] = [];
  if (riskFactors.includes("Fever or hypothermia")) recommendations.push("Obtain cultures and start empiric antibiotics");
  if (riskFactors.includes("Tachycardia or bradycardia")) recommendations.push("Continuous cardiac monitoring");
  if (riskFactors.includes("Hypoxemia")) recommendations.push("Administer supplemental oxygen");
  if (riskFactors.includes("Complex ultrasound findings")) recommendations.push("Consult radiology for targeted follow-up");
  if (recommendations.length === 0) recommendations.push("Continue routine monitoring");
  return {
    riskLevel,
    riskFactors,
    recommendations,
    confidence,
  };
}

export type ClinicalRiskOutput = Awaited<ReturnType<typeof predictClinicalRisk>>;
