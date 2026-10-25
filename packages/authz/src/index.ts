export const ROLES = [
  "patient",
  "receptionist",
  "nurse",
  "clinician",
  "facility_admin",
  "finance",
  "auditor",
  "credential_reviewer",
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
