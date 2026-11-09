import type {
  ConceptMapDefinition,
  TerminologyAdapter,
  TerminologyConcept,
  TerminologyStatus,
  TranslateInput,
  ValueSetDefinition,
  ValidateCodeResult,
} from "./types.js";

export const LOCAL_REF_LABEL =
  "Medveris local clinical reference catalogue — curated internal terminology, not a licensed SNOMED CT or LOINC distribution";

export const LOCAL_REF_SYSTEM = "https://medveris.example/local-reference-catalogue";
export const LOCAL_REF_VERSION = "1.0.0";

// Reuse the same international system URIs that the existing synthetic catalogue exposes so existing
// callers keep working, but the release/version strings here identify the Medveris local catalogue,
// not an official publication.
export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const LOINC_SYSTEM = "http://loinc.org";
export const UCUM_SYSTEM = "http://unitsofmeasure.org";
export const LOCAL_LAB_SYSTEM = "https://medveris.example/local-lab";

export const SNOMED_LOCAL_VERSION = `${LOCAL_REF_VERSION}-snomed-local`;
export const LOINC_LOCAL_VERSION = `${LOCAL_REF_VERSION}-loinc-local`;
export const UCUM_LOCAL_VERSION = `${LOCAL_REF_VERSION}-ucum-local`;

