const PROFILE = "https://medveris.example/fhir/StructureDefinition";

export function patientResource(p: Record<string, unknown>) {
  return {
    resourceType: "Patient",
    id: p.publicId,
    meta: {
      versionId: "1",
      lastUpdated: new Date(p.updatedAt as string | Date).toISOString(),
      profile: [`${PROFILE}/MedverisPatient`],
      security: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "PSEUD", display: "pseudonymized" }],
    },
    identifier: [
      { system: "https://medveris.example/patient-id", value: p.publicId },
      ...(p.email ? [{ system: "urn:ietf:rfc:3986", value: p.email }] : []),
    ],
    active: p.mergedInto == null,
    name: [{ use: "official", family: p.familyName, given: [p.givenName] }],
    gender: p.sex,
    birthDate: p.dateOfBirth,
    telecom: [
      ...(p.phone ? [{ system: "phone", value: p.phone }] : []),
      ...(p.email ? [{ system: "email", value: p.email }] : []),
    ],
  };
}

export function organizationResource(t: Record<string, unknown>) {
  return {
    resourceType: "Organization",
    id: t.id,
    meta: { profile: [`${PROFILE}/MedverisOrganization`], lastUpdated: new Date(t.updatedAt as string | Date).toISOString() },
    identifier: [{ system: "https://medveris.example/facility-id", value: t.id }],
    active: t.status === "active",
    name: t.name,
    type: [{ text: t.facilityType }],
    address: [{ city: t.city ?? undefined, country: t.country }],
    telecom: [
      ...(t.phone ? [{ system: "phone", value: t.phone }] : []),
      ...(t.email ? [{ system: "email", value: t.email }] : []),
    ],
  };
}

export function practitionerResource(u: Record<string, unknown>) {
  return {
    resourceType: "Practitioner",
    id: u.id,
    meta: { profile: [`${PROFILE}/MedverisPractitioner`] },
    active: u.status === "active",
    name: [{ use: "official", family: u.familyName, given: [u.givenName] }],
  };
}

export function practitionerRoleResource(m: Record<string, unknown>) {
  return {
    resourceType: "PractitionerRole",
    id: m.id,
    meta: { profile: [`${PROFILE}/MedverisPractitionerRole`] },
    active: m.status === "active",
    practitioner: { reference: `Practitioner/${m.userId}` },
    organization: { reference: `Organization/${m.tenantId}` },
    code: (m.roles as string[]).map((role) => ({ text: role })),
  };
}

const encounterStatus: Record<string, string> = {
  planned: "planned",
  arrived: "arrived",
  triaged: "triaged",
  "in-progress": "in-progress",
  completed: "finished",
  cancelled: "cancelled",
  "entered-in-error": "entered-in-error",
};

export function encounterResource(e: Record<string, unknown>) {
  return {
    resourceType: "Encounter",
    id: e.id,
    meta: {
      versionId: String(e.version),
      lastUpdated: new Date(e.updatedAt as string | Date).toISOString(),
      profile: [`${PROFILE}/MedverisEncounter`],
      source: `Organization/${e.tenantId}`,
    },
    identifier: [{ system: "https://medveris.example/encounter-id", value: e.id }],
    status: encounterStatus[String(e.state)] ?? "unknown",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
    type: [{ text: e.type }],
    subject: { reference: `Patient/${e.publicId}`, display: `${e.givenName} ${e.familyName}` },
    period: { start: new Date(e.openedAt as string | Date).toISOString(), ...(e.closedAt ? { end: new Date(e.closedAt as string | Date).toISOString() } : {}) },
    serviceProvider: { reference: `Organization/${e.tenantId}` },
    reasonCode: [{ text: e.reason }],
  };
}

