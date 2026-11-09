import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import {
  FIELD_VALUE_SETS,
  LOCAL_REF_LABEL,
  LOINC_LOCAL_VERSION,
  SNOMED_LOCAL_VERSION,
  UCUM_LOCAL_VERSION,
  SNOMED_SYSTEM,
  LOINC_SYSTEM,
  UCUM_SYSTEM,
  LOCAL_LAB_SYSTEM,
  createTerminology,
  lookupConcept,
  conceptMapByCanonical,
} from "../../apps/api/src/terminology/index.js";

// FIELD_VALUE_SETS is exported as Record<string, string>; with noUncheckedIndexedAccess known-key
// access returns string | undefined. The test validates a catalogue whose keys are known, so
// access through a concrete key-of view so each known key is typed as string.
const FIELD = FIELD_VALUE_SETS as unknown as {
  diagnosis: string; "clinical-finding": string; procedure: string;
  "allergy-substance": string; "allergy-reaction": string; observation: string;
  unit: string; imaging: string; obstetrics: string; pediatrics: string;
  nursing: string; specialty: string;
};

const strong = {
  SESSION_SECRET: "a".repeat(20) + "Session-Secret-Value-1",
  AUDIT_SIGNING_KEY: "b".repeat(20) + "Audit-Signing-Value-2",
  MFA_ENCRYPTION_KEY: "c".repeat(20) + "Mfa-Encryption-Value-3",
};