const concepts: TerminologyConcept[] = [
  // ---- Diagnoses / clinical findings (SNOMED CT local reference codes) ----
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "38341003", "Hypertension", ["High blood pressure"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "195967001", "Asthma", ["Bronchial asthma"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "44054006", "Diabetes mellitus type 2", ["Type 2 diabetes"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "22298006", "Myocardial infarction", ["Heart attack"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "84114007", "Heart failure", ["Cardiac failure"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "13645005", "Chronic obstructive pulmonary disease", ["COPD"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "271737000", "Anemia", ["Anaemia"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "35489007", "Depressive disorder", ["Depression"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "386661006", "Fever", ["Pyrexia"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "267036007", "Dyspnea", ["Shortness of breath"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "25064002", "Headache", ["Cephalalgia"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "21522001", "Abdominal pain", ["Stomach ache"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "29857009", "Chest pain", ["Chest discomfort"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "36989005", "Cough", ["Coughing"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "404640003", "Dizziness", ["Light headedness"]),

  // ---- Symptoms and clinical signs ----
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "386053000", "Evaluation procedure", ["Assessment procedure"]),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "103693007", "Diagnostic procedure", ["Diagnostic procedure"]),

  // ---- Medications and pharmaceutical products (local reference substances) ----
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "387517004", "Paracetamol", ["Acetaminophen"], true),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "372687004", "Amoxicillin", ["Amoxicillin"], true),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "105590001", "Substance", ["Substance"], false),

  // ---- Allergies and reactions ----
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "39579001", "Anaphylaxis", ["Anaphylactic reaction"], false),
  c(SNOMED_SYSTEM, SNOMED_LOCAL_VERSION, "126485001", "Urticaria", ["Hives"], false),

  // ---- Laboratory investigations (LOINC local reference codes) ----
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "8867-4", "Heart rate", ["Pulse rate"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "9279-1", "Respiratory rate", ["Breathing rate"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "8310-5", "Body temperature", ["Temperature"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "8480-6", "Systolic blood pressure", ["Systolic BP"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "8462-4", "Diastolic blood pressure", ["Diastolic BP"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "2708-6", "Oxygen saturation in arterial blood", ["SaO2"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "59408-5", "Oxygen saturation by pulse oximetry", ["SpO2"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "8302-2", "Body height", ["Height"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "29463-7", "Body weight", ["Weight"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "2339-0", "Glucose [Mass/volume] in Blood", ["Blood glucose"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "2345-7", "Glucose [Mass/volume] in Serum or Plasma", ["Serum glucose"]),
  c(LOINC_SYSTEM, LOINC_LOCAL_VERSION, "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", ["HbA1c"]),

  // ---- Imaging procedures (local reference) ----
  c(
    "https://medveris.example/local-imaging",
    LOCAL_REF_VERSION,
    "XR-CHEST-001",
    "Chest X-ray",
    ["Plain chest radiograph", "CXR"],
  ),
  c(
    "https://medveris.example/local-imaging",
    LOCAL_REF_VERSION,
    "XR-ABDOMEN-001",
    "Abdominal X-ray",
    ["Plain abdominal radiograph", "AXR"],
  ),
  c(
    "https://medveris.example/local-imaging",
    LOCAL_REF_VERSION,
    "US-ABDOMEN-001",
    "Abdominal ultrasound",
    ["Abdominal US", "Ultrasound of abdomen"],
  ),
  c(
    "https://medveris.example/local-imaging",
    LOCAL_REF_VERSION,
    "CT-HEAD-001",
    "CT head",
    ["Computed tomography of head"],
  ),

  // ---- Maternity and obstetric terminology (local reference) ----
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-TRIMESTER-1",
    "First trimester of pregnancy",
    ["Trimester 1", "T1"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-TRIMESTER-2",
    "Second trimester of pregnancy",
    ["Trimester 2", "T2"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-TRIMESTER-3",
    "Third trimester of pregnancy",
    ["Trimester 3", "T3"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-LABOUR-SPONTANEOUS",
    "Spontaneous labour",
    ["Labour, spontaneous onset"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-LABOUR-INDUCED",
    "Induced labour",
    ["Labour, induced"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-DELIVERY-VAGINAL",
    "Vaginal delivery",
    ["Normal vaginal delivery"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-DELIVERY-CS",
    "Cesarean section",
    ["C-section", "Caesarean section"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-TERM-NEONATE",
    "Term neonate",
    ["Full-term newborn", "Term infant"],
  ),
  c(
    "https://medveris.example/local-obstetrics",
    LOCAL_REF_VERSION,
    "OB-PRETERM-NEONATE",
    "Preterm neonate",
    ["Preterm newborn", "Preterm infant"],
  ),

  // ---- Pediatric terminology (local reference) ----
  c(
    "https://medveris.example/local-pediatrics",
    LOCAL_REF_VERSION,
    "PED-AGEGROUP-NEONATE",
    "Neonate",
    ["Newborn", "Neonatal period"],
  ),
  c(
    "https://medveris.example/local-pediatrics",
    LOCAL_REF_VERSION,
    "PED-AGEGROUP-INFANT",
    "Infant",
    ["Infancy"],
  ),
  c(
    "https://medveris.example/local-pediatrics",
    LOCAL_REF_VERSION,
    "PED-AGEGROUP-TODDLER",
    "Toddler",
    ["Toddlerhood"],
  ),
  c(
    "https://medveris.example/local-pediatrics",
    LOCAL_REF_VERSION,
    "PED-AGEGROUP-SCHOOLAGE",
    "School-age child",
    ["School age"],
  ),

  // ---- Nursing terminology (local reference) ----
  c(
    "https://medveris.example/local-nursing",
    LOCAL_REF_VERSION,
    "NURS-ASSESSMENT-CONF",
    "Nursing assessment — comfort",
    ["Comfort assessment"],
  ),
  c(
    "https://medveris.example/local-nursing",
    LOCAL_REF_VERSION,
    "NURS-ASSESSMENT-SKIN",
    "Nursing assessment — skin integrity",
    ["Skin assessment"],
  ),
  c(
    "https://medveris.example/local-nursing",
    LOCAL_REF_VERSION,
    "NURS-TASK-POSITIONING",
    "Nursing task — patient positioning",
    ["Repositioning"],
  ),
  c(
    "https://medveris.example/local-nursing",
    LOCAL_REF_VERSION,
    "NURS-TASK-MOBILITY",
    "Nursing task — mobility assistance",
    ["Mobility assistance"],
  ),

  // ---- Clinical specialties (local reference) ----
  c(
    "https://medveris.example/local-specialty",
    LOCAL_REF_VERSION,
    "SPEC-GENERAL-MEDICINE",
    "General medicine",
    ["Internal medicine"],
  ),
  c(
    "https://medveris.example/local-specialty",
    LOCAL_REF_VERSION,
    "SPEC-MATERNITY",
    "Maternity and obstetric care",
    ["Obstetrics", "Maternity"],
  ),
  c(
    "https://medveris.example/local-specialty",
    LOCAL_REF_VERSION,
    "SPEC-PEDIATRICS",
    "Pediatrics",
    ["Child health"],
  ),
  c(
    "https://medveris.example/local-specialty",
    LOCAL_REF_VERSION,
    "SPEC-SURGERY",
    "Surgery",
    ["Surgical"],
  ),
  c(
    "https://medveris.example/local-specialty",
    LOCAL_REF_VERSION,
    "SPEC-EMERGENCY",
    "Emergency care",
    ["Emergency medicine"],
  ),
  c(
    "https://medveris.example/local-specialty",
    LOCAL_REF_VERSION,
    "SPEC-ANESTHESIOLOGY",
    "Anesthesiology",
    ["Anaesthesiology"],
  ),

  // ---- Inactive demonstration concept ----
  c(LOCAL_REF_SYSTEM, LOCAL_REF_VERSION, "inactive-example", "Local reference inactive demonstration concept", [], false),
];

function c(
  system: string,
  version: string,
  code: string,
  display: string,
  synonyms: string[] = [],
  active = true,
): TerminologyConcept {
  return { system, version, code, display, synonyms, active };
}

const base = `https://medveris.example/fhir/ValueSet`;
const mapsBase = `https://medveris.example/fhir/ConceptMap`;

const valueSets: ValueSetDefinition[] = [
  vs(`${base}/diagnosis-local`, SNOMED_LOCAL_VERSION, "Local reference diagnoses", SNOMED_SYSTEM, [
    "38341003", "195967001", "44054006", "22298006", "84114007", "13645005", "271737000", "35489007",
  ]),
  vs(`${base}/clinical-findings-local`, SNOMED_LOCAL_VERSION, "Local reference clinical findings", SNOMED_SYSTEM, [
    "386661006", "267036007", "25064002", "21522001", "36989005", "404640003", "29857009",
  ]),
  vs(`${base}/procedures-local`, SNOMED_LOCAL_VERSION, "Local reference procedures", SNOMED_SYSTEM, [
    "103693007", "386053000",
  ]),
  vs(`${base}/allergy-substance-local`, SNOMED_LOCAL_VERSION, "Local reference allergy substances", SNOMED_SYSTEM, [
    "105590001", "387517004", "372687004",
  ]),
  vs(`${base}/allergy-reaction-local`, SNOMED_LOCAL_VERSION, "Local reference allergy reactions", SNOMED_SYSTEM, [
    "39579001", "126485001",
  ]),
  vs(`${base}/observation-type-local`, LOINC_LOCAL_VERSION, "Local reference observation types", LOINC_SYSTEM, [
    "8867-4", "9279-1", "8310-5", "8480-6", "8462-4", "2708-6", "59408-5", "8302-2", "29463-7", "2339-0", "2345-7", "4548-4",
  ]),
  vs(`${base}/ucum-units-local`, UCUM_LOCAL_VERSION, "Local reference UCUM units", UCUM_SYSTEM, [
    "/min", "Cel", "mm[Hg]", "%", "cm", "kg", "mg/dL",
  ]),
  vs(`${base}/imaging-local`, `${LOCAL_REF_VERSION}`, "Local reference imaging procedures", "https://medveris.example/local-imaging", [
    "XR-CHEST-001", "XR-ABDOMEN-001", "US-ABDOMEN-001", "CT-HEAD-001",
  ]),
  vs(`${base}/obstetrics-local`, `${LOCAL_REF_VERSION}`, "Local reference obstetric terminology", "https://medveris.example/local-obstetrics", [
    "OB-TRIMESTER-1", "OB-TRIMESTER-2", "OB-TRIMESTER-3", "OB-LABOUR-SPONTANEOUS", "OB-LABOUR-INDUCED", "OB-DELIVERY-VAGINAL", "OB-DELIVERY-CS", "OB-TERM-NEONATE", "OB-PRETERM-NEONATE",
  ]),
  vs(`${base}/pediatrics-local`, `${LOCAL_REF_VERSION}`, "Local reference pediatric age groups", "https://medveris.example/local-pediatrics", [
    "PED-AGEGROUP-NEONATE", "PED-AGEGROUP-INFANT", "PED-AGEGROUP-TODDLER", "PED-AGEGROUP-SCHOOLAGE",
  ]),
  vs(`${base}/nursing-local`, `${LOCAL_REF_VERSION}`, "Local reference nursing assessments and tasks", "https://medveris.example/local-nursing", [
    "NURS-ASSESSMENT-CONF", "NURS-ASSESSMENT-SKIN", "NURS-TASK-POSITIONING", "NURS-TASK-MOBILITY",
  ]),
  vs(`${base}/specialty-local`, `${LOCAL_REF_VERSION}`, "Local reference clinical specialties", "https://medveris.example/local-specialty", [
    "SPEC-GENERAL-MEDICINE", "SPEC-MATERNITY", "SPEC-PEDIATRICS", "SPEC-SURGERY", "SPEC-EMERGENCY", "SPEC-ANESTHESIOLOGY",
  ]),
];

function vs(canonical: string, version: string, title: string, system: string, codes: string[]): ValueSetDefinition {
  return { canonical, version, title, system, codes };
}

const conceptMaps: ConceptMapDefinition[] = [
  {
    canonical: `${mapsBase}/local-lab-glucose-to-loinc`,
    version: LOCAL_REF_VERSION,
    name: "Reviewed local blood glucose to LOINC",
    fromSystem: LOCAL_LAB_SYSTEM,
    toSystem: LOINC_SYSTEM,
    reviewed: true,
    entries: [
      {
        fromCode: "GLU",
        toCode: "2339-0",
        toDisplay: "Glucose [Mass/volume] in Blood",
        equivalence: "equivalent",
        specimen: "Blood",
        method: "Enzymatic",
        unit: "mg/dL",
      },
      {
        fromCode: "HBA1C",
        toCode: "4548-4",
        toDisplay: "Hemoglobin A1c/Hemoglobin.total in Blood",
        equivalence: "equivalent",
        specimen: "Blood",
        method: "HPLC",
        unit: "%",
      },
    ],
  },
  {
    canonical: `${mapsBase}/local-lab-serum-glucose-to-loinc`,
    version: LOCAL_REF_VERSION,
    name: "Reviewed local serum glucose to LOINC",
    fromSystem: LOCAL_LAB_SYSTEM,
    toSystem: LOINC_SYSTEM,
    reviewed: true,
    entries: [
      {
        fromCode: "GLU_SERUM",
        toCode: "2345-7",
        toDisplay: "Glucose [Mass/volume] in Serum or Plasma",
        equivalence: "equivalent",
        specimen: "Serum",
        method: "Hexokinase",
        unit: "mg/dL",
      },
    ],
  },
  {
    canonical: `${mapsBase}/local-lab-unreviewed-to-loinc`,
    version: LOCAL_REF_VERSION,
    name: "Unreviewed draft local laboratory mapping",
    fromSystem: LOCAL_LAB_SYSTEM,
    toSystem: LOINC_SYSTEM,
    reviewed: false,
    entries: [
      { fromCode: "GLU", toCode: "2339-0", toDisplay: "Glucose [Mass/volume] in Blood", equivalence: "equivalent" },
    ],
  },
];

function contextMismatch(entry: ConceptMapDefinition["entries"][number], input: TranslateInput): string | null {
  if (entry.specimen != null && entry.specimen !== input.specimen)
    return `specimen '${input.specimen ?? ""}' does not match the reviewed mapping (${entry.specimen})`;
  if (entry.method != null && entry.method !== input.method)
    return `method '${input.method ?? ""}' does not match the reviewed mapping (${entry.method})`;
  if (entry.unit != null && entry.unit !== input.unit)
    return `unit '${input.unit ?? ""}' does not match the reviewed mapping (${entry.unit})`;
  return null;
}

export const FIELD_VALUE_SETS: Record<string, string> = {
  "clinical-finding": `${base}/clinical-findings-local`,
  diagnosis: `${base}/diagnosis-local`,
  procedure: `${base}/procedures-local`,
  "allergy-substance": `${base}/allergy-substance-local`,
  "allergy-reaction": `${base}/allergy-reaction-local`,
  observation: `${base}/observation-type-local`,
  unit: `${base}/ucum-units-local`,
  imaging: `${base}/imaging-local`,
  obstetrics: `${base}/obstetrics-local`,
  pediatrics: `${base}/pediatrics-local`,
  nursing: `${base}/nursing-local`,
  specialty: `${base}/specialty-local`,
};

export function lookupConcept(system: string, code: string): TerminologyConcept | null {
  return concepts.find((concept) => concept.system === system && concept.code === code) ?? null;
}

export function valueSetByCanonical(canonical: string): ValueSetDefinition | null {
  return valueSets.find((entry) => entry.canonical === canonical) ?? null;
}

export function conceptMapByCanonical(canonical: string): ConceptMapDefinition | null {
  return conceptMaps.find((entry) => entry.canonical === canonical) ?? null;
}

export class LocalReferenceTerminologyAdapter implements TerminologyAdapter {
  readonly mode = "local-reference" as const;
  readonly label = LOCAL_REF_LABEL;

  async lookup(system: string, code: string, _version?: string): Promise<TerminologyConcept | null> {
    return lookupConcept(system, code);
  }

  async validateCode(input: {
    system: string;
    code: string;
    version?: string;
    valueSet?: string;
    valueSetVersion?: string;
  }): Promise<ValidateCodeResult> {
    const concept = lookupConcept(input.system, input.code);
    if (!concept) {
      return {
        result: false,
        message: "Code is not present in the local reference catalogue",
        system: input.system,
        version: input.version ?? "",
        code: input.code,
        valueSet: input.valueSet,
      };
    }
    if (input.version && input.version !== concept.version) {
      return {
        result: false,
        message: "Code is not available in the requested catalogue version",
        system: input.system,
        version: input.version,
        code: input.code,
        display: concept.display,
        active: concept.active,
        valueSet: input.valueSet,
      };
    }
    const valueSet = input.valueSet ? valueSets.find((entry) => entry.canonical === input.valueSet) : undefined;
    if (input.valueSet && !valueSet) {
      return {
        result: false,
        message: "Value set is not part of the local reference catalogue",
        system: input.system,
        version: concept.version,
        code: input.code,
        display: concept.display,
        active: concept.active,
        valueSet: input.valueSet,
      };
    }
    if (valueSet && (valueSet.system !== input.system || !valueSet.codes.includes(input.code))) {
      return {
        result: false,
        message: "Code is not a member of the requested value set",
        system: input.system,
        version: concept.version,
        code: input.code,
        display: concept.display,
        active: concept.active,
        valueSet: valueSet.canonical,
        valueSetVersion: valueSet.version,
      };
    }
    if (!concept.active) {
      return {
        result: false,
        message: "Code is inactive in the local reference catalogue and cannot be used for new entries",
        system: input.system,
        version: concept.version,
        code: input.code,
        display: concept.display,
        active: false,
        valueSet: valueSet?.canonical,
        valueSetVersion: valueSet?.version,
      };
    }
    return {
      result: true,
      system: input.system,
      version: concept.version,
      code: input.code,
      display: concept.display,
      active: true,
      valueSet: valueSet?.canonical,
      valueSetVersion: valueSet?.version,
    };
  }

  async expand(input: {
    valueSet: string;
    valueSetVersion?: string;
    filter?: string;
    count: number;
    offset: number;
    activeOnly: boolean;
  }) {
    const valueSet = valueSets.find((entry) => entry.canonical === input.valueSet);
    if (!valueSet) throw new Error("value_set_not_found");
    if (input.valueSetVersion && input.valueSetVersion !== valueSet.version)
      throw new Error("value_set_version_not_found");
    const filter = input.filter?.toLowerCase();
    const all = concepts
      .filter((concept) => concept.system === valueSet.system && valueSet.codes.includes(concept.code))
      .filter((concept) => !input.activeOnly || concept.active)
      .filter(
        (concept) =>
          !filter ||
          concept.display.toLowerCase().includes(filter) ||
          concept.code.includes(filter) ||
          concept.synonyms.some((s) => s.toLowerCase().includes(filter)),
      );
    return { valueSet, concepts: all.slice(input.offset, input.offset + input.count), total: all.length };
  }

  async translate(input: TranslateInput) {
    const map = conceptMaps.find((entry) => entry.canonical === input.conceptMap);
    if (!map) return { result: false, message: "ConceptMap is not registered in the local reference catalogue" };
    if (!map.reviewed)
      return { result: false, map, message: "ConceptMap is not approved for use; an unapproved draft mapping cannot be applied" };
    if (input.conceptMapVersion && input.conceptMapVersion !== map.version)
      return { result: false, map, message: "ConceptMap version is not available" };
    if (map.fromSystem !== input.system) return { result: false, map, message: "Source system is not supported by this map" };
    const match = map.entries.find((entry) => entry.fromCode === input.code);
    if (!match) return { result: false, map, message: "No reviewed translation exists for this code" };
    const mismatch = contextMismatch(match, input);
    if (mismatch)
      return { result: false, map, message: `The submitted laboratory context does not match the reviewed mapping: ${mismatch}` };
    return {
      result: true,
      map,
      match: {
        toCode: match.toCode,
        toDisplay: match.toDisplay,
        equivalence: match.equivalence,
        ...(match.specimen != null ? { specimen: match.specimen } : {}),
        ...(match.method != null ? { method: match.method } : {}),
        ...(match.unit != null ? { unit: match.unit } : {}),
      },
    };
  }

  async search(field: string, query: string, limit: number): Promise<TerminologyConcept[]> {
    const canonical = FIELD_VALUE_SETS[field];
    if (!canonical) return [];
    const expanded = await this.expand({ valueSet: canonical, filter: query, count: limit, offset: 0, activeOnly: true });
    return expanded.concepts;
  }

  readonly status: TerminologyStatus = {
    mode: "local-reference",
    label: LOCAL_REF_LABEL,
    connected: true,
    providerHost: null,
    providerVersion: null,
    lastVerifiedAt: new Date().toISOString(),
    releases: [
      { system: SNOMED_SYSTEM, version: SNOMED_LOCAL_VERSION, source: "local-reference-catalogue" },
      { system: LOINC_SYSTEM, version: LOINC_LOCAL_VERSION, source: "local-reference-catalogue" },
      { system: UCUM_SYSTEM, version: UCUM_LOCAL_VERSION, source: "local-reference-catalogue" },
      { system: LOCAL_LAB_SYSTEM, version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
      { system: "https://medveris.example/local-imaging", version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
      { system: "https://medveris.example/local-obstetrics", version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
      { system: "https://medveris.example/local-pediatrics", version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
      { system: "https://medveris.example/local-nursing", version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
      { system: "https://medveris.example/local-specialty", version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
      { system: LOCAL_REF_SYSTEM, version: LOCAL_REF_VERSION, source: "local-reference-catalogue" },
    ],
  };

  /** This adapter is self-contained: there is no external provider to probe. Connectivity is intrinsic. */
  async verifyConnection(): Promise<void> {
    // Already reflected in status.kept
  }
}
