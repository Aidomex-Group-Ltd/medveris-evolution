import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "./support.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const h = createHarness("fhir");

let clinicianA: Awaited<ReturnType<typeof h.login>>;
let clinicianB: Awaited<ReturnType<typeof h.login>>;
let reception: Awaited<ReturnType<typeof h.login>>;
let patientId = "";
let publicId = "";
let encounterId = "";
let versionId = "";

async function fhir(session: Awaited<ReturnType<typeof h.login>> | null, path: string) {
  const response = session
    ? await h.call(session, path)
    : await h.app.fetch(new Request(`http://localhost${path}`));
  const body = await h.json(response);
  return { response, body };
}

beforeAll(async () => {
  clinicianA = await h.login("clinician@medveris.local", TENANT_A);
  clinicianB = await h.login("clinician.b@medveris.local", TENANT_B);
  reception = await h.login("reception@medveris.local", TENANT_A);

  const registered = await h.post(reception, "/api/v1/reception/patients", {
    givenName: "Synthetic", familyName: `Fhir${Date.now()}`, dateOfBirth: "1990-01-01", sex: "female",
    identityConfidence: "confirmed-verbal",
  });
  patientId = registered.patient.patientId;
  publicId = registered.patient.publicId;
  const encounter = await h.post(reception, "/api/v1/encounters", {
    patientId, type: "walk-in", reason: "FHIR facade acceptance test",
  });
  encounterId = encounter.encounterId;

  await h.expectOk(await h.call(clinicianA, `/api/v1/encounters/${encounterId}/triage`, {
    method: "POST",
    body: JSON.stringify({
      complaint: "Chest discomfort",
      urgency: "urgent",
      observations: [{
        coding: { system: "http://loinc.org", version: "2.80-medveris-synthetic", code: "8867-4", display: "Heart rate" },
        value: 88, unit: { code: "/min", system: "http://unitsofmeasure.org" }, occurredAt: new Date().toISOString(),
      }],
      allergyState: "none",
    }),
  }));

  const draft = await h.post(clinicianA, `/api/v1/encounters/${encounterId}/entries`, {
    title: "FHIR note",
    subjective: "Synthetic subjective",
    objective: "Synthetic objective",
    assessment: "Synthetic assessment",
    plan: "Synthetic plan",
    clinicalOccurredAt: new Date().toISOString(),
    changeNote: "Initial synthetic note for the FHIR facade test",
  });
  await h.expectOk(await h.call(clinicianA, `/api/v1/entries/${draft.entryId}/sign`, {
    method: "POST", body: JSON.stringify({ expectedVersion: 1 }),
  }));

  const documents = await fhir(clinicianA, `/fhir/r4/DocumentReference?patient=${encodeURIComponent(publicId)}`);
  versionId = documents.body.entry?.[0]?.resource?.id ?? "";
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("FHIR R4 facade (AT27)", () => {
  it("serves a CapabilityStatement that advertises only implemented read/search interactions", async () => {
    const { response, body } = await fhir(null, "/fhir/r4/metadata");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/fhir+json");
    expect(body.resourceType).toBe("CapabilityStatement");
    expect(body.fhirVersion).toBe("4.0.1");
    const resources = body.rest[0].resource as Array<{ type: string; interaction: Array<{ code: string }> }>;
    const patient = resources.find((resource) => resource.type === "Patient");
    expect(patient?.interaction.map((entry) => entry.code).sort()).toEqual(["read", "search-type"]);
    const advertised = resources.flatMap((resource) => resource.interaction.map((entry) => entry.code));
    expect(advertised).not.toContain("create");
    expect(advertised).not.toContain("update");
  });

  it("requires a session for every interaction except metadata", async () => {
    const { response, body } = await fhir(null, `/fhir/r4/Patient?identifier=${encodeURIComponent(publicId)}`);
    expect(response.status).toBe(401);
    expect(body.resourceType).toBe("OperationOutcome");
  });

  it("returns Patient, Encounter, Observation and DocumentReference projections for the signed encounter", async () => {
    const patient = await fhir(clinicianA, `/fhir/r4/Patient?identifier=${encodeURIComponent(publicId)}`);
    expect(patient.response.status).toBe(200);
    expect(patient.body.resourceType).toBe("Bundle");
    expect(patient.body.total).toBe(1);
    expect(patient.body.entry[0].resource.resourceType).toBe("Patient");
    expect(patient.body.entry[0].resource.id).toBe(publicId);

    const encounter = await fhir(clinicianA, `/fhir/r4/Encounter?patient=${encodeURIComponent(publicId)}`);
    expect(encounter.response.status).toBe(200);
    expect(encounter.body.entry.some((entry: { resource: { id: string } }) => entry.resource.id === encounterId)).toBe(true);

    const observation = await fhir(clinicianA, `/fhir/r4/Observation?patient=${encodeURIComponent(publicId)}`);
    expect(observation.response.status).toBe(200);
    expect(observation.body.entry[0].resource.code.coding[0].code).toBe("8867-4");

    const document = await fhir(clinicianA, `/fhir/r4/DocumentReference?patient=${encodeURIComponent(publicId)}`);
    expect(document.response.status).toBe(200);
    expect(document.body.entry[0].resource.status).toBe("current");
    expect(document.body.entry[0].resource.docStatus).toBe("final");
    expect(document.body.entry[0].resource.subject.reference).toBe(`Patient/${publicId}`);
  });
});

describe("FHIR error semantics (AT27)", () => {
  it("rejects writes with a 405 OperationOutcome", async () => {
    const response = await h.call(clinicianA, "/fhir/r4/Patient", {
      method: "POST", body: JSON.stringify({ resourceType: "Patient" }),
    });
    const body = await h.json(response);
    expect(response.status).toBe(405);
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue[0].code).toBe("not-supported");
  });

  it("rejects an unsupported search parameter with an OperationOutcome", async () => {
    const { response, body } = await fhir(clinicianA, `/fhir/r4/Encounter?patient=${encodeURIComponent(publicId)}&foo=bar`);
    expect(response.status).toBe(422);
    expect(body.resourceType).toBe("OperationOutcome");
  });

  it("rejects history and unconstrained patient search", async () => {
    const history = await fhir(clinicianA, `/fhir/r4/Patient/_history`);
    expect(history.response.status).toBe(400);
    expect(history.body.resourceType).toBe("OperationOutcome");

    const unconstrained = await fhir(clinicianA, "/fhir/r4/Patient");
    expect(unconstrained.response.status).toBe(400);
    expect(unconstrained.body.resourceType).toBe("OperationOutcome");
  });
});

describe("FHIR cross-tenant isolation (AT28)", () => {
  it("does not leak another facility's patient, encounter or documents by search or read", async () => {
    const patient = await fhir(clinicianB, `/fhir/r4/Patient?identifier=${encodeURIComponent(publicId)}`);
    expect(patient.response.status).toBe(200);
    expect(patient.body.total).toBe(0);

    const encounterSearch = await fhir(clinicianB, `/fhir/r4/Encounter?patient=${encodeURIComponent(publicId)}`);
    expect(encounterSearch.response.status).toBe(404);

    const encounterRead = await fhir(clinicianB, `/fhir/r4/Encounter/${encounterId}`);
    expect(encounterRead.response.status).toBe(404);
    expect(encounterRead.body.resourceType).toBe("OperationOutcome");

    expect(versionId).not.toBe("");
    const documentRead = await fhir(clinicianB, `/fhir/r4/DocumentReference/${versionId}`);
    expect(documentRead.response.status).toBe(404);
    expect(documentRead.body.resourceType).toBe("OperationOutcome");
  });
});
