/**
 * Which application experience a workspace receives, and what it may lawfully dispense.
 *
 * The decision is made from the facility's recorded service category and its registration
 * (licence) records — never from its name, and never from a frontend preference. A Drugshop is
 * only a Drugshop when the workspace category says `drug-shop`.
 *
 * A regulatory licence is optional documentation. Its absence, or a pending or rejected
 * verification, never locks a facility out of MedVeris: the workspace, catalogue, inventory,
 * price lists and reporting stay available. Only the regulated transaction that legally needs a
 * verified licence is restricted, and that decision is made at the transaction.
 *
 * This module deliberately invents no regulatory classification. An item whose dispensing
 * scope has not been recorded is treated as `unverified`, and a Drugshop may not dispense it.
 */

export const FACILITY_EXPERIENCES = ["drugshop", "pharmacy", "facility"] as const;
export type FacilityExperience = (typeof FACILITY_EXPERIENCES)[number];

/** Registration kinds that document each experience. Mirrors REGISTRATION_KINDS in facility-classification. */
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
  issuer?: string | null;
  verifiedAt?: string | null;
  documentReference?: string | null;
}

/**
 * Regulatory documentation progress. None of these states, except `verified`, allows a regulated
 * dispensing transaction for a Drugshop — and none of them restricts ordinary platform use.
 */
export const LICENCE_STATUSES = [
  "not-provided",
  "pending-verification",
  "verified",
  "rejected",
  "expired",
  "withdrawn",
] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

export const LICENCE_STATUS_LABELS: Readonly<Record<LicenceStatus, string>> = Object.freeze({
  "not-provided": "Not provided",
  "pending-verification": "Provided — pending verification",
  verified: "Verified",
  rejected: "Verification rejected",
  expired: "Expired",
  withdrawn: "Withdrawn",
});

/**
 * Non-blocking wording for each state. These are informational: they describe the documentation,
 * never a lockout. A facility may keep working while any of them applies.
 */
export const LICENCE_STATUS_MESSAGES: Readonly<Record<LicenceStatus, string>> = Object.freeze({
  "not-provided": "Licence details have not been provided. You can continue using MedVeris and add your regulatory licence information whenever available.",
  "pending-verification": "Licence details have been submitted and are awaiting verification. Your platform access remains active.",
  verified: "Licence details are verified.",
  rejected: "The licence details provided could not be verified. You can correct and resubmit them. Your platform access remains active.",
  expired: "The recorded licence has expired. Renew it and update the record when you can. Your platform access remains active.",
  withdrawn: "The licence record was withdrawn. Your platform access remains active.",
});

export interface LicenceSummary {
  kind: string;
  label: string;
  identifier: string;
  status: LicenceStatus;
  validUntil: string | null;
  issuer: string | null;
  verifiedAt: string | null;
  documentReference: string | null;
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
    /** Why access is restricted. Empty when ready. Never a licence reason. */
    reasons: string[];
    /** Non-blocking licence documentation notices. */
    warnings: string[];
  };
  licence: LicenceSummary | null;
  /** Documentation progress; `not-provided` when no licence is on record. */
  licenceStatus: LicenceStatus;
  /** The informational notice for that status, safe to show anywhere in the workspace. */
  licenceNotice: string;
  licenceKinds: string[];
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

/** Maps a stored registration row to the documentation status it represents today. */
export function licenceStatusOf(registration: FacilityRegistrationLike, today: string): LicenceStatus {
  const status = String(registration.status ?? "").toLowerCase();
  const validUntil = registration.validUntil ?? null;
  if (status === "withdrawn") return "withdrawn";
  if (validUntil && validUntil < today) return "expired";
  if (status === "verified") return "verified";
  if (status === "expired") return "expired";
  if (status === "rejected") return "rejected";
  return "pending-verification";
}

