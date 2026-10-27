import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(200);
/**
 * Canonicalises a typed public patient ID: case, spaces and dashes are ignored, and the Crockford
 * look-alikes O→0 and I/L→1 are corrected. Input that is not 16 ID characters after "MV" is returned
 * unchanged so validation still rejects it.
 */
export function normalizePatientPublicId(input: string): string {
  const compact = input.toUpperCase().replace(/[\s\-_.]/g, "");
  if (!compact.startsWith("MV")) return input.trim();
  const body = compact.slice(2).replace(/O/g, "0").replace(/[IL]/g, "1");
  if (body.length !== 16) return input.trim();
  return `MV-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`;
}

export const publicPatientIdSchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizePatientPublicId(value) : value),
  z.string().regex(/^MV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
);

export const roleSchema = z.enum([
  "patient",
  "proxy",
  "receptionist",
  "nurse",
  "midwife",
  "clinician",
  "specialist_clinician",
  "diagnostic_practitioner",
  "department_lead",
  "facility_admin",
  "finance",
  "auditor",
  "credential_reviewer",
  "pharmacist",
  "laboratory",
  "radiology",
  "public_health",
  "hr",
  "records",
  "theatre",
  "housekeeping",
  "porter",
  "mortuary",
  "cssd",
  "biomedical",
  "quality",
  "it_admin",
  "research",
  "content_editor",
  "content_reviewer",
  "opportunity_moderator",
]);

export const codingSchema = z.object({
  system: z.string().url().max(500),
  version: z.string().min(1).max(500),
  code: z.string().min(1).max(100),
  display: z.string().min(1).max(1000),
  text: z.string().max(5000).optional(),
  userSelected: z.boolean().optional(),
});

export const registerPatientSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  givenName: z.string().trim().min(1).max(120),
  familyName: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().date(),
  sex: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
});

export const registerFacilitySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  givenName: z.string().trim().min(1).max(120),
  familyName: z.string().trim().min(1).max(120),
  facilityName: z.string().trim().min(2).max(200),
  facilityType: z.string().trim().min(1).max(80).default("outpatient"),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  country: z.string().trim().max(120).default("Uganda"),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const mfaLoginSchema = z.object({
  challengeId: uuidSchema,
  code: z.string().trim().regex(/^\d{6}$/),
});

export const mfaEnrollVerifySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});

export const invitationAcceptSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
  givenName: z.string().trim().min(1).max(120),
  familyName: z.string().trim().min(1).max(120),
});

export const createInvitationSchema = z.object({
  email: emailSchema,
  roles: z.array(roleSchema).min(1),
});

export const createPatientByStaffSchema = z.object({
  givenName: z.string().trim().min(1).max(120),
  familyName: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().date(),
  sex: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  email: z.string().email().max(254).optional().or(z.literal("")),
  identityConfidence: z.enum(["confirmed-document", "confirmed-verbal", "temporary", "uncertain"]).default("confirmed-verbal"),
  assistedWithoutContactDetails: z.boolean().default(false),
});

export const resolvePatientSchema = z.object({
  publicId: publicPatientIdSchema,
  familyName: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().date(),
});

export const patientSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().date().optional().or(z.literal("").transform(() => undefined)),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const appointmentSchema = z.object({
  patientId: uuidSchema,
  clinicianUserId: uuidSchema.optional().nullable(),
  startAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(480).default(20),
  reason: z.string().trim().min(1).max(1000),
});

export const appointmentRescheduleSchema = z.object({
  startAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(480),
  clinicianUserId: uuidSchema.optional().nullable(),
  note: z.string().trim().min(5).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const appointmentStatusSchema = z.object({
  status: z.enum(["cancelled", "no-show"]),
  note: z.string().trim().min(5).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const queueEntrySchema = z.object({
  patientId: uuidSchema,
  appointmentId: uuidSchema.optional().nullable(),
  priority: z.enum(["routine", "urgent", "emergency"]).default("routine"),
});

export const createEncounterSchema = z.object({
  patientId: uuidSchema,
  appointmentId: uuidSchema.optional().nullable(),
  queueEntryId: uuidSchema.optional().nullable(),
  type: z.enum(["walk-in", "scheduled", "follow-up", "emergency", "inpatient", "theatre", "telehealth"]).default("walk-in"),
  reason: z.string().trim().min(1).max(2000),
});

export const transitionEncounterSchema = z.object({
  state: z.enum(["planned", "arrived", "triaged", "in-progress", "completed", "cancelled", "entered-in-error"]),
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(2000).optional(),
});

export const triageSchema = z.object({
  complaint: z.string().trim().min(1).max(4000),
  urgency: z.enum(["routine", "urgent", "emergency"]),
  notes: z.string().trim().max(4000).optional().or(z.literal("")),
  observations: z
    .array(
      z.object({
        coding: codingSchema,
        value: z.number().finite(),
        unit: z.object({ code: z.string().min(1).max(30), system: z.string().url().default("http://unitsofmeasure.org") }),
        occurredAt: z.string().datetime(),
      }),
    )
    .default([]),
  allergyState: z.enum(["unknown", "none", "recorded"]),
  allergy: z
    .object({
      substance: codingSchema,
      reaction: codingSchema.optional().nullable(),
      note: z.string().max(2000).optional().or(z.literal("")),
    })
    .optional()
    .nullable(),
});

export const createDraftEntrySchema = z.object({
  title: z.string().trim().min(1).max(300),
  subjective: z.string().trim().max(20000),
  objective: z.string().trim().max(20000),
  assessment: z.string().trim().max(20000),
  plan: z.string().trim().max(20000),
  clinicalOccurredAt: z.string().datetime(),
  changeNote: z.string().trim().min(5).max(2000),
});

export const updateDraftEntrySchema = createDraftEntrySchema.extend({
  expectedVersion: z.number().int().min(1),
});

export const signEntrySchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export const amendEntrySchema = z.object({
  expectedVersion: z.number().int().min(1),
  changeNote: z.string().trim().min(10).max(2000),
  title: z.string().trim().min(1).max(300),
  subjective: z.string().trim().max(20000),
  objective: z.string().trim().max(20000),
  assessment: z.string().trim().max(20000),
  plan: z.string().trim().max(20000),
  clinicalOccurredAt: z.string().datetime(),
});

export const enteredInErrorSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(10).max(2000),
});

export const observationSchema = z.object({
  coding: codingSchema,
  value: z.number().finite(),
  unit: z.object({
    code: z.string().min(1).max(30),
    system: z.string().url().default("http://unitsofmeasure.org"),
  }),
  occurredAt: z.string().datetime(),
  note: z.string().max(2000).optional().or(z.literal("")),
});

export const conditionSchema = z.object({
  coding: codingSchema,
  clinicalStatus: z.enum(["active", "recurrence", "relapse", "inactive", "remission", "resolved"]).default("active"),
  onsetDate: z.string().date().optional().nullable(),
  note: z.string().max(4000).optional().or(z.literal("")),
});

export const allergySchema = z.object({
  state: z.enum(["unknown", "none", "recorded"]),
  substance: codingSchema.optional().nullable(),
  reaction: codingSchema.optional().nullable(),
  severity: z.enum(["mild", "moderate", "severe", "unknown"]).default("unknown"),
  note: z.string().max(2000).optional().or(z.literal("")),
});

export const followUpSchema = z.object({
  dueDate: z.string().date(),
  instructions: z.string().trim().min(1).max(4000),
});

export const referralSchema = z.object({
  toFacility: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(1).max(4000),
  priority: z.enum(["routine", "urgent", "emergency"]).default("routine"),
});

export const createGrantSchema = z.object({
  patientId: uuidSchema,
  recipientTenantId: uuidSchema,
  sourceTenantIds: z.array(uuidSchema).min(1),
  categories: z
    .array(z.enum(["encounter", "note", "observation", "condition", "allergy", "follow-up", "referral"]))
    .min(1),
  purpose: z.string().trim().min(5).max(1000),
  legalBasis: z.enum(["patient-consent", "continuing-care", "emergency", "statutory"]),
  authorizationEvidence: z.string().trim().min(5).max(2000),
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sensitivityExclusions: z
    .array(z.enum(["mental-health", "reproductive-health", "genetic", "hiv"]))
    .default([]),
});

export const revokeGrantSchema = z.object({
  reason: z.string().trim().min(5).max(2000),
});

export const emergencyOverrideSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema,
  reason: z.string().trim().min(10).max(2000),
  password: z.string().min(1).max(200),
  totpCode: z.string().trim().regex(/^\d{6}$/),
});

export const credentialSchema = z.object({
  subjectType: z.enum(["practitioner", "facility"]),
  subjectUserId: uuidSchema.optional().nullable(),
  subjectTenantId: uuidSchema.optional().nullable(),
  onboardingCaseId: uuidSchema.optional().nullable(),
  credentialType: z.string().trim().min(1).max(120),
  issuer: z.string().trim().min(1).max(300),
  jurisdiction: z.string().trim().min(1).max(120),
  regulatorCode: z.string().trim().max(40).optional().or(z.literal("")),
  registrationNumber: z.string().trim().max(120).optional().or(z.literal("")),
  licenceNumber: z.string().trim().max(120).optional().or(z.literal("")),
  credentialNumber: z.string().trim().min(1).max(120),
  qualifications: z.string().trim().max(2000).optional().or(z.literal("")),
  specialtyCredentials: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  scope: z.string().trim().max(1000).optional().or(z.literal("")),
  issuedOn: z.string().date(),
  expiresOn: z.string().date(),
  evidenceUploadId: uuidSchema.optional().nullable(),
});

