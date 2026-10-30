import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "./support.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const LOCAL_LAB = "https://medveris.example/local-lab";
const VALUE_SET_BASE = "https://medveris.example/fhir/ValueSet";
const CONCEPT_MAP_BASE = "https://medveris.example/fhir/ConceptMap";
const SYNTHETIC_SYSTEM = "https://medveris.example/synthetic-terminology";

const h = createHarness("terminology");

let clinician: Awaited<ReturnType<typeof h.login>>;
let reception: Awaited<ReturnType<typeof h.login>>;
let laboratory: Awaited<ReturnType<typeof h.login>>;
let admin: Awaited<ReturnType<typeof h.login>>;
let publicId = "";

function param(body: any, name: string) {
  return body.parameter?.find((entry: { name: string }) => entry.name === name);
}

function part(body: any, name: string) {
  return param(body, "match")?.part?.find((entry: { name: string }) => entry.name === name);
}

async function fhir(path: string) {
  const response = await h.call(clinician, path);
  const body = await h.json(response);
  return { response, body };
}

function query(values: Record<string, string | undefined>) {
  return Object.entries(values)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`)
    .join("&");
}

beforeAll(async () => {
  clinician = await h.login("clinician@medveris.local", TENANT_A);
  reception = await h.login("reception@medveris.local", TENANT_A);
  laboratory = await h.login("lab@medveris.local", TENANT_A);
  admin = await h.login("admin@medveris.local", TENANT_A);
  const registered = await h.post(reception, "/api/v1/reception/patients", {
    givenName: "Synthetic", familyName: `Terminology${Date.now()}`, dateOfBirth: "1990-01-01", sex: "female",
    identityConfidence: "confirmed-verbal",
  });
  publicId = registered.patient.publicId;
  const encounter = await h.post(reception, "/api/v1/encounters", {
    patientId: registered.patient.patientId, type: "walk-in", reason: "Terminology acceptance test",
  });
  await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounter.encounterId}/triage`, {
    method: "POST",
    body: JSON.stringify({
      complaint: "Synthetic terminology check",
      urgency: "routine",
      observations: [{
        coding: { system: LOINC, version: "2.80-medveris-synthetic", code: "8867-4", display: "Heart rate" },
        value: 72, unit: { code: "/min", system: UCUM }, occurredAt: new Date().toISOString(),
      }],
      allergyState: "none",
    }),
  }));
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("Terminology validation (AT29)", () => {
  it("validates active, inactive, fabricated and superseded LOINC codes", async () => {
    const active = await fhir(`/terminology/fhir/r4/CodeSystem/$validate-code?${query({
      system: LOINC, code: "2345-7", valueSet: `${VALUE_SET_BASE}/observation-type-synthetic`,
    })}`);
    expect(active.response.status).toBe(200);
    expect(param(active.body, "result")?.valueBoolean).toBe(true);

    const inactive = await fhir(`/terminology/fhir/r4/CodeSystem/$validate-code?${query({
      system: SYNTHETIC_SYSTEM, code: "inactive-example",
    })}`);
    expect(inactive.response.status).toBe(200);
    expect(param(inactive.body, "result")?.valueBoolean).toBe(false);
    expect(param(inactive.body, "message")?.valueString).toContain("inactive");

    const fabricated = await fhir(`/terminology/fhir/r4/CodeSystem/$validate-code?${query({
      system: LOINC, code: "0000-0", valueSet: `${VALUE_SET_BASE}/observation-type-synthetic`,
    })}`);
    expect(fabricated.response.status).toBe(200);
    expect(param(fabricated.body, "result")?.valueBoolean).toBe(false);

    const superseded = await fhir(`/terminology/fhir/r4/CodeSystem/$validate-code?${query({
      system: LOINC, code: "2345-7", version: "2.79-medveris-synthetic",
    })}`);
    expect(superseded.response.status).toBe(200);
    expect(param(superseded.body, "result")?.valueBoolean).toBe(false);
    expect(param(superseded.body, "message")?.valueString).toContain("requested release");
  });

  it("exposes contextual search while preserving the version stored on a signed observation", async () => {
    const search = await fhir("/api/v1/terminology/search?field=observation&q=glucose");
    expect(search.response.status).toBe(200);
    expect(search.body.concepts.map((concept: { code: string }) => concept.code)).toEqual(
      expect.arrayContaining(["2339-0", "2345-7"]),
    );

    const before = await fhir(`/fhir/r4/Observation?patient=${encodeURIComponent(publicId)}`);
    const signedVersion = before.body.entry[0].resource.code.coding[0].version;
    expect(signedVersion).toBe("2.80-medveris-synthetic");

    await fhir(`/terminology/fhir/r4/CodeSystem/$validate-code?${query({
      system: LOINC, code: "8867-4", version: "2.79-medveris-synthetic",
    })}`);

    const after = await fhir(`/fhir/r4/Observation?patient=${encodeURIComponent(publicId)}`);
    expect(after.body.entry[0].resource.code.coding[0].version).toBe(signedVersion);
    expect(after.body.entry[0].resource.status).toBe("final");
  });
});

