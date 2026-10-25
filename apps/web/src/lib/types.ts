export type Role =
  | "patient"
  | "proxy"
  | "receptionist"
  | "nurse"
  | "midwife"
  | "clinician"
  | "specialist_clinician"
  | "diagnostic_practitioner"
  | "department_lead"
  | "facility_admin"
  | "finance"
  | "auditor"
  | "credential_reviewer"
  | "pharmacist"
  | "laboratory"
  | "radiology"
  | "public_health"
  | "hr"
  | "records"
  | "theatre"
  | "housekeeping"
  | "porter"
  | "mortuary"
  | "cssd"
  | "biomedical"
  | "quality"
  | "it_admin"
  | "research"
  | "content_editor"
  | "content_reviewer"
  | "opportunity_moderator";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  givenName: string;
  familyName: string;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
}

export interface Membership {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  roles: Role[];
}

export interface ActiveTenant {
  id: string;
  name: string;
  slug: string;
  roles: Role[];
  membershipId: string;
}

export interface MeResponse {
  user: SessionUser;
  memberships: Membership[];
  activeTenant: ActiveTenant | null;
  patientId: string | null;
  platformRoles: string[];
  csrfToken: string;
}

export interface PublicConfig {
  appEnv: string;
  terminology: { mode: string; synthetic: boolean; label: string };
  features: Record<string, boolean>;
  release: string;
}

export interface PatientSummary {
  id: string;
  publicId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: string;
  identityConfidence?: string;
  linked?: boolean;
  releaseSignedRecords?: boolean;
}

export interface Queue {
  id: string;
  name: string;
  waiting: number;
}

export interface QueueEntryDetail {
  id: string;
  patientId: string;
  publicId: string;
  givenName: string;
  familyName: string;
  priority: string;
  status: string;
  createdAt: string;
  calledAt: string | null;
  encounterId: string | null;
  encounterState: string | null;
}

export interface Appointment {
  id: string;
  startAt: string;
  durationMinutes: number;
  reason: string;
  status: string;
  patientId: string;
  publicId: string;
  givenName: string;
  familyName: string;
  clinicianUserId: string | null;
  clinicianName: string | null;
}

export interface WorklistEncounter {
  id: string;
  state: string;
  type: string;
  reason: string;
  openedAt: string;
  version: number;
  patientId: string;
  publicId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: string;
  draftNotes: number;
  signedNotes: number;
  pendingFollowups: number;
}

export interface Coding {
  system: string;
  version: string;
  code: string;
  display: string;
  text?: string;
}

export interface EncounterDetail {
  encounter: {
    id: string;
    state: string;
    type: string;
    reason: string;
    openedAt: string;
    closedAt: string | null;
    version: number;
    patientId: string;
    publicId: string;
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    sex: string;
    identityConfidence: string;
    facilityName: string;
    tenantId: string;
  };
  triage: Array<{ id: string; complaint: string; urgency: string; notes: string | null; createdAt: string }>;
  observations: Array<{ id: string; display: string; loincCode: string; valueNum: number; valueText: string | null; unitCode: string; occurredAt: string; status: string; recordedAt: string }>;
  allergies: Array<{ id: string; state: string; substanceCoding: Coding | null; reactionCoding: Coding | null; severity: string; note: string | null; recordedAt: string }>;
  conditions: Array<{ id: string; display: string; snomedCode: string; clinicalStatus: string; onsetDate: string | null; note: string | null; recordedAt: string }>;
  entries: Array<{
    id: string;
    status: string;
    currentVersion: number;
    title: string;
    authorId: string;
    authorName: string;
    occurredAt: string;
    recordedAt: string;
    signedAt: string | null;
    changeNote: string;
    content: { title?: string; subjective?: string; objective?: string; assessment?: string; plan?: string; enteredInError?: boolean };
  }>;
  followUps: Array<{ id: string; dueDate: string; instructions: string; status: string }>;
  referrals: Array<{ id: string; toFacility: string; reason: string; priority: string; status: string }>;
}

export interface PatientPortalProfile {
  patient: PatientSummary & { email: string | null; phone: string | null; createdAt: string };
  facilityLinks: Array<{ tenantId: string; tenantName: string; releaseSignedRecords: boolean }>;
}

export interface PatientRecords {
  notes: Array<{ id: string; entryId: string; version: number; status: string; title: string; content: { subjective?: string; objective?: string; assessment?: string; plan?: string }; occurredAt: string; recordedAt: string; signedAt: string | null; authorName: string; sourceFacility: string }>;
  observations: Array<{ id: string; display: string; valueNum: number; unitCode: string; occurredAt: string; status: string; sourceFacility: string }>;
  conditions: Array<{ id: string; display: string; clinicalStatus: string; recordedAt: string; sourceFacility: string }>;
  allergies: Array<{ id: string; state: string; substanceCoding: Coding | null; severity: string; recordedAt: string; sourceFacility: string }>;
  followUps: Array<{ id: string; dueDate: string; instructions: string; status: string; sourceFacility: string }>;
}

export interface ConsentRow {
  id: string;
  recipientTenantId: string;
  recipientFacility: string;
  sourceTenantIds: string[];
  sourceFacilities: string[] | null;
  categories: string[];
  purpose: string;
  legalBasis: string;
  startsAt: string;
  expiresAt: string;
  version: number;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
  sensitivityExclusions: string[];
}

export interface AuditEventRow {
  id: string;
  action: string;
  actorKind: string;
  decision: string;
  resourceType: string;
  occurredAt: string;
  summary: string;
}

export interface ExchangeGrant {
  id: string;
  patientId: string;
  publicId: string;
  givenName: string;
  familyName: string;
  categories: string[];
  purpose: string;
  legalBasis: string;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  version: number;
  createdAt: string;
}