export function observationResource(o: Record<string, unknown>) {
  const coding = o.coding as Record<string, unknown>;
  return {
    resourceType: "Observation",
    id: o.id,
    meta: { profile: [`${PROFILE}/MedverisObservation`], source: `Organization/${o.tenantId}` },
    status: o.status === "entered-in-error" ? "entered-in-error" : o.status,
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
    code: { coding: [{ system: coding.system, version: coding.version, code: coding.code, display: coding.display }], text: coding.text ?? o.display },
    subject: { reference: `Patient/${o.publicId}` },
    encounter: o.encounterId ? { reference: `Encounter/${o.encounterId}` } : undefined,
    effectiveDateTime: new Date(o.occurredAt as string | Date).toISOString(),
    issued: new Date(o.recordedAt as string | Date).toISOString(),
    performer: [{ reference: `Practitioner/${o.authorId}`, display: o.authorName }],
    valueQuantity: Number.isFinite(Number(o.valueNum))
      ? { value: Number(o.valueNum), unit: o.unitCode, system: o.unitSystem, code: o.unitCode }
      : undefined,
    valueString: o.valueText ?? undefined,
  };
}

export function conditionResource(c: Record<string, unknown>) {
  const coding = c.coding as Record<string, unknown>;
  return {
    resourceType: "Condition",
    id: c.id,
    meta: { profile: [`${PROFILE}/MedverisCondition`], source: `Organization/${c.tenantId}` },
    clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: c.clinicalStatus }] },
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
    code: { coding: [{ system: coding.system, version: coding.version, code: coding.code, display: coding.display }], text: coding.text ?? c.display },
    subject: { reference: `Patient/${c.publicId}` },
    encounter: c.encounterId ? { reference: `Encounter/${c.encounterId}` } : undefined,
    onsetDateTime: c.onsetDate ?? undefined,
    recordedDate: new Date(c.recordedAt as string | Date).toISOString(),
    recorder: { reference: `Practitioner/${c.authorId}`, display: c.authorName },
    note: c.note ? [{ text: c.note }] : undefined,
  };
}

export function allergyResource(a: Record<string, unknown>) {
  const substance = a.substanceCoding as Record<string, unknown> | null;
  const reaction = a.reactionCoding as Record<string, unknown> | null;
  const text = a.state === "unknown" ? "Allergy status unknown" : a.state === "none" ? "No known allergies" : substance?.display;
  return {
    resourceType: "AllergyIntolerance",
    id: a.id,
    meta: { profile: [`${PROFILE}/MedverisAllergyIntolerance`], source: `Organization/${a.tenantId}` },
    clinicalStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
          code: a.state === "recorded" ? "active" : "inactive",
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
          code: a.state === "recorded" ? "confirmed" : "unconfirmed",
        },
      ],
    },
    type: a.state === "recorded" ? "allergy" : undefined,
    category: a.state === "recorded" ? ["medication"] : undefined,
    code: substance
      ? { coding: [{ system: substance.system, version: substance.version, code: substance.code, display: substance.display }], text }
      : { text },
    patient: { reference: `Patient/${a.publicId}` },
    encounter: a.encounterId ? { reference: `Encounter/${a.encounterId}` } : undefined,
    recordedDate: new Date(a.recordedAt as string | Date).toISOString(),
    recorder: { reference: `Practitioner/${a.authorId}`, display: a.authorName },
    reaction: reaction
      ? [{ manifestation: [{ coding: [{ system: reaction.system, version: reaction.version, code: reaction.code, display: reaction.display }] }], severity: a.severity }]
      : undefined,
    note: a.note ? [{ text: a.note }] : undefined,
  };
}

