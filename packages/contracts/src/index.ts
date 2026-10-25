import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(200);
export const publicPatientIdSchema = z
  .string()
  .trim()
  .regex(/^MV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

export const roleSchema = z.enum([
  "receptionist",
  "nurse",
  "clinician",
  "facility_admin",
  "finance",
  "auditor",
  "credential_reviewer",
  "pharmacist",
  "laboratory",
  "radiology",
  "public_health",
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

export const appointmentSchema = z.object({
  patientId: uuidSchema,
  clinicianUserId: uuidSchema.optional().nullable(),
  startAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(480).default(20),
  reason: z.string().trim().min(1).max(1000),
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
  credentialType: z.string().trim().min(1).max(120),
  issuer: z.string().trim().min(1).max(300),
  jurisdiction: z.string().trim().min(1).max(120),
  credentialNumber: z.string().trim().min(1).max(120),
  scope: z.string().trim().max(1000).optional().or(z.literal("")),
  issuedOn: z.string().date(),
  expiresOn: z.string().date(),
  evidenceUploadId: uuidSchema,
});

export const credentialDecisionSchema = z.object({
  decision: z.enum(["verified", "rejected"]),
  reason: z.string().trim().min(10).max(2000),
  checksPerformed: z.string().trim().min(5).max(3000),
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
