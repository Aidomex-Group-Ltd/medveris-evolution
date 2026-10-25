export const FHIR_BASE = "/fhir/r4";

const resourceInteractions = {
  Patient: ["read", "search-type"],
  Organization: ["read", "search-type"],
  Practitioner: ["read", "search-type"],
  PractitionerRole: ["read"],
  Encounter: ["read", "search-type"],
  Observation: ["read", "search-type"],
  Condition: ["read", "search-type"],
  AllergyIntolerance: ["read", "search-type"],
  DocumentReference: ["read", "search-type"],
  Consent: ["read", "search-type"],
  Provenance: ["read", "search-type"],
  AuditEvent: ["read", "search-type"],
};

export function capabilityStatement() {
  return {
    resourceType: "CapabilityStatement",
    id: "medveris-m1",
    url: "https://medveris.example/fhir/CapabilityStatement/medveris-m1",
    version: "0.1.0",
    name: "MedverisOutpatientFoundation",
    title: "Medveris M1 outpatient foundation FHIR R4 facade",
    status: "draft",
    experimental: true,
    date: "2026-10-25",
    publisher: "Medveris",
    description:
      "Bounded FHIR R4 projection of the Medveris outpatient foundation. Only implemented read/search interactions are advertised. Clinical writes, transactions, bulk export and external history are disabled.",
    kind: "instance",
    software: { name: "Medveris API", version: "0.1.0" },
    implementation: {
      description: "Authorization, consent, source-tenant and audit controls apply to every FHIR interaction.",
      url: "https://medveris.example/fhir",
    },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    acceptUnknown: "no",
    rest: [
      {
        mode: "server",
        documentation:
          "A session cookie is required for all interactions except /metadata. FHIR scopes or identifiers do not confer access. Cross-facility exchange is not enabled on the FHIR facade in M1; use the audited native exchange path.",
        security: {
          cors: false,
          service: [
            {
              coding: [{ system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "OAuth", display: "OAuth" }],
              text: "HttpOnly secure session for the MVP; SMART/OAuth client registration is not implemented.",
            },
          ],
        },
        resource: Object.entries(resourceInteractions).map(([type, interactions]) => ({
          type,
          profile: `https://medveris.example/fhir/StructureDefinition/Medveris${type}`,
          interaction: interactions.map((code) => ({ code })),
          ...(type === "Patient"
            ? {
                searchParam: [
                  { name: "identifier", type: "token" },
                  { name: "_id", type: "token" },
                ],
              }
            : {}),
          ...(["Encounter", "Observation", "Condition", "AllergyIntolerance", "DocumentReference", "Consent", "Provenance", "AuditEvent"].includes(type)
            ? {
                searchParam: [
                  { name: "patient", type: "reference" },
                  { name: "_count", type: "number" },
                  { name: "_offset", type: "number" },
                ],
              }
            : {}),
        })),
        operation: [],
        compartment: [],
      },
    ],
    messaging: [],
  };
}
