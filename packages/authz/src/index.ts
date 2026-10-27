export const ROLES = [
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
  "radiographer",
  "radiologist",
  "lab_validator",
  "ward_manager",
  "privacy_officer",
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
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Specialised roles inherit the working access of the department role they belong to, so existing
 * route checks and database policies apply to them. Implication never confers signing: radiology
 * sign-off is the `radiology.report.sign` permission, which only `radiologist` holds.
 */
export const IMPLIED_ROLES: Readonly<Partial<Record<Role, readonly Role[]>>> = Object.freeze({
  radiographer: ["radiology"],
  radiologist: ["radiology"],
  lab_validator: ["laboratory"],
  ward_manager: ["nurse"],
});

export function withImpliedRoles(roles: readonly Role[]): Role[] {
  const out = new Set<Role>(roles);
  for (const role of roles) for (const implied of IMPLIED_ROLES[role] ?? []) out.add(implied);
  return [...out];
}

export interface ActorContext {
  userId: string;
  roles: Role[];
  tenantId: string | null;
  patientId: string | null;
  mfaVerified: boolean;
  mfaEnrolled: boolean;
  platformRoles?: string[];
}

const clinicalRoles: Role[] = ["clinician", "nurse"];
const signRoles: Role[] = ["clinician"];
const adminRoles: Role[] = ["facility_admin"];
const wardRoles: Role[] = ["clinician", "nurse", "ward_manager"];
const diagnosticsRoles: Role[] = ["clinician", "nurse", "laboratory", "lab_validator", "radiology", "radiographer", "radiologist"];
const financeRoles: Role[] = ["finance", "facility_admin"];
const programmeRoles: Role[] = ["clinician", "nurse"];
const workforceRoles: Role[] = ["hr", "facility_admin"];
const clinicalReviewRoles: Role[] = ["clinician", "facility_admin"];
const recordsRoles: Role[] = ["records", "receptionist", "facility_admin"];
const housekeepingRoles: Role[] = ["housekeeping", "facility_admin"];
const porterRoles: Role[] = ["porter", "nurse", "facility_admin"];
const mortuaryRoles: Role[] = ["mortuary", "facility_admin"];
const technicalRoles: Role[] = ["cssd", "biomedical", "facility_admin"];

export function hasRole(actor: ActorContext, ...roles: Role[]): boolean {
  return roles.some((r) => actor.roles.includes(r));
}

export function canReadClinical(actor: ActorContext): boolean {
  return hasRole(actor, ...clinicalRoles);
}

export function canWriteClinical(actor: ActorContext): boolean {
  return hasRole(actor, ...clinicalRoles);
}

export function canSignClinical(actor: ActorContext): boolean {
  return hasRole(actor, ...signRoles);
}

export function canManageTenant(actor: ActorContext): boolean {
  return hasRole(actor, ...adminRoles);
}

export function canReviewCredentials(actor: ActorContext): boolean {
  return actor.platformRoles?.includes("credential_reviewer") || hasRole(actor, "credential_reviewer");
}

export function canAudit(actor: ActorContext): boolean {
  return hasRole(actor, "auditor", "facility_admin");
}

export function canManageWardCare(actor: ActorContext): boolean {
  return hasRole(actor, ...wardRoles);
}

export function canManageEmergencyCare(actor: ActorContext): boolean {
  return hasRole(actor, ...wardRoles);
}

export function canViewWardOperations(actor: ActorContext): boolean {
  return hasRole(actor, "clinician", "nurse", "facility_admin");
}

export function canManageDiagnostics(actor: ActorContext): boolean {
  return hasRole(actor, ...diagnosticsRoles);
}

export function canDispenseMedication(actor: ActorContext): boolean {
  return hasRole(actor, "pharmacist");
}

export function canAdministerMedication(actor: ActorContext): boolean {
  return hasRole(actor, "nurse", "clinician");
}

export function canManageFinance(actor: ActorContext): boolean {
  return hasRole(actor, ...financeRoles);
}

export function canManageProgrammes(actor: ActorContext): boolean {
  return hasRole(actor, ...programmeRoles);
}

export function canManagePublicHealth(actor: ActorContext): boolean {
  return hasRole(actor, "public_health", "facility_admin");
}

export function canManageWorkforce(actor: ActorContext): boolean {
  return hasRole(actor, ...workforceRoles);
}

export function canReviewPrivileges(actor: ActorContext): boolean {
  return hasRole(actor, ...clinicalReviewRoles);
}

export function canManageRecords(actor: ActorContext): boolean {
  return hasRole(actor, ...recordsRoles);
}

export function canManageHousekeeping(actor: ActorContext): boolean {
  return hasRole(actor, ...housekeepingRoles);
}

export function canManagePorters(actor: ActorContext): boolean {
  return hasRole(actor, ...porterRoles);
}

export function canManageMortuary(actor: ActorContext): boolean {
  return hasRole(actor, ...mortuaryRoles);
}

export function canManageTechnicalServices(actor: ActorContext): boolean {
  return hasRole(actor, ...technicalRoles);
}

export function canViewOperationalReports(actor: ActorContext): boolean {
  return hasRole(actor, "facility_admin", "finance", "quality", "auditor", "hr", "public_health");
}

export function canUseEmergencyOverride(actor: ActorContext): boolean {
  return hasRole(actor, "clinician", "nurse") && actor.mfaVerified && actor.mfaEnrolled;
}

export function assertClinicalRead(actor: ActorContext): void {
  if (!canReadClinical(actor)) throw new AuthzError("Clinical access is not permitted for this role");
}

export function assertClinicalWrite(actor: ActorContext): void {
  if (!canWriteClinical(actor)) throw new AuthzError("Clinical writing is not permitted for this role");
}

export function assertSign(actor: ActorContext): void {
  if (!canSignClinical(actor)) throw new AuthzError("Only clinicians may sign clinical notes");
}

export function assertMembershipAdmin(actor: ActorContext): void {
  if (!canManageTenant(actor)) throw new AuthzError("Facility administrator permission is required");
}

export function assertCredentialReviewer(actor: ActorContext): void {
  if (!canReviewCredentials(actor)) throw new AuthzError("Independent credential reviewer permission is required");
}

export function assertWardAccess(actor: ActorContext): void {
  if (!canManageWardCare(actor)) throw new AuthzError("Ward access is not permitted for this role");
}

export function assertEmergencyAccess(actor: ActorContext): void {
  if (!canManageEmergencyCare(actor)) throw new AuthzError("Emergency care access requires a clinical or nursing role");
}

export function assertWardView(actor: ActorContext): void {
  if (!canViewWardOperations(actor)) throw new AuthzError("Ward access is not permitted for this role");
}

export function assertDiagnostics(actor: ActorContext): void {
  if (!canManageDiagnostics(actor)) throw new AuthzError("Diagnostics access is not permitted for this role");
}

export function assertFinance(actor: ActorContext): void {
  if (!canManageFinance(actor)) throw new AuthzError("Finance access is not permitted for this role");
}

export function assertProgrammeAccess(actor: ActorContext): void {
  if (!canManageProgrammes(actor)) throw new AuthzError("Programme access is not permitted for this role");
}

export function assertPublicHealth(actor: ActorContext): void {
  if (!canManagePublicHealth(actor)) throw new AuthzError("Public-health reporting access is not permitted for this role");
}

export function assertWorkforceAccess(actor: ActorContext): void {
  if (!canManageWorkforce(actor)) throw new AuthzError("Workforce management permission is required");
}

export function assertPrivilegeReview(actor: ActorContext): void {
  if (!canReviewPrivileges(actor)) throw new AuthzError("Clinical privilege review permission is required");
}

export function assertRecordsAccess(actor: ActorContext): void {
  if (!canManageRecords(actor) && !canReadClinical(actor)) throw new AuthzError("Health-records access is not permitted for this role");
}

export function assertHousekeepingAccess(actor: ActorContext): void {
  if (!canManageHousekeeping(actor)) throw new AuthzError("Housekeeping permission is required");
}

export function assertPorterAccess(actor: ActorContext): void {
  if (!canManagePorters(actor)) throw new AuthzError("Portering permission is required");
}

export function assertMortuaryAccess(actor: ActorContext): void {
  if (!canManageMortuary(actor)) throw new AuthzError("Mortuary permission is required");
}

export function assertTechnicalServices(actor: ActorContext): void {
  if (!canManageTechnicalServices(actor)) throw new AuthzError("Technical-services permission is required");
}

export function assertOperationalReports(actor: ActorContext): void {
  if (!canViewOperationalReports(actor)) throw new AuthzError("Operational reporting access is not permitted for this role");
}

export function assertAuditAccess(actor: ActorContext): void {
  if (!canAudit(actor)) throw new AuthzError("Audit access is restricted");
}

export function canReceiveExchange(actor: ActorContext, recipientTenantId: string): boolean {
  return canReadClinical(actor) && actor.tenantId === recipientTenantId && actor.mfaVerified;
}

export class AuthzError extends Error {
  readonly status = 403;
  readonly code = "forbidden";
}

export * from "./permissions.js";
export { authorize, assertAuthorized, POLICY_VERSION, PolicyDeniedError } from "./policy.js";
export type {
  PolicyActor,
  ResourceContext,
  ResourceKind,
  PolicyDecision,
  PolicyReason,
} from "./policy.js";