export const credentialDecisionSchema = z.object({
  decision: z.enum(["verified", "rejected"]),
  reason: z.string().trim().min(10).max(2000),
  checksPerformed: z.string().trim().min(5).max(3000),
  expiresOn: z.string().date().optional().nullable(),
});

export const facilityCredentialDecisionSchema = z.object({
  decision: z.enum(["verified", "rejected", "suspended", "expired"]),
  reason: z.string().trim().min(10).max(2000),
  checksPerformed: z.string().trim().max(3000).optional().or(z.literal("")),
  expiresOn: z.string().date().optional().nullable(),
});

export const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  declaredType: z.string().trim().min(3).max(120),
  dataBase64: z.string().min(1),
});

export const passwordForgotSchema = z.object({ email: emailSchema });
export const passwordResetSchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});

export const switchTenantSchema = z.object({ tenantId: uuidSchema });
export const verifyEmailSchema = z.object({ token: z.string().min(20) });

export const terminologyLookupSchema = z.object({
  system: z.string().url(),
  code: z.string().min(1).max(100),
  version: z.string().max(500).optional(),
  display: z.string().max(1000).optional(),
});

export const terminologyValidateSchema = terminologyLookupSchema.extend({
  valueSet: z.string().url().optional(),
  valueSetVersion: z.string().max(500).optional(),
});

export const terminologyExpandSchema = z.object({
  valueSet: z.string().url(),
  valueSetVersion: z.string().max(500).optional(),
  filter: z.string().max(200).optional(),
  count: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  activeOnly: z.boolean().default(true),
});

export const terminologyTranslateSchema = z.object({
  conceptMap: z.string().url(),
  conceptMapVersion: z.string().max(500).optional(),
  system: z.string().url(),
  code: z.string().min(1).max(100),
});

export type Role = z.infer<typeof roleSchema>;
export type Coding = z.infer<typeof codingSchema>;

