import type {
  ConceptMapDefinition,
  TerminologyAdapter,
  TerminologyConcept,
  ValueSetDefinition,
  ValidateCodeResult,
} from "./types.js";

export const SYNTHETIC_LABEL = "Synthetic development terminology — not for production clinical coding";
export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const LOINC_SYSTEM = "http://loinc.org";
export const UCUM_SYSTEM = "http://unitsofmeasure.org";
export const SNOMED_SYNTHETIC_VERSION = "http://snomed.info/sct/version/20240131-medveris-synthetic";
export const LOINC_SYNTHETIC_VERSION = "2.80-medveris-synthetic";
export const UCUM_SYNTHETIC_VERSION = "2.2-medveris-synthetic";

const concepts: TerminologyConcept[] = [
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "38341003", "Hypertension", ["High blood pressure"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "195967001", "Asthma", ["Bronchial asthma"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "44054006", "Diabetes mellitus type 2", ["Type 2 diabetes"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "386661006", "Fever", ["Pyrexia"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "267036007", "Dyspnea", ["Shortness of breath"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "25064002", "Headache", ["Cephalalgia"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "21522001", "Abdominal pain", ["Stomach ache"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "22298006", "Myocardial infarction", ["Heart attack"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "84114007", "Heart failure", ["Cardiac failure"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "13645005", "Chronic obstructive pulmonary disease", ["COPD"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "271737000", "Anemia", ["Anaemia"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "36989005", "Cough", ["Coughing"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "404640003", "Dizziness", ["Light headedness"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "29857009", "Chest pain", ["Chest discomfort"]),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "35489007", "Depressive disorder", ["Depression"], true),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "105590001", "Substance", ["Substance"], false),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "387517004", "Paracetamol", ["Acetaminophen"], false),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "372687004", "Amoxicillin", ["Amoxicillin"], false),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "39579001", "Anaphylaxis", ["Anaphylactic reaction"], false),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "126485001", "Urticaria", ["Hives"], false),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "103693007", "Diagnostic procedure", ["Diagnostic procedure"], false),
  c(SNOMED_SYSTEM, SNOMED_SYNTHETIC_VERSION, "386053000", "Evaluation procedure", ["Assessment procedure"], false),
  c("https://medveris.example/synthetic-terminology", "1.0.0", "inactive-example", "Synthetic inactive demonstration concept", [], false),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "8867-4", "Heart rate", ["Pulse rate"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "9279-1", "Respiratory rate", ["Breathing rate"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "8310-5", "Body temperature", ["Temperature"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "8480-6", "Systolic blood pressure", ["Systolic BP"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "8462-4", "Diastolic blood pressure", ["Diastolic BP"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "2708-6", "Oxygen saturation in arterial blood", ["SaO2"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "59408-5", "Oxygen saturation by pulse oximetry", ["SpO2"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "8302-2", "Body height", ["Height"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "29463-7", "Body weight", ["Weight"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "2339-0", "Glucose [Mass/volume] in Blood", ["Blood glucose"]),
  c(LOINC_SYSTEM, LOINC_SYNTHETIC_VERSION, "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", ["HbA1c"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "/min", "per minute", ["/min"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "Cel", "degree Celsius", ["Cel"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "mm[Hg]", "millimeter of mercury", ["mm[Hg]"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "%", "percent", ["%"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "cm", "centimeter", ["cm"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "kg", "kilogram", ["kg"]),
  c(UCUM_SYSTEM, UCUM_SYNTHETIC_VERSION, "mg/dL", "milligram per deciliter", ["mg/dL"]),
];

function c(
  system: string,
  version: string,
  code: string,
  display: string,
  synonyms: string[] = [],
  active = true,
  sensitive = false,
): TerminologyConcept {
  void sensitive;
  return { system, version, code, display, synonyms, active };
}

const base = "https://medveris.example/fhir/ValueSet";
const mapsBase = "https://medveris.example/fhir/ConceptMap";

const valueSets: ValueSetDefinition[] = [
  vs(`${base}/clinical-findings-synthetic`, "1.0.0", "Synthetic clinical findings", SNOMED_SYSTEM, [
    "386661006", "267036007", "25064002", "21522001", "36989005", "404640003", "29857009", "35489007",
  ]),
  vs(`${base}/diagnosis-synthetic`, "1.0.0", "Synthetic diagnoses", SNOMED_SYSTEM, [
    "38341003", "195967001", "44054006", "22298006", "84114007", "13645005", "271737000", "35489007",
  ]),
  vs(`${base}/procedures-synthetic`, "1.0.0", "Synthetic procedures", SNOMED_SYSTEM, [
    "103693007", "386053000",
  ]),
  vs(`${base}/allergy-substance-synthetic`, "1.0.0", "Synthetic allergy substances", SNOMED_SYSTEM, [
    "105590001", "387517004", "372687004",
  ]),
  vs(`${base}/allergy-reaction-synthetic`, "1.0.0", "Synthetic allergy reactions", SNOMED_SYSTEM, [
    "39579001", "126485001",
  ]),
  vs(`${base}/observation-type-synthetic`, "1.0.0", "Synthetic observation types", LOINC_SYSTEM, [
    "8867-4", "9279-1", "8310-5", "8480-6", "8462-4", "2708-6", "59408-5", "8302-2", "29463-7", "2339-0", "4548-4",
  ]),
  vs(`${base}/ucum-units-synthetic`, "1.0.0", "Synthetic UCUM units", UCUM_SYSTEM, [
    "/min", "Cel", "mm[Hg]", "%", "cm", "kg", "mg/dL",
  ]),
];

function vs(canonical: string, version: string, title: string, system: string, codes: string[]): ValueSetDefinition {
  return { canonical, version, title, system, codes };
}

const conceptMaps: ConceptMapDefinition[] = [
  {
    canonical: `${mapsBase}/local-lab-glucose-to-loinc`,
    version: "1.0.0",
    name: "Reviewed local blood glucose to LOINC",
    fromSystem: "https://medveris.example/local-lab",
    toSystem: LOINC_SYSTEM,
    reviewed: true,
    entries: [
      { fromCode: "GLU", toCode: "2339-0", toDisplay: "Glucose [Mass/volume] in Blood", equivalence: "equivalent" },
      { fromCode: "HBA1C", toCode: "4548-4", toDisplay: "Hemoglobin A1c/Hemoglobin.total in Blood", equivalence: "equivalent" },
    ],
  },
];

export const FIELD_VALUE_SETS: Record<string, string> = {
  "clinical-finding": `${base}/clinical-findings-synthetic`,
  diagnosis: `${base}/diagnosis-synthetic`,
  procedure: `${base}/procedures-synthetic`,
  "allergy-substance": `${base}/allergy-substance-synthetic`,
  "allergy-reaction": `${base}/allergy-reaction-synthetic`,
  observation: `${base}/observation-type-synthetic`,
  unit: `${base}/ucum-units-synthetic`,
};

export class SyntheticTerminologyAdapter implements TerminologyAdapter {
  readonly mode = "synthetic" as const;
  readonly label = SYNTHETIC_LABEL;

  async lookup(system: string, code: string): Promise<TerminologyConcept | null> {
    return concepts.find((concept) => concept.system === system && concept.code === code) ?? null;
  }

  async validateCode(input: {
    system: string;
    code: string;
    version?: string;
    valueSet?: string;
    valueSetVersion?: string;
  }): Promise<ValidateCodeResult> {
    const concept = await this.lookup(input.system, input.code);
    if (!concept) {
      return { result: false, message: "Unknown code in the synthetic terminology set", system: input.system, version: input.version ?? "", code: input.code, valueSet: input.valueSet };
    }
    if (input.version && input.version !== concept.version) {
      return { result: false, message: "Code is not available in the requested release", system: input.system, version: input.version, code: input.code, display: concept.display, active: concept.active, valueSet: input.valueSet };
    }
    const valueSet = input.valueSet ? valueSets.find((entry) => entry.canonical === input.valueSet) : undefined;
    if (input.valueSet && !valueSet) {
      return { result: false, message: "Value set is not approved by this adapter", system: input.system, version: concept.version, code: input.code, display: concept.display, active: concept.active, valueSet: input.valueSet };
    }
    if (valueSet && (valueSet.system !== input.system || !valueSet.codes.includes(input.code))) {
      return { result: false, message: "Code is not a member of the requested value set", system: input.system, version: concept.version, code: input.code, display: concept.display, active: concept.active, valueSet: valueSet.canonical, valueSetVersion: valueSet.version };
    }
    if (!concept.active) {
      return { result: false, message: "Code is inactive and cannot be used for new entry", system: input.system, version: concept.version, code: input.code, display: concept.display, active: false, valueSet: valueSet?.canonical, valueSetVersion: valueSet?.version };
    }
    return { result: true, system: input.system, version: concept.version, code: input.code, display: concept.display, active: true, valueSet: valueSet?.canonical, valueSetVersion: valueSet?.version };
  }

  async expand(input: { valueSet: string; valueSetVersion?: string; filter?: string; count: number; offset: number; activeOnly: boolean }) {
    const valueSet = valueSets.find((entry) => entry.canonical === input.valueSet);
    if (!valueSet) throw new Error("value_set_not_found");
    if (input.valueSetVersion && input.valueSetVersion !== valueSet.version) throw new Error("value_set_version_not_found");
    const filter = input.filter?.toLowerCase();
    const all = concepts
      .filter((concept) => concept.system === valueSet.system && valueSet.codes.includes(concept.code))
      .filter((concept) => !input.activeOnly || concept.active)
      .filter((concept) => !filter || concept.display.toLowerCase().includes(filter) || concept.code.includes(filter) || concept.synonyms.some((s) => s.toLowerCase().includes(filter)));
    return { valueSet, concepts: all.slice(input.offset, input.offset + input.count), total: all.length };
  }

  async translate(input: { conceptMap: string; conceptMapVersion?: string; system: string; code: string }) {
    const map = conceptMaps.find((entry) => entry.canonical === input.conceptMap);
    if (!map || !map.reviewed) return { result: false, message: "ConceptMap is not approved for use" };
    if (input.conceptMapVersion && input.conceptMapVersion !== map.version) return { result: false, map, message: "ConceptMap version is not available" };
    if (map.fromSystem !== input.system) return { result: false, map, message: "Source system is not supported by this map" };
    const match = map.entries.find((entry) => entry.fromCode === input.code);
    if (!match) return { result: false, map, message: "No reviewed translation exists for this code" };
    return { result: true, map, match: { toCode: match.toCode, toDisplay: match.toDisplay, equivalence: match.equivalence } };
  }

  async search(field: string, query: string, limit: number) {
    const canonical = FIELD_VALUE_SETS[field];
    if (!canonical) return [];
    const expanded = await this.expand({ valueSet: canonical, filter: query, count: limit, offset: 0, activeOnly: true });
    return expanded.concepts;
  }
}
