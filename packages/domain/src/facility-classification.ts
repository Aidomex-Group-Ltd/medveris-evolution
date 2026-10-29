/**
 * Facility/service category and level of care for Ugandan private providers.
 *
 * Four separate concepts are kept apart and never derived from one another silently:
 *   1. service category — what kind of provider or service this is;
 *   2. official level — a Ministry of Health / NHFR level, only when one is registered;
 *   3. Medveris equivalent — an internal operational comparison used for product setup;
 *   4. level status — official, Medveris equivalent, not applicable, or not yet assigned.
 *
 * Sources (checked 2026-10-29): MoH SQIS+ non-state facility types (sqis.health.go.ug/index.php/site/about)
 * and the MoH referral tiers HC I to National Referral Hospital (health.go.ug/faq). Category labels are an
 * editable product list, not a legal register; a level never proves that a service is offered at a site.
 */

import { DomainError } from "./errors.js";

export const CARE_LEVELS = [
  { code: "hc1", tier: 1, label: "HC I — community / VHT service" },
  { code: "hc2", tier: 2, label: "HC II" },
  { code: "hc3", tier: 3, label: "HC III" },
  { code: "hc4", tier: 4, label: "HC IV" },
  { code: "general-hospital", tier: 5, label: "General / District Hospital (Level 5)" },
  { code: "regional-referral", tier: 6, label: "Regional Referral Hospital (Level 6)" },
  { code: "national-referral", tier: 7, label: "National Referral Hospital (Level 7)" },
] as const;

export type CareLevel = (typeof CARE_LEVELS)[number]["code"];
export const CARE_LEVEL_CODES = CARE_LEVELS.map((level) => level.code) as unknown as readonly [CareLevel, ...CareLevel[]];

export const LEVEL_STATUSES = ["official", "medveris-equivalent", "not-applicable", "not-yet-assigned"] as const;
export type LevelStatus = (typeof LEVEL_STATUSES)[number];

export const OFFICIAL_LEVEL_SOURCES = ["nhfr", "moh-registration", "moh-licence", "other-official"] as const;
export type OfficialLevelSource = (typeof OFFICIAL_LEVEL_SOURCES)[number];

export const OWNERSHIP_TYPES = ["private-for-profit", "private-not-for-profit", "public", "other"] as const;
export type Ownership = (typeof OWNERSHIP_TYPES)[number];

export const WORKSPACE_KINDS = ["facility", "department", "service-unit"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/**
 * How the level field behaves for a category.
 * - `hospital-registered`: Level 5, 6 or 7 is chosen from the registered designation; never inferred.
 * - `equivalent-suggested`: an official level when registered; otherwise a Medveris equivalent may be used.
 * - `official-only`: only an official level, or not yet assigned.
 * - `no-standalone-level`: "No standalone care level assigned" unless an official level is confirmed.
 */
export type LevelPolicy = "hospital-registered" | "equivalent-suggested" | "official-only" | "no-standalone-level";

export interface ServiceCategory {
  code: string;
  label: string;
  levelPolicy: LevelPolicy;
  /** Suggested Medveris equivalent shown for confirmation; never applied without the user choosing it. */
  suggestedEquivalent?: CareLevel;
  allowedOfficialLevels: readonly CareLevel[];
  allowedEquivalentLevels: readonly CareLevel[];
  subtypes?: ReadonlyArray<{ code: string; label: string; suggestedEquivalent?: CareLevel }>;
  /** Regulator/licence identifiers usually collected for this category; kept separate from care level. */
  registrationKinds: readonly RegistrationKind[];
  /** Medveris modules worth enabling first. A recommendation only; configuration stays editable. */
  recommendedModules: readonly ModuleCode[];
  /** Medveris report ids that fit the category. */
  recommendedReports: readonly string[];
}

export const REGISTRATION_KINDS = [
  { code: "nhfr-id", label: "National Health Facility Registry (NHFR) ID" },
  { code: "moh-facility-licence", label: "MoH / district facility registration or licence" },
  { code: "umdpc-premises", label: "UMDPC premises / clinic licence" },
  { code: "unmc-premises", label: "UNMC premises licence (nursing / midwifery / domiciliary)" },
  { code: "ahpc-premises", label: "AHPC premises licence (allied health, laboratory, imaging)" },
  { code: "nda-drug-shop", label: "NDA drug shop licence" },
  { code: "nda-pharmacy", label: "NDA pharmacy licence" },
  { code: "psu-registration", label: "Pharmaceutical Society of Uganda registration" },
  { code: "aeaa-radiation", label: "Atomic Energy Council radiation facility licence" },
  { code: "other", label: "Other regulator identifier" },
] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number]["code"];

