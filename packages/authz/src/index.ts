export const ROLES = [
  "patient",
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
] as const;

export type Role = (typeof ROLES)[number];

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
const wardRoles: Role[] = ["clinician", "nurse"];
const diagnosticsRoles: Role[] = ["clinician", "nurse", "laboratory", "radiology"];
const financeRoles: Role[] = ["finance", "facility_admin"];
const programmeRoles: Role[] = ["clinician", "nurse"];

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