// M2 clinical departments and M3 operations.
export const wardSchema = z.object({
  name: z.string().trim().min(2).max(120),
  wardType: z.enum(["general", "adult-male", "adult-female", "pediatric", "surgical", "maternity", "nicu", "icu"]),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const bedSchema = z.object({
  label: z.string().trim().min(1).max(40),
  features: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const bedStatusSchema = z.object({
  status: z.enum(["available", "occupied", "cleaning", "unavailable"]),
  reason: z.string().trim().max(1000).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

export const admissionSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema,
  wardType: z.enum(["general", "adult-male", "adult-female", "pediatric", "surgical", "maternity", "nicu", "icu"]),
  attendingUserId: uuidSchema.optional().nullable(),
  reason: z.string().trim().min(5).max(4000),
});

export const admissionBedSchema = z.object({
  bedId: uuidSchema,
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().max(1000).optional(),
});

export const admissionTransitionSchema = z.object({
  status: z.enum(["discharged", "transferred-out", "deceased", "cancelled"]),
  expectedVersion: z.number().int().min(1),
  summary: z.string().trim().max(20000).optional().or(z.literal("")),
  reason: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const nursingAssessmentSchema = z.object({
  shift: z.enum(["day", "evening", "night"]),
  notes: z.string().trim().min(2).max(10000),
  painScore: z.number().int().min(0).max(10).optional().nullable(),
  mobility: z.string().trim().max(500).optional().or(z.literal("")),
  skin: z.string().trim().max(500).optional().or(z.literal("")),
});

export const nursingTaskSchema = z.object({
  description: z.string().trim().min(2).max(2000),
  dueAt: z.string().datetime().optional().nullable(),
});

export const nursingTaskUpdateSchema = z.object({
  status: z.enum(["completed", "cancelled"]),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const handoffSchema = z.object({
  toUserId: uuidSchema,
  summary: z.string().trim().min(5).max(10000),
});

export const theatreSchema = z.object({
  name: z.string().trim().min(2).max(120),
  status: z.enum(["available", "maintenance", "closed"]).default("available"),
});

export const theatreCaseSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema,
  admissionId: uuidSchema.optional().nullable(),
  procedureName: z.string().trim().min(2).max(500),
  procedureCoding: codingSchema.optional().nullable(),
  laterality: z.enum(["left", "right", "bilateral", "not-applicable"]).default("not-applicable"),
  site: z.string().trim().max(200).optional().or(z.literal("")),
  urgency: z.enum(["routine", "urgent", "emergency"]).default("routine"),
  scheduledAt: z.string().datetime(),
  theatreId: uuidSchema.optional().nullable(),
  surgeonUserId: uuidSchema.optional().nullable(),
  anesthetistUserId: uuidSchema.optional().nullable(),
});

export const theatreCaseTransitionSchema = z.object({
  status: z.enum(["scheduled", "preop-ready", "in-theatre", "recovery", "completed", "cancelled"]),
  expectedVersion: z.number().int().min(1),
  emergencyExceptionReason: z.string().trim().min(10).max(2000).optional(),
  cancellationReason: z.string().trim().min(5).max(2000).optional(),
});

export const preopAssessmentSchema = z.object({
  investigationsReviewed: z.boolean(),
  fitness: z.string().trim().min(2).max(4000),
  notes: z.string().trim().max(10000).optional().or(z.literal("")),
});

export const theatreConsentSchema = z.object({
  procedureConsent: z.boolean(),
  siteMarked: z.boolean(),
  consentReference: z.string().trim().min(2).max(500),
});

export const theatreChecklistSchema = z.object({
  stage: z.enum(["sign-in", "time-out", "sign-out"]),
  items: z.record(z.string(), z.boolean()),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const anesthesiaRecordSchema = z.object({
  anesthesiaType: z.string().trim().min(2).max(200),
  notes: z.string().trim().min(2).max(20000),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional().nullable(),
});

export const recoveryObservationSchema = z.object({
  respiratory: z.string().trim().min(1).max(1000),
  circulation: z.string().trim().min(1).max(1000),
  consciousness: z.string().trim().min(1).max(1000),
  pain: z.string().trim().min(1).max(1000),
  notes: z.string().trim().max(4000).optional().or(z.literal("")),
  occurredAt: z.string().datetime(),
});

export const theatreCountSchema = z.object({
  itemType: z.string().trim().min(1).max(200),
  expectedCount: z.number().int().min(0),
  actualCount: z.number().int().min(0),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const theatreSpecimenSchema = z.object({
  specimenType: z.string().trim().min(1).max(200),
  destination: z.string().trim().min(1).max(300),
});

export const labTestSchema = z.object({
  name: z.string().trim().min(2).max(300),
  loincSystem: z.string().url().default("http://loinc.org"),
  loincVersion: z.string().trim().min(1).max(200),
  loincCode: z.string().trim().min(1).max(100),
  specimenType: z.string().trim().min(1).max(200),
  method: z.string().trim().max(300).optional().or(z.literal("")),
  unitCode: z.string().trim().min(1).max(60),
  mappedReviewed: z.boolean().default(false),
});

export const serviceOrderSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema,
  orderType: z.enum(["laboratory", "imaging", "other"]),
  priority: z.enum(["routine", "urgent", "emergency"]).default("routine"),
  clinicalNote: z.string().trim().min(2).max(4000),
  items: z.array(z.object({
    labTestId: uuidSchema.optional().nullable(),
    name: z.string().trim().min(1).max(300),
    specimenType: z.string().trim().max(200).optional().or(z.literal("")),
  })).min(1).max(50),
});

export const orderTransitionSchema = z.object({
  status: z.enum(["collected", "in-progress", "resulted", "cancelled"]),
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().max(2000).optional(),
});

export const specimenSchema = z.object({
  orderItemId: uuidSchema,
  specimenType: z.string().trim().min(1).max(200),
  collectedAt: z.string().datetime().optional().nullable(),
});

export const specimenTransitionSchema = z.object({
  status: z.enum(["received", "rejected"]),
  reason: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const labResultSchema = z.object({
  orderItemId: uuidSchema,
  valueNum: z.number().finite().optional().nullable(),
  valueText: z.string().trim().max(4000).optional().or(z.literal("")),
  unitCode: z.string().trim().max(60).optional().or(z.literal("")),
  referenceRange: z.string().trim().max(500).optional().or(z.literal("")),
  interpretation: z.enum(["normal", "abnormal", "critical", "indeterminate"]).default("indeterminate"),
  critical: z.boolean().default(false),
  status: z.enum(["preliminary", "final"]).default("preliminary"),
});

export const labResultCorrectionSchema = z.object({
  valueNum: z.number().finite().optional().nullable(),
  valueText: z.string().trim().max(4000).optional().or(z.literal("")),
  unitCode: z.string().trim().max(60).optional().or(z.literal("")),
  referenceRange: z.string().trim().max(500).optional().or(z.literal("")),
  interpretation: z.enum(["normal", "abnormal", "critical", "indeterminate"]).default("indeterminate"),
  critical: z.boolean().default(false),
  changeReason: z.string().trim().min(10).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const criticalCommunicationSchema = z.object({
  recipientUserId: uuidSchema,
  method: z.enum(["phone", "in-person", "secure-message"]),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const imagingStudySchema = z.object({
  orderItemId: uuidSchema,
  modality: z.string().trim().min(2).max(20),
  bodySite: z.string().trim().min(1).max(200),
  studyInstanceUid: z.string().trim().max(200).optional().or(z.literal("")),
  accession: z.string().trim().max(100).optional().or(z.literal("")),
  pacsState: z.enum(["not-configured", "pending", "reconciled", "quarantined"]).default("not-configured"),
  reconciliationNote: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const diagnosticReportSchema = z.object({
  orderItemId: uuidSchema,
  studyId: uuidSchema.optional().nullable(),
  findings: z.string().trim().min(2).max(20000),
  impression: z.string().trim().min(2).max(10000),
  critical: z.boolean().default(false),
  status: z.enum(["preliminary", "final"]).default("preliminary"),
});

export const diagnosticReportCorrectionSchema = z.object({
  findings: z.string().trim().min(2).max(20000),
  impression: z.string().trim().min(2).max(10000),
  critical: z.boolean().default(false),
  changeReason: z.string().trim().min(10).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const diagnosticAssignmentSchema = z.object({
  reporterUserId: uuidSchema,
});

export const diagnosticReleaseSchema = z.object({
  releaseNote: z.string().trim().min(5).max(2000),
  expectedVersion: z.number().int().min(1).optional(),
});

export const criticalAcknowledgementSchema = z.object({
  note: z.string().trim().min(5).max(2000),
});

export const medicineSchema = z.object({
  name: z.string().trim().min(2).max(300),
  strength: z.string().trim().min(1).max(100),
  form: z.string().trim().min(1).max(100),
  route: z.string().trim().min(1).max(100),
  codeSystem: z.string().url().optional().or(z.literal("")),
  codeVersion: z.string().trim().max(200).optional().or(z.literal("")),
  code: z.string().trim().max(100).optional().or(z.literal("")),
  knowledgeSource: z.string().trim().max(500).optional().or(z.literal("")),
});

export const medicationOrderSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema,
  medicineId: uuidSchema,
  doseText: z.string().trim().min(1).max(300),
  route: z.string().trim().min(1).max(100),
  frequency: z.string().trim().min(1).max(200),
  durationDays: z.number().int().min(1).max(365).optional().nullable(),
});

export const medicationReviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().min(5).max(4000),
});

export const dispenseSchema = z.object({
  orderId: uuidSchema,
  lotId: uuidSchema,
  quantity: z.number().positive().max(100000),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const administrationSchema = z.object({
  orderId: uuidSchema,
  doseText: z.string().trim().min(1).max(300),
  administeredAt: z.string().datetime(),
  site: z.string().trim().max(200).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
  status: z.enum(["administered", "refused", "held"]).default("administered"),
  witnessedBy: uuidSchema.optional().nullable(),
});

export const stockLotSchema = z.object({
  medicineId: uuidSchema,
  lotNumber: z.string().trim().min(1).max(100),
  expiresOn: z.string().date(),
  quantity: z.number().min(0).max(10000000),
  location: z.string().trim().min(1).max(200),
});

export const stockMovementSchema = z.object({
  lotId: uuidSchema,
  delta: z.number().min(-10000000).max(10000000),
  reason: z.string().trim().min(3).max(1000),
});

export const serviceCatalogSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(300),
  category: z.enum(["consultation", "procedure", "laboratory", "imaging", "pharmacy", "bed", "other"]),
  price: z.number().min(0).max(100000000),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
});

export const invoiceSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema.optional().nullable(),
  items: z.array(z.object({
    serviceId: uuidSchema.optional().nullable(),
    description: z.string().trim().min(1).max(300),
    quantity: z.number().positive().max(10000),
    unitPrice: z.number().min(0).max(100000000).optional(),
  })).min(1).max(100),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const paymentSchema = z.object({
  invoiceId: uuidSchema,
  amount: z.number().positive().max(100000000),
  method: z.enum(["cash", "bank-transfer", "mobile-money", "manual"]),
  reference: z.string().trim().max(200).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const paymentReversalSchema = z.object({
  reason: z.string().trim().min(10).max(2000),
});

export const claimSchema = z.object({
  invoiceId: uuidSchema,
  insurer: z.string().trim().min(2).max(300),
  coverAmount: z.number().positive().max(100000000),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const programmeSchema = z.object({
  name: z.string().trim().min(2).max(300),
  programmeType: z.enum(["primary-care", "preventive", "immunization", "chronic", "maternal", "hospice", "palliative", "community"]),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  conditionCoding: codingSchema.optional().nullable(),
});

export const enrolmentSchema = z.object({
  patientId: uuidSchema,
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const carePlanSchema = z.object({
  goals: z.array(z.object({
    description: z.string().trim().min(2).max(1000),
    targetDate: z.string().date().optional().nullable(),
  })).max(50),
  interventions: z.string().trim().min(2).max(20000),
  reviewDue: z.string().date().optional().nullable(),
  changeNote: z.string().trim().min(5).max(2000),
});

export const programmeEventSchema = z.object({
  eventType: z.enum(["immunization", "screening", "community-referral", "home-visit", "symptom", "review"]),
  details: z.string().trim().min(2).max(10000),
  occurredAt: z.string().datetime(),
  coding: codingSchema.optional().nullable(),
});

export const advanceCareSchema = z.object({
  documentType: z.enum(["advance-directive", "treatment-preference", "resuscitation-preference", "other"]),
  content: z.string().trim().min(5).max(20000),
  witnessedBy: z.string().trim().max(200).optional().or(z.literal("")),
});

export const publicHealthReportSchema = z.object({
  programmeId: uuidSchema.optional().nullable(),
  title: z.string().trim().min(3).max(300),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  conditionSystem: z.string().url().optional().or(z.literal("")),
  conditionCode: z.string().trim().max(100).optional().or(z.literal("")),
  ageMin: z.number().int().min(0).max(130).optional().nullable(),
  ageMax: z.number().int().min(0).max(130).optional().nullable(),
  caseDefinitionVersion: z.string().trim().min(1).max(100),
  minCell: z.number().int().min(2).max(100).default(5),
});

export const publicHealthReviewSchema = z.object({
  decision: z.enum(["reviewed", "rejected"]),
  note: z.string().trim().min(5).max(4000),
  expectedVersion: z.number().int().min(1),
});

export const publicHealthReleaseSchema = z.object({
  recipient: z.string().trim().min(2).max(300),
  purpose: z.string().trim().min(5).max(1000),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const telehealthSessionSchema = z.object({
  appointmentId: uuidSchema.optional().nullable(),
  patientId: uuidSchema,
  clinicianUserId: uuidSchema,
  scheduledAt: z.string().datetime(),
});

export const telehealthConsentSchema = z.object({
  consent: z.boolean(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const telehealthCompleteSchema = z.object({
  connectionStatus: z.enum(["completed", "failed"]),
  notes: z.string().trim().max(10000).optional().or(z.literal("")),
});

export const deviceSchema = z.object({
  serial: z.string().trim().min(3).max(200),
  manufacturer: z.string().trim().min(2).max(200),
  model: z.string().trim().min(1).max(200),
  firmware: z.string().trim().max(100).optional().or(z.literal("")),
  site: z.string().trim().max(300).optional().or(z.literal("")),
  supportedMetrics: z.array(z.object({
    nativeCode: z.string().trim().min(1).max(100),
    loincSystem: z.string().url().default("http://loinc.org"),
    loincVersion: z.string().trim().min(1).max(200),
    loincCode: z.string().trim().min(1).max(100),
    display: z.string().trim().min(1).max(300),
    unitCode: z.string().trim().min(1).max(60),
  })).default([]),
});

export const deviceAssignmentSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema,
});

export const deviceObservationSchema = z.object({
  eventId: z.string().trim().min(8).max(200),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  nativeCode: z.string().trim().min(1).max(100),
  value: z.number().finite(),
  unit: z.string().trim().min(1).max(60),
  measuredAt: z.string().datetime(),
  quality: z.enum(["valid", "questionable", "invalid"]).default("valid"),
});

export const alertAcknowledgementSchema = z.object({
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const aiJobSchema = z.object({
  taskType: z.enum(["record-summary", "diagnostic-support", "prediction", "radiology-assist", "image-analysis"]),
  patientId: uuidSchema,
  evidenceEntryIds: z.array(uuidSchema).default([]),
  studyId: uuidSchema.optional().nullable(),
});

export const carePlanUpdateSchema = carePlanSchema.extend({
  expectedVersion: z.number().int().min(1),
});

export const labResultFinalizeSchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

// Emergency care.
export const emergencyCaseSchema = z
  .object({
    patientId: uuidSchema.optional().nullable(),
    temporaryPatient: z
      .object({
        givenName: z.string().trim().min(1).max(120).default("Unknown"),
        familyName: z.string().trim().min(1).max(120).default("Emergency"),
        dateOfBirth: z.string().date(),
        sex: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
      })
      .optional()
      .nullable(),
    reason: z.string().trim().min(1).max(2000),
    arrivalMode: z.enum(["walk-in", "ambulance", "referral", "police", "other"]).default("walk-in"),
    location: z.string().trim().max(120).optional().or(z.literal("")),
    assignedUserId: uuidSchema.optional().nullable(),
  })
  .refine((value) => Boolean(value.patientId) !== Boolean(value.temporaryPatient), {
    message: "Provide either an existing patient or temporary patient details, not both",
    path: ["patientId"],
  });

export const emergencyObservationSchema = observationSchema;

export const emergencyHandoffSchema = handoffSchema;

export const emergencyDispositionSchema = z.object({
  disposition: z.enum(["admitted", "discharged", "transferred", "deceased", "left-without-seen", "cancelled"]),
  note: z.string().trim().min(5).max(4000),
  expectedVersion: z.number().int().min(1),
});

// Local follow-up and referral tracking. These records are not external
// referral transmissions.
export const followUpStatusSchema = z.object({
  status: z.enum(["completed", "cancelled"]),
  note: z.string().trim().min(5).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const referralStatusSchema = z.object({
  status: z.enum(["accepted", "declined", "completed", "cancelled"]),
  note: z.string().trim().min(5).max(2000),
  expectedVersion: z.number().int().min(1),
});

// Organisation and workforce.
export const departmentSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(2).max(160),
  departmentType: z.enum([
    "governance","patient-access","outpatient","emergency","inpatient","maternity",
    "pediatrics","critical-care","theatre","laboratory","blood-bank","radiology",
    "pharmacy","renal","mental-health","rehabilitation","nutrition","dental",
    "eye-ent","primary-community","palliative","ipc-quality","cssd","mortuary",
    "housekeeping","portering","engineering","catering","security","finance",
    "hr","procurement","digital-health","other",
  ]),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  parentDepartmentId: uuidSchema.optional().nullable(),
  enabled: z.boolean().default(true),
});

export const unitSchema = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(2).max(160),
  unitType: z.string().trim().min(2).max(80).default("general"),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  enabled: z.boolean().default(true),
});

export const locationSchema = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(1).max(160),
  locationType: z.enum(["ward","room","bed-space","theatre","laboratory-bench","storage","office","reception","vehicle","other"]),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const cadreSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9-]+$/),
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(80),
  isco08Code: z.string().trim().max(8).optional().or(z.literal("")),
  isco08Reviewed: z.boolean().default(false),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const jobTitleSchema = z.object({
  name: z.string().trim().min(2).max(160),
  cadreId: uuidSchema.optional().nullable(),
  grade: z.string().trim().max(80).optional().or(z.literal("")),
});

export const onboardingStartSchema = z.object({
  givenName: z.string().trim().min(1).max(120),
  familyName: z.string().trim().min(1).max(120),
  preferredName: z.string().trim().max(120).optional().or(z.literal("")),
  professionalDisplayName: z.string().trim().max(160).optional().or(z.literal("")),
  email: z.string().email().max(254).optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  preferredLanguage: z.string().trim().max(20).default("en"),
  engagementType: z.enum(["employee","contractor","student","intern","trainee","volunteer","locum","visiting-practitioner"]).default("employee"),
  employer: z.string().trim().max(200).optional().or(z.literal("")),
  employeeNumber: z.string().trim().max(80).optional().or(z.literal("")),
  startDate: z.string().date(),
  endDate: z.string().date().optional().nullable(),
  jobTitleId: uuidSchema.optional().nullable(),
  grade: z.string().trim().max(80).optional().or(z.literal("")),
  cadreId: uuidSchema.optional().nullable(),
  primaryDepartmentId: uuidSchema.optional().nullable(),
  primaryUnitId: uuidSchema.optional().nullable(),
  additionalDepartmentIds: z.array(uuidSchema).max(20).default([]),
  appointmentTitle: z.string().trim().max(160).optional().or(z.literal("")),
  catalogueTitleCode: z.string().trim().max(80).optional().or(z.literal("")),
  catalogueCadreCode: z.string().trim().max(80).optional().or(z.literal("")),
  specialtyCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  customTitleRequestId: uuidSchema.optional().nullable(),
  staffPersonId: uuidSchema.optional().nullable(),
  catalogueVersion: z.number().int().positive().optional(),
  requestedSystemRoles: z.array(roleSchema).max(5).default([]),
});

export const onboardingCataloguePublishSchema = z.object({
  countryCode: z.string().trim().length(2).toUpperCase().default("UG"),
  version: z.number().int().positive(),
  notice: z.string().trim().max(4000).optional(),
  content: z.unknown().optional(),
  status: z.enum(["draft", "published"]).default("published"),
});

export const onboardingCatalogueDraftPublishSchema = z.object({
  reason: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const customTitleRequestSchema = z.object({
  proposedName: z.string().trim().min(2).max(160),
  cadreCode: z.string().trim().max(80).optional().or(z.literal("")),
  departmentCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  specialtyCodes: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  explanation: z.string().trim().min(10).max(2000),
  onboardingCaseId: uuidSchema.optional().nullable(),
});

export const customTitleDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(10).max(2000),
  approvedName: z.string().trim().min(2).max(160).optional(),
});

export const facilityCredentialPolicySchema = z.object({
  cadreCode: z.string().trim().max(80).optional().or(z.literal("")),
  credentialType: z.string().trim().min(2).max(120),
  regulatorCode: z.string().trim().max(40).optional().or(z.literal("")),
  requiresDocument: z.boolean().default(true),
  requiresLicence: z.boolean().default(true),
  reviewRequired: z.boolean().default(true),
  active: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const proxyScopesSchema = z.enum(["profile", "appointments", "records", "consent"]);

export const proxyRequestSchema = z.object({
  proxyEmail: emailSchema.optional(),
  proxyUserId: uuidSchema.optional(),
  relationship: z.string().trim().min(2).max(80),
  scopes: z.array(proxyScopesSchema).min(1).max(4),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
}).refine((value) => Boolean(value.proxyEmail || value.proxyUserId), {
  message: "A proxy email or user identifier is required",
  path: ["proxyEmail"],
});

export const proxyDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(10).max(1000),
});

export const onboardingUpdateSchema = z.object({
  status: z.enum(["invited","identity","employment","professional","assignments","credentials","privileges","review","access","induction","active","rejected","withdrawn"]).optional(),
  currentStep: z.number().int().min(1).max(20).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const onboardingDecisionSchema = z.object({
  decision: z.enum(["approve","reject","return"]),
  reason: z.string().trim().min(10).max(2000),
});

export const assignmentSchema = z.object({
  departmentId: uuidSchema,
  unitId: uuidSchema.optional().nullable(),
  locationId: uuidSchema.optional().nullable(),
  isPrimary: z.boolean().default(false),
  appointmentTitle: z.string().trim().max(160).optional().or(z.literal("")),
  reportingManagerStaffId: uuidSchema.optional().nullable(),
  onCallEligible: z.boolean().default(false),
  startsOn: z.string().date(),
  endsOn: z.string().date().optional().nullable(),
});

export const privilegeRequestSchema = z.object({
  privilegeId: uuidSchema,
  scope: z.string().trim().max(1000).optional().or(z.literal("")),
  requestedFor: z.string().date().optional().nullable(),
  expiresOn: z.string().date().optional().nullable(),
});

export const privilegeDecisionSchema = z.object({
  decision: z.enum(["approved","rejected"]),
  reason: z.string().trim().min(10).max(2000),
  scope: z.string().trim().max(1000).optional().or(z.literal("")),
  effectiveFrom: z.string().date().optional().nullable(),
  expiresOn: z.string().date().optional().nullable(),
});

export const trainingRecordSchema = z.object({
  trainingType: z.string().trim().min(2).max(200),
  completedOn: z.string().date().optional().nullable(),
  expiresOn: z.string().date().optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

// Document and template registry.
const templateFieldSchema = z.object({
  key: z.string().trim().min(2).max(80),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["text","textarea","number","decimal","boolean","date","datetime","select","coded","quantity","repeating-group"]),
  required: z.boolean().default(false),
  unit: z.string().trim().max(40).optional(),
  options: z.array(z.string().trim().min(1).max(200)).optional(),
  section: z.string().trim().max(120).optional(),
  sensitivity: z.string().trim().max(80).optional(),
});

export const templateSchema = z.object({
  templateKey: z.string().trim().min(2).max(100).regex(/^[a-z0-9][a-z0-9.-]+$/),
  name: z.string().trim().min(2).max(240),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  departmentId: uuidSchema.optional().nullable(),
  context: z.enum(["clinical","nursing","maternity","theatre","diagnostic","pharmacy","administrative","operational","hr","mortuary","housekeeping","portering","technical"]).default("clinical"),
  purpose: z.string().trim().max(1000).optional().or(z.literal("")),
  sensitivity: z.enum(["standard","sensitive","restricted"]).default("standard"),
  fields: z.array(templateFieldSchema).min(1).max(200),
  authorRoles: z.array(roleSchema).min(1).default(["clinician","nurse"]),
  reviewerRoles: z.array(roleSchema).default(["clinician"]),
  signingRequired: z.boolean().default(true),
  countersignRequired: z.boolean().default(false),
  amendmentRules: z.string().trim().max(2000).optional().or(z.literal("")),
  retentionClass: z.string().trim().max(80).default("clinical-standard"),
  effectiveFrom: z.string().date().optional().nullable(),
});

export const templatePublishSchema = z.object({
  expectedVersion: z.number().int().min(1),
  approvalNote: z.string().trim().min(5).max(2000),
});

export const documentCreateSchema = z.object({
  templateId: uuidSchema,
  subjectType: z.enum(["patient","staff","operational"]).default("patient"),
  patientId: uuidSchema.optional().nullable(),
  encounterId: uuidSchema.optional().nullable(),
  staffSubjectId: uuidSchema.optional().nullable(),
  departmentId: uuidSchema.optional().nullable(),
  unitId: uuidSchema.optional().nullable(),
  title: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime(),
  content: z.record(z.string(), z.unknown()),
  changeNote: z.string().trim().min(5).max(2000).default("Initial draft"),
  sensitivity: z.array(z.string().trim().max(80)).default([]),
});

export const documentDraftUpdateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime(),
  content: z.record(z.string(), z.unknown()),
  changeNote: z.string().trim().min(5).max(2000),
});

export const documentSignSchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const documentAmendSchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime(),
  content: z.record(z.string(), z.unknown()),
  changeNote: z.string().trim().min(10).max(2000),
});

export const documentErrorSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(10).max(2000),
});

// Maternity.
export const maternityEpisodeSchema = z.object({
  patientId: uuidSchema,
  encounterId: uuidSchema.optional().nullable(),
  gravidity: z.number().int().min(0).max(30).optional().nullable(),
  parity: z.number().int().min(0).max(30).optional().nullable(),
  estimatedDueDate: z.string().date().optional().nullable(),
  datingBasis: z.enum(["lmp","ultrasound","clinical","unknown"]).optional().nullable(),
  riskLevel: z.enum(["not-assessed","low","moderate","high"]).default("not-assessed"),
  notes: z.string().trim().max(5000).optional().or(z.literal("")),
});

export const maternityEpisodeUpdateSchema = z.object({
  status: z.enum(["active","delivered","closed","transferred-out","cancelled"]).optional(),
  riskLevel: z.enum(["not-assessed","low","moderate","high"]).optional(),
  gravidity: z.number().int().min(0).max(30).optional().nullable(),
  parity: z.number().int().min(0).max(30).optional().nullable(),
  estimatedDueDate: z.string().date().optional().nullable(),
  datingBasis: z.enum(["lmp","ultrasound","clinical","unknown"]).optional().nullable(),
  notes: z.string().trim().max(5000).optional().or(z.literal("")),
  expectedVersion: z.number().int().min(1).optional(),
});

export const labourObservationSchema = z.object({
  templateType: z.enum(["labour-care-guide","partograph"]),
  clinicalOccurredAt: z.string().datetime(),
  maternal: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}),
  fetal: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}),
  notes: z.string().trim().max(5000).optional().or(z.literal("")),
  lateEntry: z.boolean().default(false),
});

export const deliveryRecordSchema = z.object({
  deliveredAt: z.string().datetime(),
  mode: z.enum(["spontaneous-vaginal","assisted-vaginal","caesarean","other"]),
  outcome: z.enum(["live-birth","stillbirth","multiple","other"]),
  bloodLossMl: z.number().min(0).max(20000).optional().nullable(),
  perineum: z.string().trim().max(500).optional().or(z.literal("")),
  complications: z.string().trim().max(5000).optional().or(z.literal("")),
  notes: z.string().trim().max(5000).optional().or(z.literal("")),
});

export const newbornRecordSchema = z.object({
  givenName: z.string().trim().min(1).max(120).default("Baby"),
  familyName: z.string().trim().min(1).max(120),
  sex: z.enum(["female","male","other","unknown"]).default("unknown"),
  bornAt: z.string().datetime().optional().nullable(),
  weightG: z.number().int().min(200).max(10000).optional().nullable(),
  apgar1: z.number().int().min(0).max(10).optional().nullable(),
  apgar5: z.number().int().min(0).max(10).optional().nullable(),
  feeding: z.string().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(5000).optional().or(z.literal("")),
});

// Ward operations, housekeeping, portering and mortuary.
export const bedReadinessSchema = z.object({
  status: z.enum(["available","occupied","vacated","awaiting-cleaning","cleaning-in-progress","cleaning","ready","out-of-service","unavailable"]),
  reason: z.string().trim().max(1000).optional(),
  cleaningTaskId: uuidSchema.optional().nullable(),
  expectedVersion: z.number().int().min(1).optional(),
});

export const cleaningTaskSchema = z.object({
  bedId: uuidSchema.optional().nullable(),
  locationId: uuidSchema.optional().nullable(),
  zone: z.string().trim().min(1).max(160),
  taskType: z.enum(["routine","terminal","discharge","isolation","spill","inspection","other"]),
  riskLevel: z.enum(["low","medium","high"]).default("low"),
  assignedToUserId: uuidSchema.optional().nullable(),
  instructions: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const cleaningTransitionSchema = z.object({
  status: z.enum(["in-progress","completed","verified","cancelled"]),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const porterTaskSchema = z.object({
  requestType: z.enum(["patient-transfer","specimen","equipment","document","other"]),
  patientId: uuidSchema.optional().nullable(),
  encounterId: uuidSchema.optional().nullable(),
  fromLocation: z.string().trim().min(1).max(200),
  toLocation: z.string().trim().min(1).max(200),
  assignedToUserId: uuidSchema.optional().nullable(),
  specimenCustody: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const porterTransitionSchema = z.object({
  status: z.enum(["accepted","in-progress","completed","cancelled"]),
  identityChecked: z.boolean().optional(),
  delayReason: z.string().trim().max(1000).optional().or(z.literal("")),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const fluidBalanceSchema = z.object({
  occurredAt: z.string().datetime(),
  intakeMl: z.number().min(0).max(50000).optional().nullable(),
  outputMl: z.number().min(0).max(50000).optional().nullable(),
  source: z.enum(["oral","intravenous","urine","drain","vomit","stool","other"]),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const mortuaryCaseSchema = z.object({
  patientId: uuidSchema.optional().nullable(),
  deceasedName: z.string().trim().min(2).max(200),
  identityStatus: z.enum(["unknown","provisional","verified"]).default("unknown"),
  receivedFrom: z.string().trim().min(1).max(300),
  storageLocation: z.string().trim().min(1).max(200),
  deathConfirmedAt: z.string().datetime().optional().nullable(),
  deathDocumentRef: z.string().trim().max(200).optional().or(z.literal("")),
  causeDocumentRef: z.string().trim().max(200).optional().or(z.literal("")),
  notes: z.string().trim().max(5000).optional().or(z.literal("")),
});

export const mortuaryMovementSchema = z.object({
  movementType: z.enum(["receipt","internal-transfer","post-mortem","release","return","other"]),
  fromLocation: z.string().trim().max(200).optional().or(z.literal("")),
  toLocation: z.string().trim().min(1).max(200),
  identityChecked: z.boolean(),
  witnessedBy: z.string().trim().max(200).optional().or(z.literal("")),
  occurredAt: z.string().datetime().optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const mortuaryEffectsSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(1000).default(1),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export const mortuaryReleaseSchema = z.object({
  releasedToName: z.string().trim().min(2).max(200),
  relationship: z.string().trim().min(2).max(160),
  authorityReference: z.string().trim().min(2).max(300),
  identificationMethod: z.string().trim().min(2).max(300),
  identityVerifiedBy: uuidSchema,
  handoverWitness: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const engineeringAssetSchema = z.object({
  assetRef: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(200),
  category: z.string().trim().min(2).max(120),
  location: z.string().trim().max(200).optional().or(z.literal("")),
  nextMaintenanceOn: z.string().date().optional().nullable(),
});

export const maintenanceOrderSchema = z.object({
  assetId: uuidSchema,
  fault: z.string().trim().min(5).max(4000),
  priority: z.enum(["routine","urgent","emergency"]).default("routine"),
  assignedToUserId: uuidSchema.optional().nullable(),
});

export const maintenanceTransitionSchema = z.object({
  status: z.enum(["assigned","in-progress","completed","verified","cancelled"]),
  releaseNote: z.string().trim().max(4000).optional().or(z.literal("")),
});

export const cssdCycleSchema = z.object({
  sterilizer: z.string().trim().min(1).max(120),
  cycleRef: z.string().trim().min(1).max(120),
  loadCount: z.number().int().min(0).max(10000).default(0),
  indicatorResult: z.enum(["pass","fail","pending"]),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const cssdReleaseSchema = z.object({
  releaseNote: z.string().trim().min(5).max(2000),
  expectedVersion: z.number().int().min(1).optional(),
});

// Consultation note type support. Structured sections are additive; legacy
// SOAP content remains valid.
export const consultationNoteTypeSchema = z.enum([
  "initial-consultation","follow-up-consultation","soap","admission-clerking","progress-note",
  "specialist-consultation","procedure-note","referral","handoff","discharge-summary","teleconsultation",
]);

export const consultationSectionsSchema = z.object({
  presentingComplaint: z.string().trim().max(10000).optional().or(z.literal("")),
  historyOfPresentingIllness: z.string().trim().max(20000).optional().or(z.literal("")),
  medicalHistory: z.string().trim().max(10000).optional().or(z.literal("")),
  medicationHistory: z.string().trim().max(10000).optional().or(z.literal("")),
  allergyStatus: z.string().trim().max(2000).optional().or(z.literal("")),
  familySocialHistory: z.string().trim().max(10000).optional().or(z.literal("")),
  reviewOfSystems: z.string().trim().max(10000).optional().or(z.literal("")),
  investigationReview: z.string().trim().max(10000).optional().or(z.literal("")),
  differential: z.string().trim().max(10000).optional().or(z.literal("")),
  diagnoses: z.string().trim().max(10000).optional().or(z.literal("")),
  procedures: z.string().trim().max(10000).optional().or(z.literal("")),
  counselling: z.string().trim().max(10000).optional().or(z.literal("")),
  followUp: z.string().trim().max(10000).optional().or(z.literal("")),
  disposition: z.string().trim().max(5000).optional().or(z.literal("")),
  reviewedUnchanged: z.boolean().default(false),
  copiedForward: z.boolean().default(false),
});

// Versioned non-clinical content and professional opportunities.
export const contentAudienceSchema = z.enum(["general","patient","professional","specialty","organization","department"]);
export const contentScopeSchema = z.enum(["public","authenticated","patient","professional","specialty","organization","department"]);
export const contentStatusSchema = z.enum(["draft","in-review","published","archived","withdrawn"]);

export const contentCreateSchema = z.object({
  contentType: z.enum(["public-health-advisory","health-education","research-update","guideline","professional-learning","facility-announcement"]),
  slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9][a-z0-9-]+$/),
  title: z.string().trim().min(2).max(300),
  summary: z.string().trim().min(10).max(4000),
  body: z.string().trim().max(60000).optional().or(z.literal("")),
  sourceId: uuidSchema.optional().nullable(),
  sourceOrganization: z.string().trim().max(300).optional().or(z.literal("")),
  sourceUrl: z.string().url().max(2000).optional().nullable(),
  publicationDate: z.string().date().optional().nullable(),
  language: z.string().trim().min(2).max(20).default("en"),
  geography: z.string().trim().max(160).optional().or(z.literal("")),
  audience: contentAudienceSchema.default("general"),
  specialtyTags: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  visibilityScope: contentScopeSchema.default("public"),
  visibilityValues: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  attribution: z.string().trim().max(1000).optional().or(z.literal("")),
  reuseTerms: z.string().trim().max(2000).optional().or(z.literal("")),
  sponsorshipDisclosure: z.string().trim().max(2000).optional().or(z.literal("")),
  studyType: z.string().trim().max(160).optional().or(z.literal("")),
  population: z.string().trim().max(500).optional().or(z.literal("")),
  findingsSummary: z.string().trim().max(8000).optional().or(z.literal("")),
  limitations: z.string().trim().max(8000).optional().or(z.literal("")),
  peerReviewStatus: z.enum(["peer-reviewed","preprint","not-applicable","unknown"]).optional().nullable(),
  editorialPriority: z.number().int().min(0).max(100).default(50),
  reviewDueOn: z.string().date().optional().nullable(),
});

export const contentUpdateSchema = contentCreateSchema.partial().extend({
  expectedVersion: z.number().int().min(1),
  changeNote: z.string().trim().min(5).max(2000),
});

export const contentDecisionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().min(5).max(4000),
  reviewDueOn: z.string().date().optional().nullable(),
});

export const contentPreferencesSchema = z.object({
  language: z.string().trim().min(2).max(20).default("en"),
  geography: z.string().trim().max(160).optional().or(z.literal("")),
  specialtyTags: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  interests: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  hidePatientOpportunities: z.boolean().default(false),
  hideProfessionalOpportunities: z.boolean().default(false),
});

export const contentReportSchema = z.object({
  reason: z.enum(["inaccurate","outdated","unsafe","spam","copyright","privacy","other"]),
  detail: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const opportunityCreateSchema = z.object({
  opportunityType: z.enum(["employment","locum","cpd","conference","fellowship","training","research-collaboration","community-screening","health-education","patient-support","study-participation"]),
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().min(10).max(20000),
  organization: z.string().trim().min(2).max(300),
  audience: z.enum(["patient","professional","both"]).default("professional"),
  specialtyTags: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  eligibility: z.string().trim().max(4000).optional().or(z.literal("")),
  location: z.string().trim().max(300).optional().or(z.literal("")),
  remote: z.boolean().default(false),
  applicationUrl: z.string().url().max(2000).optional().nullable(),
  contactRoute: z.string().trim().max(500).optional().or(z.literal("")),
  opensOn: z.string().date().optional().nullable(),
  closesOn: z.string().date().optional().nullable(),
  compensation: z.string().trim().max(500).optional().or(z.literal("")),
  cpdDetails: z.string().trim().max(2000).optional().or(z.literal("")),
  sourceEvidence: z.string().trim().max(2000).optional().or(z.literal("")),
  sponsorshipStatus: z.enum(["none","sponsored","unknown"]).default("none"),
});

export const opportunityUpdateSchema = opportunityCreateSchema.partial().extend({
  expectedVersion: z.number().int().min(1).optional(),
});

export const opportunityDecisionSchema = z.object({
  decision: z.enum(["publish","reject","archive"]),
  note: z.string().trim().min(5).max(4000),
  verificationStatus: z.enum(["unverified","details-checked","source-verified"]).optional(),
  verifiedChecks: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const contentSourceSchema = z.object({
  name: z.string().trim().min(2).max(200),
  sourceKind: z.enum(["public-health-authority","government","professional-body","journal-index","institutional","opportunity-board","manual"]),
  baseUrl: z.string().url().max(2000).optional().nullable(),
  rssUrl: z.string().url().max(2000).optional().nullable(),
  termsNote: z.string().trim().max(2000).optional().or(z.literal("")),
  tenantScoped: z.boolean().default(true),
});

export const roleGrantRequestSchema = z.object({
  userId: uuidSchema,
  role: roleSchema,
  departmentId: uuidSchema.optional().nullable(),
  scopeNote: z.string().trim().max(1000).optional().or(z.literal("")),
  startsAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});

export const roleGrantDecisionSchema = z.object({
  decision: z.enum(["approved","rejected","revoked"]),
  reason: z.string().trim().min(10).max(2000),
});

export const careTeamAssignmentSchema = z.object({
  patientId: uuidSchema,
  userId: uuidSchema.optional().nullable(),
  relationship: z.enum(["primary","covering","consulting","multidisciplinary","nursing","diagnostic"]),
  departmentId: uuidSchema.optional().nullable(),
  purpose: z.string().trim().max(1000).optional().or(z.literal("")),
  endsAt: z.string().datetime().optional().nullable(),
});

// Departmental inventory and fixed assets.
export const inventoryLocationSchema = z.object({
  code: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/),
  name: z.string().trim().min(2).max(200),
  locationType: z.enum(["central-store","department-store","unit-store","ward-store","room","cabinet","bin","equipment-location"]),
  parentId: uuidSchema.optional().nullable(),
  departmentId: uuidSchema.optional().nullable(),
  unitId: uuidSchema.optional().nullable(),
  physicalLocationId: uuidSchema.optional().nullable(),
  custodianUserId: uuidSchema.optional().nullable(),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const inventoryItemUnitSchema = z.object({
  unit: z.string().trim().min(1).max(40),
  conversionFactor: z.number().positive().max(1000000),
  isBase: z.boolean().default(false),
  purchasingUnit: z.boolean().default(false),
  issuingUnit: z.boolean().default(false),
});

export const inventoryItemSchema = z.object({
  itemCode: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(300),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  category: z.string().trim().min(1).max(120),
  subcategory: z.string().trim().max(120).optional().or(z.literal("")),
  classification: z.enum(["consumable","medicine","asset","reusable","returnable"]),
  baseUnit: z.string().trim().min(1).max(40),
  medicineId: uuidSchema.optional().nullable(),
  manufacturer: z.string().trim().max(200).optional().or(z.literal("")),
  supplierName: z.string().trim().max(200).optional().or(z.literal("")),
  barcode: z.string().trim().max(200).optional().or(z.literal("")),
  lotTracked: z.boolean().default(false),
  serialTracked: z.boolean().default(false),
  expiryTracked: z.boolean().default(false),
  storageRequirements: z.string().trim().max(1000).optional().or(z.literal("")),
  criticality: z.enum(["standard","medium","high","critical"]).default("standard"),
  unitCost: z.number().min(0).max(1000000000).default(0),
  currency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).default("UGX"),
  units: z.array(inventoryItemUnitSchema).min(1),
});

export const inventoryItemUpdateSchema = z.object({
  name: z.string().trim().min(2).max(300).optional(),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  category: z.string().trim().min(1).max(120).optional(),
  subcategory: z.string().trim().max(120).optional().or(z.literal("")),
  criticality: z.enum(["standard","medium","high","critical"]).optional(),
  unitCost: z.number().min(0).max(1000000000).optional(),
  currency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).optional(),
  storageRequirements: z.string().trim().max(1000).optional().or(z.literal("")),
  status: z.enum(["active","discontinued"]).optional(),
});

export const inventoryPolicySchema = z.object({
  locationId: uuidSchema,
  itemId: uuidSchema,
  minimumQuantity: z.number().min(0).default(0),
  maximumQuantity: z.number().min(0).optional().nullable(),
  reorderQuantity: z.number().min(0).default(0),
  criticality: z.enum(["standard","medium","high","critical"]).default("standard"),
});

export const inventoryReceiptSchema = z.object({
  locationId: uuidSchema,
  itemId: uuidSchema,
  lotNumber: z.string().trim().max(120).optional().or(z.literal("")),
  expiresOn: z.string().date().optional().nullable(),
  manufactureOn: z.string().date().optional().nullable(),
  supplier: z.string().trim().max(200).optional().or(z.literal("")),
  receiptReference: z.string().trim().max(200).optional().or(z.literal("")),
  quantity: z.number().positive().max(100000000),
  unit: z.string().trim().min(1).max(40),
  occurredAt: z.string().datetime().optional(),
  reason: z.string().trim().min(5).max(2000),
  referenceType: z.string().trim().max(80).optional().or(z.literal("")),
  referenceId: z.string().trim().max(200).optional().or(z.literal("")),
});

export const inventoryIssueSchema = z.object({
  locationId: uuidSchema,
  itemId: uuidSchema,
  lotId: uuidSchema.optional().nullable(),
  quantity: z.number().positive().max(100000000),
  unit: z.string().trim().min(1).max(40),
  destinationLocationId: uuidSchema.optional().nullable(),
  movementType: z.enum(["issue","consumption","return","write-off"]).default("issue"),
  reason: z.string().trim().min(5).max(2000),
  occurredAt: z.string().datetime().optional(),
  referenceType: z.string().trim().max(80).optional().or(z.literal("")),
  referenceId: z.string().trim().max(200).optional().or(z.literal("")),
  reservationId: uuidSchema.optional().nullable(),
});

export const stockReservationSchema = z.object({
  locationId: uuidSchema,
  itemId: uuidSchema,
  lotId: uuidSchema.optional().nullable(),
  quantity: z.number().positive().max(100000000),
  sourceType: z.string().trim().min(2).max(80),
  sourceId: z.string().trim().max(200).optional().or(z.literal("")),
  expiresAt: z.string().datetime().optional().nullable(),
});

export const inventoryRequisitionSchema = z.object({
  requestingLocationId: uuidSchema.optional().nullable(),
  requestingDepartmentId: uuidSchema.optional().nullable(),
  fulfillingLocationId: uuidSchema,
  reason: z.string().trim().min(5).max(2000),
  lines: z.array(z.object({
    itemId: uuidSchema,
    quantity: z.number().positive().max(100000000),
    unit: z.string().trim().min(1).max(40),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
  })).min(1).max(200),
});

export const inventoryRequisitionDecisionSchema = z.object({
  decision: z.enum(["approve","reject"]),
  reason: z.string().trim().min(10).max(2000),
  lines: z.array(z.object({
    lineId: uuidSchema,
    approvedQuantity: z.number().min(0).max(100000000),
  })).optional(),
  expectedVersion: z.number().int().min(1),
});

export const inventoryRequisitionIssueSchema = z.object({
  lineId: uuidSchema,
  quantity: z.number().positive().max(100000000),
  unit: z.string().trim().min(1).max(40),
  lotId: uuidSchema.optional().nullable(),
  expectedVersion: z.number().int().min(1),
});

export const inventoryTransferSchema = z.object({
  sourceLocationId: uuidSchema,
  destinationLocationId: uuidSchema,
  lines: z.array(z.object({
    itemId: uuidSchema,
    lotId: uuidSchema.optional().nullable(),
    quantity: z.number().positive().max(100000000),
    unit: z.string().trim().min(1).max(40),
  })).min(1).max(200),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const inventoryTransferDispatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export const inventoryTransferReceiveSchema = z.object({
  lines: z.array(z.object({
    lineId: uuidSchema,
    receivedQuantity: z.number().min(0).max(100000000),
    rejectedQuantity: z.number().min(0).max(100000000).default(0),
    discrepancyReason: z.string().trim().max(2000).optional().or(z.literal("")),
  })).min(1),
  expectedVersion: z.number().int().min(1),
});

export const inventoryCountSchema = z.object({
  locationId: uuidSchema,
  blind: z.boolean().default(false),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
  lines: z.array(z.object({
    itemId: uuidSchema,
    lotId: uuidSchema.optional().nullable(),
    countedQuantity: z.number().min(0).max(100000000),
    reasonCode: z.string().trim().max(80).optional().or(z.literal("")),
  })).min(1).max(500),
});

export const inventoryCountDecisionSchema = z.object({
  decision: z.enum(["approve","reject"]),
  reason: z.string().trim().min(10).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const inventoryAdjustmentSchema = z.object({
  locationId: uuidSchema,
  itemId: uuidSchema,
  lotId: uuidSchema.optional().nullable(),
  quantityDelta: z.number().min(-100000000).max(100000000).refine((value) => value !== 0, "A non-zero adjustment is required"),
  unit: z.string().trim().min(1).max(40),
  reasonCode: z.enum(["breakage","wastage","loss","expiry","correction","disposal","other"]),
  reason: z.string().trim().min(10).max(2000),
  expectedVersion: z.number().int().min(1).optional(),
});

export const inventoryAdjustmentDecisionSchema = z.object({
  decision: z.enum(["approve","reject"]),
  reason: z.string().trim().min(10).max(2000),
  expectedVersion: z.number().int().min(1),
});

export const inventoryRecallSchema = z.object({
  itemId: uuidSchema,
  lotId: uuidSchema.optional().nullable(),
  reason: z.string().trim().min(10).max(4000),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const inventoryAssetSchema = z.object({
  itemId: uuidSchema.optional().nullable(),
  assetTag: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(300),
  manufacturer: z.string().trim().max(200).optional().or(z.literal("")),
  model: z.string().trim().max(200).optional().or(z.literal("")),
  serialNumber: z.string().trim().max(200).optional().or(z.literal("")),
  locationId: uuidSchema.optional().nullable(),
  departmentId: uuidSchema.optional().nullable(),
  custodianUserId: uuidSchema.optional().nullable(),
  acquisitionDate: z.string().date().optional().nullable(),
  acquisitionCost: z.number().min(0).max(100000000000).optional().nullable(),
  currency: z.string().trim().length(3).regex(/^[A-Z]{3}$/).default("UGX"),
  warrantyEndsOn: z.string().date().optional().nullable(),
  serviceAgreement: z.string().trim().max(2000).optional().or(z.literal("")),
  maintenanceIntervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  nextMaintenanceOn: z.string().date().optional().nullable(),
  nextCalibrationOn: z.string().date().optional().nullable(),
  notes: z.string().trim().max(4000).optional().or(z.literal("")),
});

export const inventoryAssetEventSchema = z.object({
  eventType: z.enum(["commission","assignment","transfer","loan","maintenance","calibration","fault","service-release","retirement"]),
  note: z.string().trim().min(5).max(4000),
  toStatus: z.enum(["pending-commissioning","in-service","reserved","under-maintenance","out-of-service","retired"]),
  toCustody: z.enum(["in-store","assigned","in-use","in-transit","maintenance","retired"]).optional(),
  custodianUserId: uuidSchema.optional().nullable(),
  locationId: uuidSchema.optional().nullable(),
  nextMaintenanceOn: z.string().date().optional().nullable(),
  nextCalibrationOn: z.string().date().optional().nullable(),
  expectedVersion: z.number().int().min(1),
});

// Public provider directory, discovery and claims.
export const facilityTypeSchema = z.enum([
  "hospital","clinic","health-centre","diagnostic-centre","pharmacy",
  "dental","eye","mental-health","rehabilitation","maternity","other",
]);
export const directoryBranchSchema = z.object({
  name: z.string().trim().min(2).max(200),
  isPrimary: z.boolean().default(false),
  addressLine1: z.string().trim().max(300).optional().or(z.literal("")),
  addressLine2: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(160).optional().or(z.literal("")),
  region: z.string().trim().max(160).optional().or(z.literal("")),
  district: z.string().trim().max(160).optional().or(z.literal("")),
  locality: z.string().trim().max(160).optional().or(z.literal("")),
  country: z.string().trim().min(2).max(120),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  coordinateSource: z.enum(["unknown","facility-supplied","authorized-correction","third-party-derived","map-pin"]).default("unknown"),
  locationStatus: z.enum(["unconfirmed","confirmed","disputed"]).default("unconfirmed"),
  publicPhone: z.string().trim().max(60).optional().or(z.literal("")),
  publicEmail: z.string().email().max(320).optional().or(z.literal("")),
  website: z.string().url().max(2000).optional().or(z.literal("")),
  openingHours: z.record(z.string(), z.string()).default({}),
  openingExceptions: z.array(z.object({ date: z.string().date(), note: z.string().trim().max(500) })).max(100).default([]),
  accessibility: z.record(z.string(), z.union([z.boolean(), z.string().max(500)])).default({}),
  status: z.enum(["active","closed","relocated"]).default("active"),
});

export const directoryFacilityCreateSchema = z.object({
  name: z.string().trim().min(2).max(300),
  slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9][a-z0-9-]+$/).optional(),
  facilityType: facilityTypeSchema,
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  country: z.string().trim().min(2).max(120),
  region: z.string().trim().max(160).optional().or(z.literal("")),
  district: z.string().trim().max(160).optional().or(z.literal("")),
  locality: z.string().trim().max(160).optional().or(z.literal("")),
  publicPhone: z.string().trim().max(60).optional().or(z.literal("")),
  publicEmail: z.string().email().max(320).optional().or(z.literal("")),
  website: z.string().url().max(2000).optional().or(z.literal("")),
  medverisParticipation: z.enum(["none","direct","connected"]).default("none"),
  sourceKind: z.enum(["authoritative-import","facility-submitted","claim","medveris-registered"]).default("facility-submitted"),
  sourceName: z.string().trim().max(300).optional().or(z.literal("")),
  sourceUrl: z.string().url().max(2000).optional().or(z.literal("")),
  sourceLicense: z.string().trim().max(1000).optional().or(z.literal("")),
  sourceRetrievedOn: z.string().date().optional().nullable(),
  nextConfirmationOn: z.string().date().optional().nullable(),
  branches: z.array(directoryBranchSchema).max(50).default([]),
  services: z.array(z.object({
    code: z.string().trim().min(2).max(80),
    name: z.string().trim().min(2).max(300),
    category: z.enum(["outpatient","inpatient","emergency","maternal","child-health","diagnostics","pharmacy","dental","eye","mental-health","rehabilitation","surgery","other"]),
    description: z.string().trim().max(2000).optional().or(z.literal("")),
    availabilityNote: z.string().trim().max(500).optional().or(z.literal("")),
    publicContact: z.string().trim().max(200).optional().or(z.literal("")),
  })).max(100).default([]),
  capabilities: z.array(z.object({
    code: z.string().trim().min(2).max(80),
    name: z.string().trim().min(2).max(300),
    status: z.enum(["declared","documented","verified","suspended"]).default("declared"),
    evidenceSource: z.string().trim().max(1000).optional().or(z.literal("")),
  })).max(100).default([]),
});

export const directoryFacilityUpdateSchema = z.object({
  name: z.string().trim().min(2).max(300).optional(),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  publicPhone: z.string().trim().max(60).optional().or(z.literal("")),
  publicEmail: z.string().email().max(320).optional().or(z.literal("")),
  website: z.string().url().max(2000).optional().or(z.literal("")),
  version: z.number().int().min(1),
});

export const directoryServiceSchema = z.object({
  code: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(300),
  category: z.enum(["outpatient","inpatient","emergency","maternal","child-health","diagnostics","pharmacy","dental","eye","mental-health","rehabilitation","surgery","other"]),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  availabilityNote: z.string().trim().max(500).optional().or(z.literal("")),
  publicContact: z.string().trim().max(200).optional().or(z.literal("")),
  branchId: uuidSchema.optional().nullable(),
});

export const directoryCapabilitySchema = z.object({
  code: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(300),
  status: z.enum(["declared","documented","verified","suspended"]).default("declared"),
  evidenceSource: z.string().trim().max(1000).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const directoryClaimSchema = z.object({
  representativeName: z.string().trim().min(2).max(200),
  roleTitle: z.string().trim().min(2).max(160),
  email: z.string().email().max(320),
  phone: z.string().trim().max(60).optional().or(z.literal("")),
  authorityBasis: z.string().trim().min(10).max(2000),
  evidence: z.string().trim().max(4000).optional().or(z.literal("")),
});

export const directoryClaimDecisionSchema = z.object({
  decision: z.enum(["verify","reject","withdraw"]),
  reason: z.string().trim().min(5).max(2000),
});

export const directoryModerationSchema = z.object({
  decision: z.enum(["publish","suspend","archive","approve-profile"]),
  note: z.string().trim().min(5).max(2000),
});

export const directoryDuplicateReviewSchema = z.object({
  decision: z.enum(["merge","reject"]),
  note: z.string().trim().min(5).max(2000),
});

export const directoryReportSchema = z.object({
  reportType: z.enum(["abuse","closed","relocated","location","other"]),
  detail: z.string().trim().min(10).max(4000),
  contact: z.string().trim().max(320).optional().or(z.literal("")),
});

export const directoryReportResolutionSchema = z.object({
  decision: z.enum(["resolved","dismissed"]),
  resolution: z.string().trim().min(5).max(2000),
});

export const directoryConfirmationSchema = z.object({
  note: z.string().trim().max(2000).optional().or(z.literal("")),
  nextDueOn: z.string().date().optional().nullable(),
});

export const directoryEditRequestSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const directoryEditDecisionSchema = z.object({
  decision: z.enum(["approve","reject"]),
  reason: z.string().trim().min(5).max(2000),
});

// Sponsored placement and configurable packages.
export const sponsoredPlacementSurfaceSchema = z.enum(["search","featured-card","map","category"]);
export const sponsoredPackageSchema = z.object({
  code: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/),
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  price: z.number().min(0).max(100000000),
  currency: z.string().trim().length(3).regex(/^[A-Z]{3}$/),
  durationDays: z.number().int().min(1).max(366),
  eligibleCountries: z.array(z.string().trim().min(2).max(120)).max(50).default([]),
  eligibleFacilityTypes: z.array(facilityTypeSchema).max(30).default([]),
  eligibleServiceCategories: z.array(z.string().trim().min(2).max(80)).max(50).default([]),
  placementSurface: sponsoredPlacementSurfaceSchema,
  sponsoredSlots: z.number().int().min(1).max(20).default(1),
  maxActivePerFacility: z.number().int().min(1).max(20).default(1),
  requirements: z.string().trim().max(2000).optional().or(z.literal("")),
  cancellationPolicy: z.string().trim().max(2000).optional().or(z.literal("")),
  startsOn: z.string().date().optional().nullable(),
  endsOn: z.string().date().optional().nullable(),
  active: z.boolean().default(true),
});

export const sponsoredCampaignSchema = z.object({
  packageId: uuidSchema,
  facilityId: uuidSchema,
  branchId: uuidSchema.optional().nullable(),
  scopeCountry: z.string().trim().max(120).optional().or(z.literal("")),
  scopeRegion: z.string().trim().max(160).optional().or(z.literal("")),
  scopeDistrict: z.string().trim().max(160).optional().or(z.literal("")),
  scopeLocality: z.string().trim().max(160).optional().or(z.literal("")),
  serviceCategories: z.array(z.string().trim().min(2).max(80)).max(50).default([]),
  startsOn: z.string().date(),
  endsOn: z.string().date(),
});

export const sponsorshipDecisionSchema = z.object({
  decision: z.enum(["approve","reject"]),
  note: z.string().trim().min(5).max(2000),
});

export const promotionPaymentConfirmSchema = z.object({
  providerReference: z.string().trim().min(2).max(300),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const promotionPaymentInitiateSchema = z.object({
  method: z.enum(["manual","bank-transfer","mobile-money","card"]).default("manual"),
  provider: z.string().trim().max(120).optional().or(z.literal("")),
  providerReference: z.string().trim().max(300).optional().or(z.literal("")),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const directoryEventSchema = z.object({
  eventType: z.enum(["impression","detail-open","pin-interaction","contact-click","directions-click","booking-initiation"]),
  facilityPublicId: z.string().trim().min(2).max(80),
  campaignId: uuidSchema.optional().nullable(),
  surface: z.enum(["search","featured-card","map","category","detail"]).default("search"),
});

// Hospital integration clients and API products.
export const apiProductSchema = z.object({
  code: z.string().trim().min(2).max(80).regex(/^[a-z0-9][a-z0-9._-]+$/),
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  serviceFamily: z.string().trim().min(2).max(120),
  dataClassification: z.enum(["none","aggregate","directory","clinical"]),
  requiredScopes: z.array(z.string().trim().min(2).max(160)).max(30).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(10000).default(60),
  dailyQuota: z.number().int().min(1).max(10000000).default(10000),
  supportLevel: z.string().trim().max(120).default("standard"),
  sandboxAvailable: z.boolean().default(true),
  commercialStatus: z.enum(["included","undecided","paid"]).default("undecided"),
  enabled: z.boolean().default(true),
});

export const integrationApplicationSchema = z.object({
  name: z.string().trim().min(2).max(200),
  organization: z.string().trim().min(2).max(300),
  tenantId: uuidSchema.optional().nullable(),
  callbackUrl: z.string().url().max(2000).optional().or(z.literal("")),
  technicalContact: z.string().trim().min(3).max(320),
  privacyContact: z.string().trim().max(320).optional().or(z.literal("")),
  incidentContact: z.string().trim().max(320).optional().or(z.literal("")),
  existingVendor: z.string().trim().max(200).optional().or(z.literal("")),
  intendedUse: z.string().trim().min(10).max(4000),
  patientPopulations: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
  processingLocations: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
  supportedStandards: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
  legalBasis: z.string().trim().max(2000).optional().or(z.literal("")),
  dataSharingNotes: z.string().trim().max(4000).optional().or(z.literal("")),
  products: z.array(z.string().trim().min(2).max(80)).min(1).max(20),
});

export const integrationClientDecisionSchema = z.object({
  decision: z.enum(["activate","reject","suspend","revoke"]),
  reason: z.string().trim().min(5).max(2000),
});

export const integrationTokenSchema = z.object({
  grant_type: z.literal("client_credentials"),
  client_id: z.string().trim().min(4).max(200),
  client_secret: z.string().trim().min(8).max(500),
  scope: z.string().trim().max(2000).optional(),
});

export const partnerPatientMatchSchema = z.object({
  givenName: z.string().trim().min(1).max(160),
  familyName: z.string().trim().min(1).max(160),
  dateOfBirth: z.string().date(),
  sex: z.string().trim().max(30).optional().or(z.literal("")),
  publicId: z.string().trim().max(80).optional().or(z.literal("")),
  externalSystem: z.string().trim().max(120).optional().or(z.literal("")),
  externalIdentifier: z.string().trim().max(200).optional().or(z.literal("")),
});

export const partnerPatientLinkSchema = z.object({
  patientId: uuidSchema,
  externalSystem: z.string().trim().min(2).max(120),
  externalIdentifier: z.string().trim().min(1).max(200),
  sourceVersion: z.string().trim().max(120).optional().or(z.literal("")),
});

export const partnerPatientUnlinkSchema = z.object({
  reason: z.string().trim().min(5).max(2000),
});