export const MODULES = [
  { code: "reception", label: "Reception, registration and queues" },
  { code: "outpatient", label: "Outpatient consultations" },
  { code: "emergency", label: "Emergency care" },
  { code: "inpatient", label: "Wards and admissions" },
  { code: "maternity", label: "Maternity" },
  { code: "theatre", label: "Theatre" },
  { code: "laboratory", label: "Laboratory" },
  { code: "radiology", label: "Imaging / radiology" },
  { code: "pharmacy", label: "Pharmacy dispensing" },
  { code: "inventory", label: "Inventory, stores and procurement" },
  { code: "finance", label: "Billing and payments" },
  { code: "workforce", label: "Workforce and onboarding" },
  { code: "programmes", label: "Programmes and follow-up" },
  { code: "public-health", label: "Public health and HMIS reporting" },
] as const;
export type ModuleCode = (typeof MODULES)[number]["code"];
export const MODULE_CODES = MODULES.map((module) => module.code) as unknown as readonly [ModuleCode, ...ModuleCode[]];

const HC_LEVELS: readonly CareLevel[] = ["hc2", "hc3", "hc4"];
const HOSPITAL_LEVELS: readonly CareLevel[] = ["general-hospital", "regional-referral", "national-referral"];
const ALL_LEVELS: readonly CareLevel[] = CARE_LEVELS.map((level) => level.code);
const CORE_OPS: readonly ModuleCode[] = ["reception", "inventory", "finance", "workforce"];

