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
  | "radiographer"
  | "radiologist"
  | "lab_validator"
  | "ward_manager"
  | "privacy_officer"
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
  | "opportunity_moderator"
  | "owner"
  | "department_admin"
  | "unit_lead"
  | "staff"
  | "report_viewer";

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

/** What kind of workspace is active, so navigation and the landing dashboard fit the unit. */
export interface WorkspaceSummary {
  workspaceKind: string;
  serviceCategory: string | null;
  /** Empty for workspaces created before module selection: every module is shown. */
  enabledModules: string[];
  /** Set only while an organization link is active. */
  organizationId: string | null;
}

export interface Membership {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  roles: Role[];
  /** Department or unit a scoped role (department_admin, unit_lead) is limited to. */
  scope?: { departmentId: string | null; unitId: string | null } | null;
  workspace?: WorkspaceSummary | null;
}

export interface OrganizationMembership {
  id: string;
  name: string;
  role: "organization_owner" | "organization_admin" | "organization_reporting";
}

export interface ActiveTenant {
  id: string;
  name: string;
  slug: string;
  roles: Role[];
  membershipId: string;
  workspace?: WorkspaceSummary | null;
}

export interface MeResponse {
  user: SessionUser;
  organizations?: OrganizationMembership[];
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
  mergedFrom?: string | null;
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

// ---------------------------------------------------------------- patient workflow and billing

export type WorkflowDepartment = "laboratory" | "imaging" | "theatre" | "pharmacy" | "procedure" | "other";
export type RecommendationStatus = "requested" | "accepted" | "in-progress" | "completed" | "declined" | "cancelled";
export type BillingStatus = "unbilled" | "billed" | "part-paid" | "paid";

export interface Recommendation {
  id: string;
  encounterId: string;
  patientId: string;
  department: WorkflowDepartment;
  departmentId: string | null;
  catalogItemId: string | null;
  itemCode: string | null;
  description: string;
  quantity: number;
  priority: "routine" | "urgent" | "emergency";
  /** Null when the caller's role may not read clinical instructions. */
  instructions: string | null;
  instructionsRestricted: boolean;
  source: "consultation" | "direct-request";
  externalReferrer: string | null;
  status: RecommendationStatus;
  statusNote: string | null;
  billingStatus: BillingStatus;
  version: number;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  updatedAt: string;
  updatedByName: string | null;
  completedAt: string | null;
  completedByName: string | null;
  unitPrice: number | null;
  currency: string | null;
  canProgress: boolean;
  canCancel: boolean;
  canEdit: boolean;
}

export interface SupplyUsage {
  id: string;
  recommendationId: string | null;
  catalogItemId: string;
  name: string;
  code: string;
  itemType: string;
  quantity: number;
  note: string | null;
  billingStatus: BillingStatus;
  recordedAt: string;
  recordedByName: string;
  voidedAt: string | null;
  voidReason: string | null;
  unitPrice: number | null;
  currency: string | null;
}

export interface VisitPatient {
  id: string;
  publicId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: string;
}

export interface VisitWorkflow {
  encounter: { id: string; state: string; type: string; openedAt: string; closedAt: string | null; patient: VisitPatient };
  recommendations: Recommendation[];
  supplies: SupplyUsage[];
  permissions: { recommend: boolean; directRequestDepartments: WorkflowDepartment[]; recordSupplies: boolean; bill: boolean };
}

export interface QueueItem extends Recommendation {
  patient: VisitPatient;
  visit: { id: string; state: string; reason: string | null; openedAt: string };
}

export interface VisitBoardEntry {
  id: string;
  state: string;
  type: string;
  openedAt: string;
  closedAt: string | null;
  patient: VisitPatient;
  requests: { requested: number; active: number; completed: number; closed: number; departments: WorkflowDepartment[] };
  billing: { unbilledRequests: number; unpaidRequests: number; paidRequests: number; unbilledSupplies: number; total: number | null; paid: number | null; balance: number | null };
}

export interface QueueSummary {
  department: WorkflowDepartment;
  canWork: boolean;
  requested: number;
  accepted: number;
  inProgress: number;
  completedToday: number;
  emergency: number;
  urgent: number;
}

export interface CatalogueItem {
  id: string;
  code: string;
  name: string;
  category: string;
  itemType: string;
  price: string | number;
  currency: string;
  active: boolean;
  priceStatus: "test" | "approved";
  approvedAt: string | null;
  deactivatedAt: string | null;
  deactivationReason: string | null;
  departmentId: string | null;
  departmentName: string | null;
  description: string | null;
  unitOfMeasure: string | null;
  version: number;
  updatedAt: string;
  updatedByName: string | null;
}