describe("Laboratory ConceptMap translation (AT30)", () => {
  it("translates a reviewed local code only when specimen, method and unit match", async () => {
    const translated = await fhir(`/terminology/fhir/r4/ConceptMap/$translate?${query({
      conceptMap: `${CONCEPT_MAP_BASE}/local-lab-glucose-to-loinc`,
      system: LOCAL_LAB, code: "GLU", specimen: "Blood", method: "Enzymatic", unit: "mg/dL",
    })}`);
    expect(translated.response.status).toBe(200);
    expect(param(translated.body, "result")?.valueBoolean).toBe(true);
    expect(part(translated.body, "concept")?.valueCoding?.code).toBe("2339-0");
    expect(part(translated.body, "specimen")?.valueString).toBe("Blood");

    const missingContext = await fhir(`/terminology/fhir/r4/ConceptMap/$translate?${query({
      conceptMap: `${CONCEPT_MAP_BASE}/local-lab-glucose-to-loinc`,
      system: LOCAL_LAB, code: "GLU",
    })}`);
    expect(param(missingContext.body, "result")?.valueBoolean).toBe(false);
    expect(param(missingContext.body, "message")?.valueString).toContain("laboratory context");

    const wrongSpecimen = await fhir(`/terminology/fhir/r4/ConceptMap/$translate?${query({
      conceptMap: `${CONCEPT_MAP_BASE}/local-lab-glucose-to-loinc`,
      system: LOCAL_LAB, code: "GLU", specimen: "Serum", method: "Enzymatic", unit: "mg/dL",
    })}`);
    expect(param(wrongSpecimen.body, "result")?.valueBoolean).toBe(false);
    expect(param(wrongSpecimen.body, "message")?.valueString).toContain("specimen");
  });

  it("selects the serum glucose map and refuses an unreviewed draft mapping", async () => {
    const serum = await fhir(`/terminology/fhir/r4/ConceptMap/$translate?${query({
      conceptMap: `${CONCEPT_MAP_BASE}/local-lab-serum-glucose-to-loinc`,
      system: LOCAL_LAB, code: "GLU_SERUM", specimen: "Serum", method: "Hexokinase", unit: "mg/dL",
    })}`);
    expect(param(serum.body, "result")?.valueBoolean).toBe(true);
    expect(part(serum.body, "concept")?.valueCoding?.code).toBe("2345-7");

    const draft = await fhir(`/terminology/fhir/r4/ConceptMap/$translate?${query({
      conceptMap: `${CONCEPT_MAP_BASE}/local-lab-unreviewed-to-loinc`,
      system: LOCAL_LAB, code: "GLU",
    })}`);
    expect(param(draft.body, "result")?.valueBoolean).toBe(false);
    expect(param(draft.body, "message")?.valueString).toContain("not approved");
  });

  it("validates UCUM units and rejects unknown units", async () => {
    const valid = await fhir(`/terminology/fhir/r4/ValueSet/$validate-code?${query({
      system: UCUM, code: "mg/dL", valueSet: `${VALUE_SET_BASE}/ucum-units-synthetic`,
    })}`);
    expect(valid.response.status).toBe(200);
    expect(param(valid.body, "result")?.valueBoolean).toBe(true);

    const invalid = await fhir(`/terminology/fhir/r4/ValueSet/$validate-code?${query({
      system: UCUM, code: "furlong", valueSet: `${VALUE_SET_BASE}/ucum-units-synthetic`,
    })}`);
    expect(param(invalid.body, "result")?.valueBoolean).toBe(false);
  });

  it("refuses to register a device metric with a fabricated LOINC code or non-UCUM unit", async () => {
    const fabricated = await h.call(admin, "/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({
        serial: `SYNTH-${Date.now()}`, manufacturer: "Synthetic Devices", model: "Monitor-1",
        supportedMetrics: [{
          nativeCode: "HR", loincSystem: LOINC, loincVersion: "2.80-medveris-synthetic",
          loincCode: "0000-0", display: "Heart rate", unitCode: "/min",
        }],
      }),
    });
    expect(fabricated.status).toBe(422);

    const badUnit = await h.call(admin, "/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({
        serial: `SYNTH-${Date.now()}`, manufacturer: "Synthetic Devices", model: "Monitor-2",
        supportedMetrics: [{
          nativeCode: "HR", loincSystem: LOINC, loincVersion: "2.80-medveris-synthetic",
          loincCode: "8867-4", display: "Heart rate", unitCode: "furlong",
        }],
      }),
    });
    expect(badUnit.status).toBe(422);
  });

  it("refuses to create a laboratory test with a fabricated LOINC code or non-UCUM unit", async () => {
    const fabricated = await h.call(laboratory, "/api/v1/lab-tests", {
      method: "POST",
      body: JSON.stringify({
        name: "Fabricated test", loincSystem: LOINC, loincVersion: "2.80-medveris-synthetic",
        loincCode: "0000-0", specimenType: "Blood", method: "Enzymatic", unitCode: "mg/dL", mappedReviewed: true,
      }),
    });
    expect(fabricated.status).toBe(422);

    const badUnit = await h.call(laboratory, "/api/v1/lab-tests", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad unit test", loincSystem: LOINC, loincVersion: "2.80-medveris-synthetic",
        loincCode: "2339-0", specimenType: "Blood", method: "Enzymatic", unitCode: "furlong", mappedReviewed: true,
      }),
    });
    expect(badUnit.status).toBe(422);
  });
});