export const SERVICE_CATEGORIES: readonly ServiceCategory[] = Object.freeze([
  {
    code: "hospital", label: "Hospital", levelPolicy: "hospital-registered",
    allowedOfficialLevels: HOSPITAL_LEVELS, allowedEquivalentLevels: [],
    subtypes: [{ code: "general", label: "General hospital" }, { code: "specialised", label: "Specialised hospital" }],
    registrationKinds: ["nhfr-id", "moh-facility-licence", "umdpc-premises"],
    recommendedModules: [...CORE_OPS, "outpatient", "emergency", "inpatient", "maternity", "theatre", "laboratory", "radiology", "pharmacy", "public-health"],
    recommendedReports: ["daily-activity", "consultations", "bed-occupancy", "maternity-outcomes", "lab-turnaround", "radiology-turnaround", "pharmacy-stock", "financial-reconciliation", "department-operations"],
  },
  {
    code: "clinic", label: "Clinic", levelPolicy: "equivalent-suggested", suggestedEquivalent: "hc2",
    allowedOfficialLevels: HC_LEVELS, allowedEquivalentLevels: HC_LEVELS,
    subtypes: [
      { code: "general-outpatient", label: "General outpatient clinic", suggestedEquivalent: "hc2" },
      { code: "specialty", label: "Specialty clinic" },
    ],
    registrationKinds: ["nhfr-id", "umdpc-premises", "moh-facility-licence"],
    recommendedModules: [...CORE_OPS, "outpatient", "laboratory", "pharmacy", "programmes"],
    recommendedReports: ["daily-activity", "appointments", "waiting-times", "consultations", "diagnoses", "pharmacy-stock", "financial-reconciliation"],
  },
  {
    code: "medical-centre", label: "Medical centre", levelPolicy: "equivalent-suggested",
    allowedOfficialLevels: HC_LEVELS, allowedEquivalentLevels: HC_LEVELS,
    registrationKinds: ["nhfr-id", "umdpc-premises", "moh-facility-licence"],
    recommendedModules: [...CORE_OPS, "outpatient", "emergency", "maternity", "laboratory", "pharmacy"],
    recommendedReports: ["daily-activity", "consultations", "diagnoses", "lab-turnaround", "pharmacy-stock", "financial-reconciliation"],
  },
  {
    code: "health-centre", label: "Health centre", levelPolicy: "official-only",
    allowedOfficialLevels: ["hc1", ...HC_LEVELS], allowedEquivalentLevels: [],
    registrationKinds: ["nhfr-id", "moh-facility-licence"],
    recommendedModules: [...CORE_OPS, "outpatient", "maternity", "laboratory", "pharmacy", "programmes", "public-health"],
    recommendedReports: ["daily-activity", "consultations", "diagnoses", "maternity-outcomes", "pharmacy-stock"],
  },
  {
    code: "domiciliary", label: "Domiciliary facility", levelPolicy: "equivalent-suggested",
    allowedOfficialLevels: HC_LEVELS, allowedEquivalentLevels: HC_LEVELS,
    registrationKinds: ["nhfr-id", "unmc-premises"],
    recommendedModules: [...CORE_OPS, "outpatient", "maternity", "pharmacy"],
    recommendedReports: ["daily-activity", "maternity-outcomes", "pharmacy-stock", "financial-reconciliation"],
  },
  {
    code: "drug-shop", label: "Drug shop", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["nda-drug-shop"],
    recommendedModules: ["inventory", "finance", "pharmacy", "workforce"],
    recommendedReports: ["pharmacy-stock", "financial-reconciliation", "department-operations"],
  },
  {
    code: "pharmacy", label: "Pharmacy", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["nda-pharmacy", "psu-registration"],
    recommendedModules: ["reception", "inventory", "finance", "pharmacy", "workforce"],
    recommendedReports: ["pharmacy-stock", "financial-reconciliation", "department-operations"],
  },
  {
    code: "dental", label: "Dental clinic or dentistry unit", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["umdpc-premises", "nhfr-id"],
    recommendedModules: [...CORE_OPS, "outpatient"],
    recommendedReports: ["daily-activity", "appointments", "consultations", "financial-reconciliation"],
  },
  {
    code: "laboratory", label: "Laboratory", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["ahpc-premises", "nhfr-id"],
    recommendedModules: [...CORE_OPS, "laboratory"],
    recommendedReports: ["lab-turnaround", "financial-reconciliation", "department-operations"],
  },
  {
    code: "imaging", label: "Imaging / radiology centre", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["ahpc-premises", "aeaa-radiation", "nhfr-id"],
    recommendedModules: [...CORE_OPS, "radiology"],
    recommendedReports: ["radiology-turnaround", "financial-reconciliation", "department-operations"],
  },
  {
    code: "ophthalmology", label: "Ophthalmology / eye-care centre", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["umdpc-premises", "nhfr-id"],
    recommendedModules: [...CORE_OPS, "outpatient", "pharmacy"],
    recommendedReports: ["daily-activity", "appointments", "consultations", "financial-reconciliation"],
  },
  {
    code: "specialty-service", label: "Other standalone specialist service", levelPolicy: "no-standalone-level",
    allowedOfficialLevels: ALL_LEVELS, allowedEquivalentLevels: [],
    registrationKinds: ["nhfr-id", "other"],
    recommendedModules: [...CORE_OPS, "outpatient"],
    recommendedReports: ["daily-activity", "consultations", "financial-reconciliation"],
  },
]);

export const SERVICE_CATEGORY_CODES = SERVICE_CATEGORIES.map((category) => category.code);

export const NO_STANDALONE_LEVEL_LABEL = "No standalone care level assigned";
export const EQUIVALENT_NOTICE = "Medveris equivalent — confirm service scope. This is not an official Ministry of Health or NHFR level.";

export function serviceCategory(code: string): ServiceCategory {
  const found = SERVICE_CATEGORIES.find((category) => category.code === code);
  if (!found) throw new DomainError(`Unknown service category ${code}`);
  return found;
}

export function careLevelLabel(code: string | null | undefined): string | null {
  return CARE_LEVELS.find((level) => level.code === code)?.label ?? null;
}

export interface LevelInput {
  serviceCategory: string;
  serviceSubtype?: string | null;
  levelStatus: LevelStatus;
  officialLevel?: CareLevel | null;
  officialLevelSource?: OfficialLevelSource | null;
  officialLevelReference?: string | null;
  equivalentLevel?: CareLevel | null;
  /** Why the chosen equivalent fits the registered scope; required when it differs from the suggestion. */
  equivalentJustification?: string | null;
}