describe("local-reference terminology mode", () => {
  it("is selected when TERMINOLOGY_MODE=local-reference", () => {
    const config = loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" });
    expect(config.terminologyMode).toBe("local-reference");
    expect(createTerminology(config).mode).toBe("local-reference");
  });

  it("uses the local reference catalogue label", () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    expect(adapter.label).toBe(LOCAL_REF_LABEL);
  });

  it("exposes concept lookup for a SNOMED CT local reference code", () => {
    const concept = lookupConcept(SNOMED_SYSTEM, "38341003");
    expect(concept).toMatchObject({ system: SNOMED_SYSTEM, code: "38341003", display: "Hypertension", active: true });
    expect(concept?.version).toBe(SNOMED_LOCAL_VERSION);
    expect(concept?.synonyms).toContain("High blood pressure");
  });

  it("returns null for an unknown code", () => {
    expect(lookupConcept(SNOMED_SYSTEM, "0000000000")).toBeNull();
  });

  it("validates an active code member of the expected value set", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const result = await adapter.validateCode({ system: SNOMED_SYSTEM, code: "38341003", valueSet: FIELD_VALUE_SETS.diagnosis });
    expect(result.result).toBe(true);
    expect(result.system).toBe(SNOMED_SYSTEM);
    expect(result.code).toBe("38341003");
    expect(result.active).toBe(true);
    expect(result.valueSet).toBe(FIELD.diagnosis);
    expect(result.version).toBe(SNOMED_LOCAL_VERSION);
  });

  it("rejects a code that is not a member of the requested value set", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const result = await adapter.validateCode({ system: SNOMED_SYSTEM, code: "38341003", valueSet: FIELD.observation });
    expect(result.result).toBe(false);
    expect(result.message).toContain("not a member of the requested value set");
    expect(result.system).toBe(SNOMED_SYSTEM);
    expect(result.code).toBe("38341003");
  });

  it("rejects an inactive code for new entries", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const result = await adapter.validateCode({ system: SNOMED_SYSTEM, code: "105590001", valueSet: FIELD["allergy-substance"] });
    expect(result.result).toBe(false);
    expect(result.message).toContain("inactive");
    expect(result.active).toBe(false);
  });

  it("rejects a code when the requested catalogue version differs", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const result = await adapter.validateCode({ system: LOINC_SYSTEM, code: "8867-4", version: "2.80-medveris-synthetic", valueSet: FIELD.observation });
    expect(result.result).toBe(false);
    expect(result.message).toContain("not available in the requested catalogue version");
  });

  it("rejects a value set that is not part of the catalogue", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const result = await adapter.validateCode({ system: SNOMED_SYSTEM, code: "38341003", valueSet: "https://example.invalid/value-set" });
    expect(result.result).toBe(false);
    expect(result.message).toContain("not part of the local reference catalogue");
  });

  it("expands a value set with filter, count and offset", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const expanded = await adapter.expand({ valueSet: FIELD.diagnosis, filter: "hypert", count: 5, offset: 0, activeOnly: true });
    expect(expanded).toHaveProperty("valueSet.canonical", FIELD.diagnosis);
    expect(expanded.concepts.length).toBeGreaterThanOrEqual(1);
    expect(expanded.concepts[0]?.code).toBe("38341003");
    expect(expanded.total).toBeGreaterThanOrEqual(expanded.concepts.length);
  });

  it("applies offset and count caps", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const expanded = await adapter.expand({ valueSet: FIELD.diagnosis, filter: "", count: 2, offset: 1, activeOnly: true });
    expect(expanded.concepts.length).toBeLessThanOrEqual(2);
    expect(expanded.concepts[0]?.code).not.toBe("38341003");
  });

  it("returns nothing for an unknown value set", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    await expect(adapter.expand({ valueSet: "https://example.invalid/vs", count: 10, offset: 0, activeOnly: true })).rejects.toThrow("value_set_not_found");
  });

  it("returns reviewed translations for supported laboratory codes", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const map = conceptMapByCanonical("https://medveris.example/fhir/ConceptMap/local-lab-glucose-to-loinc");
    if (!map) throw new Error("expected the reviewed glucose map to be present");
    expect(map.reviewed).toBe(true);
    const result = await adapter.translate({ conceptMap: map.canonical, system: LOCAL_LAB_SYSTEM, code: "GLU", specimen: "Blood", method: "Enzymatic", unit: "mg/dL" });
    expect(result.result).toBe(true);
    expect(result.match?.toCode).toBe("2339-0");
    expect(result.match?.equivalence).toBe("equivalent");
    expect(result.map).toBe(map);
  });

  it("rejects a translation when the laboratory context does not match the reviewed mapping", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const map = conceptMapByCanonical("https://medveris.example/fhir/ConceptMap/local-lab-glucose-to-loinc");
    if (!map) throw new Error("expected the reviewed glucose map to be present");
    const result = await adapter.translate({ conceptMap: map.canonical, system: LOCAL_LAB_SYSTEM, code: "GLU", specimen: "Urine", method: "Enzymatic", unit: "mg/dL" });
    expect(result.result).toBe(false);
    expect(result.message).toContain("specimen");
  });

  it("rejects an unapproved draft mapping", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const map = conceptMapByCanonical("https://medveris.example/fhir/ConceptMap/local-lab-unreviewed-to-loinc");
    if (!map) throw new Error("expected the unapproved draft map to be present");
    const result = await adapter.translate({ conceptMap: map.canonical, system: LOCAL_LAB_SYSTEM, code: "GLU" });
    expect(result.result).toBe(false);
    expect(result.message).toContain("not approved for use");
    expect(result.map).toBe(map);
  });

  it("rejects a translation for a code without a reviewed mapping", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const map = conceptMapByCanonical("https://medveris.example/fhir/ConceptMap/local-lab-glucose-to-loinc");
    if (!map) throw new Error("expected the reviewed glucose map to be present");
    const result = await adapter.translate({ conceptMap: map.canonical, system: LOCAL_LAB_SYSTEM, code: "CREATININE" });
    expect(result.result).toBe(false);
    expect(result.message).toContain("No reviewed translation exists");
  });

  it("search by contextual field returns matching active concepts", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const results = await adapter.search("diagnosis", "hyper", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.display.toLowerCase()).toContain("hyper");
  });

  it("search by an unsupported field returns nothing", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    const results = await adapter.search("radiology", "ct", 10);
    expect(results).toEqual([]);
  });

  it("status reports the local reference catalogue releases", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    expect(adapter.status).toMatchObject({ mode: "local-reference", label: LOCAL_REF_LABEL, connected: true, lastVerifiedAt: expect.any(String) });
    expect(adapter.status.releases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: SNOMED_SYSTEM, version: SNOMED_LOCAL_VERSION, source: "local-reference-catalogue" }),
        expect.objectContaining({ system: LOINC_SYSTEM, version: LOINC_LOCAL_VERSION, source: "local-reference-catalogue" }),
        expect.objectContaining({ system: UCUM_SYSTEM, version: UCUM_LOCAL_VERSION, source: "local-reference-catalogue" }),
      ]),
    );
  });

  it("status does not require an external provider host", () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" }));
    expect(adapter.status.providerHost).toBeNull();
  });

  it("FIELD_VALUE_SETS covers the expected clinical domains", () => {
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("diagnosis");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("clinical-finding");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("procedure");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("allergy-substance");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("allergy-reaction");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("observation");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("unit");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("imaging");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("obstetrics");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("pediatrics");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("nursing");
    expect(Object.keys(FIELD_VALUE_SETS)).toContain("specialty");
  });

  it("local reference value set URLs use local catalogue fixtures, not a licensed SNOMED CT distribution", () => {
    const diagnosisVs = FIELD_VALUE_SETS.diagnosis;
    expect(diagnosisVs).toContain("medveris.example/fhir/ValueSet");
    expect(diagnosisVs).not.toContain("snomed.info/sct/version");
  });
});

describe("local-reference production config acceptance", () => {
  it("allows local-reference in production", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "local-reference" })).not.toThrow();
  });

  it("still refuses synthetic terminology in production", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "synthetic" })).toThrow("TERMINOLOGY_MODE=synthetic is not allowed in production");
  });

  it("still refuses unavailable terminology in production", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "unavailable" })).not.toThrow();
  });

  it("unavailable is still selectable and keeps the dependency error behavior", () => {
    const config = loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "unavailable" });
    expect(config.terminologyMode).toBe("unavailable");
    expect(createTerminology(config).mode).toBe("unavailable");
  });
});