export function documentReferenceResource(v: Record<string, unknown>) {
  const content = v.content as Record<string, unknown>;
  const text = [
    `Title: ${v.title}`,
    `Subjective: ${content.subjective ?? ""}`,
    `Objective: ${content.objective ?? ""}`,
    `Assessment: ${content.assessment ?? ""}`,
    `Plan: ${content.plan ?? ""}`,
  ].join("\n");
  return {
    resourceType: "DocumentReference",
    id: v.id,
    meta: {
      versionId: String(v.version),
      lastUpdated: new Date(v.recordedAt as string | Date).toISOString(),
      profile: [`${PROFILE}/MedverisDocumentReference`],
      source: `Organization/${v.tenantId}`,
      security: ((v.sensitivity as string[]) ?? []).map((code) => ({ system: "https://medveris.example/security-label", code })),
    },
    status: v.status === "entered-in-error" ? "entered-in-error" : "current",
    docStatus: v.status === "amended" ? "amended" : "final",
    type: { coding: [{ system: "http://loinc.org", code: "11506-3", display: "Progress note" }], text: "Outpatient progress note" },
    category: [{ text: "Clinical note" }],
    subject: { reference: `Patient/${v.publicId}`, display: `${v.givenName} ${v.familyName}` },
    date: new Date(v.occurredAt as string | Date).toISOString(),
    author: [{ reference: `Practitioner/${v.authorId}`, display: v.authorName }],
    custodian: { reference: `Organization/${v.tenantId}` },
    description: String(v.title),
    content: [
      {
        attachment: {
          contentType: "text/plain; charset=utf-8",
          data: btoa(unescape(encodeURIComponent(text))),
          title: String(v.title),
          creation: new Date(v.occurredAt as string | Date).toISOString(),
        },
      },
    ],
    context: v.encounterId ? { encounter: [{ reference: `Encounter/${v.encounterId}` }], period: { start: new Date(v.occurredAt as string | Date).toISOString() } } : undefined,
  };
}

export function consentResource(g: Record<string, unknown>) {
  const active = !g.revokedAt && new Date(g.expiresAt as string | Date).getTime() > Date.now() && new Date(g.startsAt as string | Date).getTime() <= Date.now();
  return {
    resourceType: "Consent",
    id: g.id,
    meta: { versionId: String(g.version), profile: [`${PROFILE}/MedverisConsent`] },
    status: active ? "active" : "inactive",
    scope: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/consentscope", code: "patient-privacy" }] },
    category: [{ coding: [{ system: "http://loinc.org", code: "59284-0", display: "Patient Consent" }] }],
    patient: { reference: `Patient/${g.publicId}` },
    dateTime: new Date(g.createdAt as string | Date).toISOString(),
    performer: [{ display: "Patient" }],
    policyRule: { text: String(g.policyVersion) },
    provision: {
      type: "permit",
      period: { start: new Date(g.startsAt as string | Date).toISOString(), end: new Date(g.expiresAt as string | Date).toISOString() },
      actor: [{ role: { text: "Recipient facility" }, reference: { reference: `Organization/${g.recipientTenantId}` } }],
      action: (g.categories as string[]).map((category) => ({ coding: [{ system: "https://medveris.example/consent-category", code: category }] })),
      purpose: [{ text: String(g.purpose) }],
    },
  };
}

export function provenanceResource(v: Record<string, unknown>) {
  return {
    resourceType: "Provenance",
    id: v.id,
    meta: { profile: [`${PROFILE}/MedverisProvenance`] },
    target: [{ reference: `DocumentReference/${v.id}` }],
    recorded: new Date(v.recordedAt as string | Date).toISOString(),
    activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: v.status === "amended" ? "UPDATE" : "CREATE", display: v.status }] },
    agent: [{ type: { text: "author" }, who: { reference: `Practitioner/${v.authorId}`, display: v.authorName }, onBehalfOf: { reference: `Organization/${v.tenantId}` } }],
    entity: [{ role: "source", what: { reference: `DocumentReference/${v.id}` } }],
  };
}

export function auditEventResource(a: Record<string, unknown>) {
  return {
    resourceType: "AuditEvent",
    id: a.id,
    meta: { profile: [`${PROFILE}/MedverisAuditEvent`] },
    type: { system: "https://medveris.example/audit-action", code: String(a.action) },
    action: a.decision === "deny" ? "E" : "R",
    period: { start: new Date(a.occurredAt as string | Date).toISOString() },
    recorded: new Date(a.occurredAt as string | Date).toISOString(),
    outcome: a.decision === "deny" ? "8" : "0",
    agent: [{ who: { identifier: { value: String(a.actorUserId ?? "system") } }, requestor: true, type: { text: String(a.actorKind) } }],
    source: { observer: { display: "Medveris" }, site: a.tenantId ? String(a.tenantId) : undefined },
    entity: [{ what: a.subjectPatientId ? { reference: `Patient/${a.subjectPatientId}` } : undefined, type: { code: String(a.resourceType ?? "system") } }],
  };
}