/** The strongest licence on record for the kinds that matter, and its status. */
function selectLicence(
  registrations: readonly FacilityRegistrationLike[],
  kinds: readonly string[],
  today: string,
): LicenceSummary | null {
  const candidates = registrations.filter((registration) => kinds.includes(registration.kind));
  if (!candidates.length) return null;
  const ranked: LicenceStatus[] = ["verified", "pending-verification", "rejected", "expired", "withdrawn"];
  const summaries = candidates
    .map((registration) => {
      const status = licenceStatusOf(registration, today);
      return {
        kind: registration.kind,
        label: licenceKindLabel(registration.kind),
        identifier: registration.identifier,
        status,
        validUntil: registration.validUntil ?? null,
        issuer: registration.issuer ?? null,
        verifiedAt: registration.verifiedAt ?? null,
        documentReference: registration.documentReference ?? null,
        rank: ranked.indexOf(status),
      };
    })
    .sort((left, right) => left.rank - right.rank || (left.validUntil ?? "9999-12-31").localeCompare(right.validUntil ?? "9999-12-31"));
  const best = summaries[0]!;
  return {
    kind: best.kind,
    label: best.label,
    identifier: best.identifier,
    status: best.status,
    validUntil: best.validUntil,
    issuer: best.issuer,
    verifiedAt: best.verifiedAt,
    documentReference: best.documentReference,
  };
}

/** The notice for a status, with the recorded expiry date where it helps the reader. */
function licenceNoticeFor(status: LicenceStatus, licence: LicenceSummary | null): string {
  if (status === "expired" && licence?.validUntil) {
    return `${LICENCE_STATUS_MESSAGES.expired.replace("has expired.", `expired on ${licence.validUntil}.`)}`;
  }
  return LICENCE_STATUS_MESSAGES[status];
}

/**
 * Resolves the experience and how the workspace may be used.
 *
 * A licence is documentation, not an access key: neither a missing, pending, rejected nor
 * expired licence restricts the workspace. The only restriction this function reports is a
 * workspace whose facility type was never recorded, because the interface itself cannot be
 * chosen without it. Dispensing is decided separately, at the sale.
 */
export function resolveFacilityExperience(input: FacilityExperienceInput): FacilityExperienceResolution {
  const today = input.today ?? isoToday();
  const category = input.serviceCategory?.trim() || null;
  const experience = experienceForCategory(category);
  const kinds = [...EXPERIENCE_LICENCE_KINDS[experience]];

  if (!category) {
    return {
      experience,
      serviceCategory: null,
      access: {
        status: "restricted",
        reasons: ["This workspace has no recorded facility type. An administrator must record the facility's type before the workspace interface can be chosen."],
        warnings: [],
      },
      licence: null,
      licenceStatus: "not-provided",
      licenceNotice: LICENCE_STATUS_MESSAGES["not-provided"],
      licenceKinds: kinds,
    };
  }

  const licence = selectLicence(input.registrations ?? [], kinds, today);
  const licenceStatus = licence?.status ?? "not-provided";
  const licenceNotice = licenceNoticeFor(licenceStatus, licence);
  const warnings: string[] = [];

  // Documentation progress is reported, never enforced as a lockout. Pharmacy keeps its
  // existing experience on exactly the same terms.
  if (experience !== "facility" && licenceStatus !== "verified") warnings.push(licenceNotice);

  return {
    experience,
    serviceCategory: category,
    access: { status: "ready", reasons: [], warnings },
    licence,
    licenceStatus,
    licenceNotice,
    licenceKinds: kinds,
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
  licenceStatus?: LicenceStatus | null;
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
  // Transaction-level control only: the workspace itself stays usable, but a regulated medicine
  // sale requires a verified licence. A missing record never stands in for a verified one.
  if (input.licenceStatus !== "verified") {
    return {
      allowed: false,
      code: "licence-unverified",
      reason: `${name} cannot be dispensed: selling medicines requires a verified NDA drug shop licence, and this facility's licence is ${LICENCE_STATUS_LABELS[input.licenceStatus ?? "not-provided"].toLowerCase()}.`,
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