export interface ResolvedLevel {
  levelStatus: LevelStatus;
  officialLevel: CareLevel | null;
  officialLevelSource: OfficialLevelSource | null;
  officialLevelReference: string | null;
  equivalentLevel: CareLevel | null;
  equivalentJustification: string | null;
}

/** The status a new workspace of this category starts with, before the user confirms anything. */
export function defaultLevelStatus(categoryCode: string): LevelStatus {
  return serviceCategory(categoryCode).levelPolicy === "no-standalone-level" ? "not-applicable" : "not-yet-assigned";
}

export function suggestedEquivalent(categoryCode: string, subtype?: string | null): CareLevel | null {
  const category = serviceCategory(categoryCode);
  if (category.levelPolicy !== "equivalent-suggested") return null;
  const sub = category.subtypes?.find((candidate) => candidate.code === subtype);
  if (category.subtypes?.length && subtype && sub) return sub.suggestedEquivalent ?? null;
  return category.suggestedEquivalent ?? null;
}

/**
 * Validates a level choice against the category rules. Throws for a choice the rules forbid; returns a
 * normalised value that keeps the official level and the Medveris equivalent in separate fields.
 */
export function resolveLevel(input: LevelInput): ResolvedLevel {
  const category = serviceCategory(input.serviceCategory);
  if (input.serviceSubtype && category.subtypes && !category.subtypes.some((sub) => sub.code === input.serviceSubtype)) {
    throw new DomainError(`Unknown ${category.label.toLowerCase()} subtype ${input.serviceSubtype}`);
  }
  const empty: ResolvedLevel = {
    levelStatus: input.levelStatus, officialLevel: null, officialLevelSource: null, officialLevelReference: null,
    equivalentLevel: null, equivalentJustification: null,
  };
  switch (input.levelStatus) {
    case "official": {
      if (!input.officialLevel) throw new DomainError("Choose the official level registered for this facility");
      if (!category.allowedOfficialLevels.includes(input.officialLevel)) {
        throw new DomainError(`${careLevelLabel(input.officialLevel)} is not a registered level for a ${category.label.toLowerCase()}`);
      }
      if (!input.officialLevelSource) throw new DomainError("Record where the official level comes from (NHFR, MoH registration or licence)");
      const reference = input.officialLevelReference?.trim() ?? "";
      if (reference.length < 2) throw new DomainError("Record the registry ID or registration reference for the official level");
      return { ...empty, officialLevel: input.officialLevel, officialLevelSource: input.officialLevelSource, officialLevelReference: reference };
    }
    case "medveris-equivalent": {
      if (category.levelPolicy === "hospital-registered") {
        throw new DomainError("Hospital levels are never inferred; select the registered designation, or choose 'not yet assigned'");
      }
      if (category.levelPolicy !== "equivalent-suggested") {
        throw new DomainError(`A ${category.label.toLowerCase()} has no Medveris equivalent level; it is shown as "${NO_STANDALONE_LEVEL_LABEL}" or uses its official level`);
      }
      if (!input.equivalentLevel || !category.allowedEquivalentLevels.includes(input.equivalentLevel)) {
        throw new DomainError(`Choose a Medveris equivalent from ${category.allowedEquivalentLevels.map(careLevelLabel).join(", ")}`);
      }
      const suggestion = suggestedEquivalent(category.code, input.serviceSubtype);
      const justification = input.equivalentJustification?.trim() || null;
      if (input.equivalentLevel !== suggestion && (justification?.length ?? 0) < 10) {
        throw new DomainError("Explain which registered services support this equivalent (maternity, inpatient, diagnostics, emergency or surgery)");
      }
      return { ...empty, equivalentLevel: input.equivalentLevel, equivalentJustification: justification };
    }
    case "not-applicable":
      if (category.levelPolicy !== "no-standalone-level") {
        throw new DomainError(`A ${category.label.toLowerCase()} normally has a level; use 'not yet assigned' until it is confirmed`);
      }
      return empty;
    case "not-yet-assigned":
      return empty;
  }
}

export interface LevelDisplay {
  status: LevelStatus;
  /** Primary text shown wherever the level appears. */
  label: string;
  /** Where the value comes from, e.g. "NHFR ID 12345" or "Medveris operational mapping". */
  source: string;
  official: boolean;
}

const SOURCE_LABELS: Record<OfficialLevelSource, string> = {
  nhfr: "National Health Facility Registry",
  "moh-registration": "MoH registration",
  "moh-licence": "MoH / district licence",
  "other-official": "Other official designation",
};

