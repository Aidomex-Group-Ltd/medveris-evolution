/**
 * Which application experience a workspace receives, and what it may lawfully dispense.
 *
 * The decision is made from the facility's recorded service category and its verified
 * registration (licence) records — never from its name, and never from a frontend preference.
 * A Drugshop is only a Drugshop when the workspace category says `drug-shop`; it is only
 * allowed to trade when an NDA drug-shop licence is recorded, verified and unexpired.
 *
 * This module deliberately invents no regulatory classification. An item whose dispensing
 * scope has not been recorded is treated as `unverified`, and a Drugshop may not dispense it.
 */

export const FACILITY_EXPERIENCES = ["drugshop", "pharmacy", "facility"] as const;
export type FacilityExperience = (typeof FACILITY_EXPERIENCES)[number];

/** Registration kinds each experience must hold. Mirrors REGISTRATION_KINDS in facility-classification. */
export const EXPERIENCE_LICENCE_KINDS: Readonly<Record<FacilityExperience, readonly string[]>> = Object.freeze({
  drugshop: ["nda-drug-shop"],
  pharmacy: ["nda-pharmacy", "psu-registration"],
  facility: [],
});

export const LICENCE_KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "nda-drug-shop": "NDA drug shop licence",
  "nda-pharmacy": "NDA pharmacy licence",
  "psu-registration": "Pharmaceutical Society of Uganda registration",
});

export interface FacilityRegistrationLike {
  kind: string;
  identifier: string;
  status: string;
  validUntil?: string | null;
}

export type LicenceState = "verified" | "not-recorded" | "unverified" | "expired" | "withdrawn";

export interface LicenceSummary {
  kind: string;
  label: string;
  identifier: string;
  state: LicenceState;
  validUntil: string | null;
}

export interface FacilityExperienceInput {
  serviceCategory?: string | null;
  registrations?: readonly FacilityRegistrationLike[];
  /** ISO date (YYYY-MM-DD). Defaults to today, UTC. */
  today?: string;
}

