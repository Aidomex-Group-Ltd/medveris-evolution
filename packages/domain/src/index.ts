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

export class DomainError extends Error {
  readonly status = 422;
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
