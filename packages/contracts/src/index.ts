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
  type: z.enum(["walk-in", "scheduled", "follow-up"]).default("walk-in"),
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