export function describeLevel(value: Partial<ResolvedLevel> & { levelStatus: LevelStatus }): LevelDisplay {
  switch (value.levelStatus) {
    case "official":
      return {
        status: "official", official: true,
        label: `${careLevelLabel(value.officialLevel) ?? "Official level"} (official)`,
        source: `${value.officialLevelSource ? SOURCE_LABELS[value.officialLevelSource] : "Official source"}${value.officialLevelReference ? ` · ${value.officialLevelReference}` : ""}`,
      };
    case "medveris-equivalent":
      return {
        status: "medveris-equivalent", official: false,
        label: `${careLevelLabel(value.equivalentLevel) ?? "—"}-equivalent (Medveris equivalent — confirm service scope)`,
        source: "Medveris operational mapping; not a Ministry of Health or NHFR designation",
      };
    case "not-applicable":
      return { status: "not-applicable", official: false, label: NO_STANDALONE_LEVEL_LABEL, source: "Standalone service category" };
    case "not-yet-assigned":
      return { status: "not-yet-assigned", official: false, label: "Not yet assigned", source: "Registration or level confirmation pending" };
  }
}

/**
 * Level used for roll-ups of a department or unit inside a registered host facility. The unit keeps its own
 * service category; it is never treated as a separate facility level.
 */
export function rollUpLevel(host: Partial<ResolvedLevel> & { levelStatus: LevelStatus }): LevelDisplay & { inherited: true } {
  const display = describeLevel(host);
  return { ...display, source: `Inherited from the host facility for roll-ups · ${display.source}`, inherited: true };
}

export interface ModuleRecommendation {
  modules: ModuleCode[];
  reports: string[];
  hmisCandidates: string[];
  notes: string[];
}

/** Starting recommendations from category and level. Never a statement that a service exists at the site. */
export function recommendModules(categoryCode: string, level: Partial<ResolvedLevel> & { levelStatus: LevelStatus }): ModuleRecommendation {
  const category = serviceCategory(categoryCode);
  const modules = new Set<ModuleCode>(category.recommendedModules);
  const reports = new Set(category.recommendedReports);
  const notes = ["Recommendations only. Enable the modules for services the site actually provides; a level does not prove a service is available."];
  const effective = level.levelStatus === "official" ? level.officialLevel : level.levelStatus === "medveris-equivalent" ? level.equivalentLevel : null;
  const tier = CARE_LEVELS.find((candidate) => candidate.code === effective)?.tier ?? 0;
  if (tier >= 3) {
    modules.add("maternity");
    modules.add("laboratory");
    reports.add("maternity-outcomes");
  }
  if (tier >= 4) {
    for (const module of ["inpatient", "emergency", "theatre"] as const) modules.add(module);
    reports.add("bed-occupancy");
  }
  const hmisCandidates = category.levelPolicy === "no-standalone-level" && level.levelStatus !== "official"
    ? []
    : ["HMIS 105 OPD Monthly Report", ...(tier >= 4 || category.code === "hospital" ? ["HMIS 108 IPD Monthly Report"] : [])];
  if (hmisCandidates.length) {
    notes.push("National HMIS reports apply only to facilities confirmed eligible and authorised by the Ministry of Health; confirm forms with the district biostatistician.");
  }
  return { modules: [...modules], reports: [...reports], hmisCandidates, notes };
}

/** Maps the legacy free-text tenants.facility_type to a category for existing workspaces. */
export function categoryFromLegacyType(facilityType: string | null | undefined): string {
  const value = (facilityType ?? "").toLowerCase();
  if (value.includes("hospital")) return "hospital";
  if (value.includes("pharm")) return "pharmacy";
  if (value.includes("drug")) return "drug-shop";
  if (value.includes("lab")) return "laboratory";
  if (value.includes("dental")) return "dental";
  if (value.includes("imaging") || value.includes("radiol")) return "imaging";
  if (value.includes("eye") || value.includes("ophthal")) return "ophthalmology";
  if (value.includes("health centre") || value.includes("health-centre") || value === "hc") return "health-centre";
  if (value.includes("medical centre") || value.includes("medical-centre")) return "medical-centre";
  if (value.includes("domicil")) return "domiciliary";
  return "clinic";
}