export interface FacilityExperienceResolution {
  experience: FacilityExperience;
  serviceCategory: string | null;
  access: {
    status: "ready" | "restricted";
    /** Why access is restricted. Empty when ready. */
    reasons: string[];
    /** Non-blocking matters the facility should resolve, e.g. a pharmacy with no recorded licence. */
    warnings: string[];
  };
  licence: LicenceSummary | null;
  requiredLicenceKinds: string[];
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Maps the canonical workspace category to the interface it receives. */
export function experienceForCategory(serviceCategory: string | null | undefined): FacilityExperience {
  switch ((serviceCategory ?? "").trim().toLowerCase()) {
    case "drug-shop":
      return "drugshop";
    case "pharmacy":
      return "pharmacy";
    default:
      return "facility";
  }
}

export function licenceKindLabel(kind: string): string {
  return LICENCE_KIND_LABELS[kind] ?? kind;
}

function licenceStateOf(registration: FacilityRegistrationLike, today: string): LicenceState {
  const status = String(registration.status ?? "").toLowerCase();
  const validUntil = registration.validUntil ?? null;
  if (status === "withdrawn") return "withdrawn";
  if (validUntil && validUntil < today) return "expired";
  if (status === "verified") return "verified";
  if (status === "expired") return "expired";
  return "unverified";
}

/** The strongest licence on record for the kinds that matter, and its state. */
function selectLicence(
  registrations: readonly FacilityRegistrationLike[],
  kinds: readonly string[],
  today: string,
): LicenceSummary | null {
  const candidates = registrations.filter((registration) => kinds.includes(registration.kind));
  if (!candidates.length) return null;
  const ranked: LicenceState[] = ["verified", "unverified", "expired", "withdrawn"];
  const summaries = candidates
    .map((registration) => ({
      kind: registration.kind,
      label: licenceKindLabel(registration.kind),
      identifier: registration.identifier,
      state: licenceStateOf(registration, today),
      validUntil: registration.validUntil ?? null,
      rank: ranked.indexOf(licenceStateOf(registration, today)),
    }))
    .sort((left, right) => left.rank - right.rank || (left.validUntil ?? "9999-12-31").localeCompare(right.validUntil ?? "9999-12-31"));
  const best = summaries[0]!;
  return { kind: best.kind, label: best.label, identifier: best.identifier, state: best.state, validUntil: best.validUntil };
}

/**
 * Resolves the experience and whether the workspace may enter it.
 *
 * A Drugshop with no verified, unexpired licence is restricted: it can see why and what to
 * submit, but it cannot reach the operating dashboard. A Pharmacy keeps its existing
 * experience; a missing licence is reported as a warning rather than a lockout, because
 * breaking the current pharmacy workflow would not make it more compliant.
 */
export function resolveFacilityExperience(input: FacilityExperienceInput): FacilityExperienceResolution {
  const today = input.today ?? isoToday();
  const category = input.serviceCategory?.trim() || null;
  const experience = experienceForCategory(category);
  const required = [...EXPERIENCE_LICENCE_KINDS[experience]];

  if (!category) {
    return {
      experience,
      serviceCategory: null,
      access: {
        status: "restricted",
        reasons: ["This workspace has no recorded facility type. An administrator must record it and the facility's licence before the workspace can be used."],
        warnings: [],
      },
      licence: null,
      requiredLicenceKinds: required,
    };
  }

  const licence = selectLicence(input.registrations ?? [], required, today);
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (experience === "drugshop") {
    if (!licence) {
      reasons.push("No NDA drug shop licence is recorded for this facility. Add the licence details for verification before dispensing.");
    } else if (licence.state === "unverified") {
      reasons.push(`The NDA drug shop licence ${licence.identifier} has been recorded but not verified. Dispensing stays blocked until verification is complete.`);
    } else if (licence.state === "expired") {
      reasons.push(`The NDA drug shop licence ${licence.identifier} expired${licence.validUntil ? ` on ${licence.validUntil}` : ""}. Renew it before dispensing.`);
    } else if (licence.state === "withdrawn") {
      reasons.push(`The NDA drug shop licence ${licence.identifier} has been withdrawn. Dispensing is not permitted.`);
    }
  }

  if (experience === "pharmacy" && (!licence || licence.state !== "verified")) {
    warnings.push(
      licence
        ? `The pharmacy licence ${licence.identifier} is recorded as ${licence.state}. Verify it before relying on it for controlled or prescription-only stock.`
        : "No NDA pharmacy licence is recorded for this facility. Record it so the licence register is complete.",
    );
  }

  return {
    experience,
    serviceCategory: category,
    access: { status: reasons.length ? "restricted" : "ready", reasons, warnings },
    licence,
    requiredLicenceKinds: required,
  };
}

// ---------------------------------------------------------------- dispensing eligibility

export const DISPENSING_SCOPES = [
  "otc",
  "prescription-only",
  "pharmacy-only",
  "not-dispensable",
  "unverified",
] as const;
export type DispensingScope = (typeof DISPENSING_SCOPES)[number];

export const DISPENSING_SCOPE_LABELS: Readonly<Record<DispensingScope, string>> = Object.freeze({
  otc: "Over the counter — a Drugshop may sell it",
  "prescription-only": "Prescription only — a Drugshop may not dispense it",
  "pharmacy-only": "Pharmacy only — a Drugshop may not dispense it",
  "not-dispensable": "Not for retail dispensing",
  unverified: "Not yet classified — no dispensing permitted",
});

export function normalizeDispensingScope(value: string | null | undefined): DispensingScope {
  const scope = String(value ?? "").trim().toLowerCase();
  return (DISPENSING_SCOPES as readonly string[]).includes(scope) ? (scope as DispensingScope) : "unverified";
}

export type DispensingDenialCode =
  | "licence-unverified"
  | "prescription-only"
  | "pharmacy-only"
  | "not-dispensable"
  | "classification-unverified";

export interface DispensingDecision {
  allowed: boolean;
  code?: DispensingDenialCode;
  reason?: string;
}

export interface DispensingEligibilityInput {
  experience: FacilityExperience;
  licenceState?: LicenceState | null;
  dispensingScope: DispensingScope | string | null | undefined;
  prescriptionOnly?: boolean;
  itemName?: string;
}

/**
 * A Drugshop may dispense an item only when its licence is verified and the item is
 * explicitly classified as over the counter. Every other case — including an item nobody has
 * classified yet — is refused, and the caller records the refusal.
 *
 * Pharmacy and general facilities keep the existing prescription rules; this function never
 * widens or narrows them.
 */
export function dispensingDecision(input: DispensingEligibilityInput): DispensingDecision {
  if (input.experience !== "drugshop") return { allowed: true };

  const name = input.itemName?.trim() || "This item";
  if (input.licenceState !== "verified") {
    return {
      allowed: false,
      code: "licence-unverified",
      reason: `${name} cannot be dispensed: this Drugshop's NDA licence is not verified.`,
    };
  }
  if (input.prescriptionOnly) {
    return {
      allowed: false,
      code: "prescription-only",
      reason: `${name} is prescription-only and may not be dispensed by a Drugshop.`,
    };
  }

  const scope = normalizeDispensingScope(input.dispensingScope);
  switch (scope) {
    case "otc":
      return { allowed: true };
    case "prescription-only":
      return { allowed: false, code: "prescription-only", reason: `${name} is classified as prescription-only and may not be dispensed by a Drugshop.` };
    case "pharmacy-only":
      return { allowed: false, code: "pharmacy-only", reason: `${name} is restricted to pharmacies and may not be dispensed by a Drugshop.` };
    case "not-dispensable":
      return { allowed: false, code: "not-dispensable", reason: `${name} is not for retail dispensing.` };
    case "unverified":
      return {
        allowed: false,
        code: "classification-unverified",
        reason: `${name} has no verified dispensing classification, so a Drugshop may not dispense it.`,
      };
  }
}

/**
 * Routes a Drugshop must never open, even by typing the address: the pharmacy dispensing queue
 * and prescription review workflow. Point-of-sale, inventory and the facility's own price list
 * stay available, because those are the Drugshop's operating tools.
 */
export const PHARMACY_ONLY_ROUTES = ["/pharmacy", "/work-queues/pharmacy"] as const;

export function isPharmacyOnlyRoute(pathname: string): boolean {
  return PHARMACY_ONLY_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
