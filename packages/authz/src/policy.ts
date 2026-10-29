// Central authorization service. The trusted actor context is assembled
// server-side from the session, verified membership, live role grants,
// department assignments, engagements and privilege grants. React never
// supplies roles, tenant IDs or privilege flags.
import type { Role } from "./index.js";
import { permissionsForRoles, type Permission } from "./permissions.js";

export const POLICY_VERSION = "medveris-policy-1.0";

export interface PolicyActor {
  userId?: string | null;
  roles: Role[];
  tenantId: string | null;
  patientId: string | null;
  mfaVerified: boolean;
  mfaEnrolled: boolean;
  platformRoles?: string[];
  membershipActive?: boolean;
  engagementActive?: boolean;
  departmentIds?: string[];
  cadreCodes?: string[];
  specialties?: string[];
  privileges?: string[];
  credentialValid?: boolean;
  careTeamPatientIds?: string[];
  proxyScopes?: string[];
  proxyExpiresAt?: Date | null;
  sessionRevokedAt?: Date | null;
}

export type ResourceKind =
  | "patient-record"
  | "patient-profile"
  | "care-team"
  | "clinical-list"
  | "clinical-record"
  | "organization"
  | "role-grant"
  | "credential"
  | "finance"
  | "public-health"
  | "content"
  | "opportunity"
  | "audit"
  | "exchange"
  | "dashboard";

export interface ResourceContext {
  kind: ResourceKind;
  tenantId?: string | null;
  patientId?: string | null;
  relationship?: "self" | "proxy" | "care-team" | "emergency" | null;
  scope?: string | null;
  consentGranted?: boolean;
  legalBasis?: string | null;
  sensitivity?: string[];
  purpose?: string | null;
  ownerUserId?: string | null;
  authorUserId?: string | null;
  departmentId?: string | null;
  requiresCredential?: boolean;
  expiresAt?: Date | null;
  content?: {
    status: "draft" | "in-review" | "published" | "archived" | "withdrawn";
    visibilityScope: "public" | "authenticated" | "patient" | "professional" | "specialty" | "organization" | "department";
    audience: "general" | "patient" | "professional" | "specialty" | "organization" | "department";
    specialtyTags?: string[];
    visibilityValues?: string[];
    tenantId?: string | null;
    correctionStatus?: "none" | "corrected" | "retracted";
    expiresAt?: Date | null;
  };
  opportunity?: {
    moderationState: "draft" | "pending-review" | "published" | "rejected" | "archived" | "withdrawn";
    audience: "patient" | "professional" | "both";
    specialtyTags?: string[];
    tenantId?: string | null;
    closesOn?: string | null;
    verificationStatus?: string;
  };
}

export type PolicyReason =
  | "allowed"
  | "unauthenticated"
  | "mfa-required"
  | "membership-inactive"
  | "engagement-inactive"
  | "tenant-required"
  | "tenant-mismatch"
  | "role-permission-missing"
  | "care-relationship-required"
  | "self-context-required"
  | "proxy-scope-missing"
  | "proxy-expired"
  | "consent-required"
  | "sensitivity-restricted"
  | "credential-invalid"
  | "department-mismatch"
  | "grant-expired"
  | "content-unpublished"
  | "content-audience-denied"
  | "content-specialty-denied"
  | "content-expired"
  | "self-approval-forbidden"
  | "separation-of-duties";

export interface PolicyDecision {
  allowed: boolean;
  reason: PolicyReason;
  permission: Permission;
  policyVersion: string;
}

const staffPermissionPrefixes = [
  "clinical.", "nursing.", "ward.", "medication.", "diagnostic.", "exchange.",
  "organization.", "workforce.", "onboarding.", "role_grant.", "privilege.", "credential.",
  "care_team.", "finance.", "public_health.", "content.", "dashboard.",
  "inventory.", "directory.", "promotion.", "integration.", "audit.", "platform.", "workspace.", "hmis.",
];

function isStaffPermission(permission: Permission): boolean {
  return staffPermissionPrefixes.some((prefix) => permission.startsWith(prefix));
}

function deny(permission: Permission, reason: PolicyReason): PolicyDecision {
  return { allowed: false, reason, permission, policyVersion: POLICY_VERSION };
}

function allow(permission: Permission): PolicyDecision {
  return { allowed: true, reason: "allowed", permission, policyVersion: POLICY_VERSION };
}

/**
 * Evaluate a single action against a trusted actor and a resource context.
 * Contextual checks run even when the role bundle contains the permission.
 */
export function authorize(actor: PolicyActor, action: Permission, resource: ResourceContext): PolicyDecision {
  if (!actor.userId) return deny(action, "unauthenticated");
  if (actor.sessionRevokedAt) return deny(action, "unauthenticated");

  const permissions = permissionsForRoles(actor.roles);
  if (!permissions.has(action)) return deny(action, "role-permission-missing");

  const staff = isStaffPermission(action);

  if (staff) {
    if (!actor.tenantId) return deny(action, "tenant-required");
    if (actor.membershipActive === false) return deny(action, "membership-inactive");
    if (!actor.mfaVerified) return deny(action, "mfa-required");
    if (actor.engagementActive === false) return deny(action, "engagement-inactive");
    if (resource.tenantId && resource.tenantId !== actor.tenantId) return deny(action, "tenant-mismatch");
  }

  if (action === "clinical.record.read_authorized") {
    if (resource.patientId) {
      const relationship = resource.relationship
        ?? (actor.careTeamPatientIds?.includes(resource.patientId) ? "care-team" : null);
      if (relationship !== "care-team" && relationship !== "emergency") {
        return deny(action, "care-relationship-required");
      }
    }
  }

  if (action === "clinical.care_team.manage" || action === "care_team.read") {
    if (resource.departmentId && actor.departmentIds?.length && !actor.departmentIds.includes(resource.departmentId)) {
      return deny(action, "department-mismatch");
    }
  }

  if (action.startsWith("patient.") && action !== "patient.register" && action !== "patient.lookup.exact") {
    if (resource.patientId && actor.patientId !== resource.patientId) {
      const proxyAllowed = resource.relationship === "proxy"
        && (actor.proxyScopes?.includes(action) || actor.proxyScopes?.includes("patient.record.read_released_self"))
        && (!actor.proxyExpiresAt || actor.proxyExpiresAt.getTime() > Date.now());
      if (!proxyAllowed) {
        return deny(action, actor.proxyExpiresAt && actor.proxyExpiresAt.getTime() <= Date.now() ? "proxy-expired" : "self-context-required");
      }
    }
  }

  if (action === "exchange.record.read_granted" || action === "exchange.access.request") {
    if (!resource.consentGranted) return deny(action, "consent-required");
  }

  if (action === "emergency.access.activate") {
    if (!actor.mfaVerified || !actor.mfaEnrolled) return deny(action, "mfa-required");
    if (!resource.consentGranted && resource.legalBasis !== "emergency") return deny(action, "consent-required");
  }

  if (resource.sensitivity?.length && resource.sensitivity.includes("restricted") && actor.privileges?.includes("SENSITIVE-RECORD") !== true) {
    return deny(action, "sensitivity-restricted");
  }

  if (resource.requiresCredential && actor.credentialValid === false) return deny(action, "credential-invalid");

  if (action === "role_grant.approve" || action === "privilege.review" || action === "credential.review") {
    if (resource.ownerUserId && resource.ownerUserId === actor.userId) return deny(action, "self-approval-forbidden");
  }

  if (action === "content.read") {
    const content = resource.content;
    if (content) {
      if (content.status !== "published") return deny(action, "content-unpublished");
      if (staff) {
        if (content.visibilityScope === "patient" || content.visibilityScope === "specialty" && content.audience === "patient") {
          if (!actor.roles.includes("patient")) return deny(action, "content-audience-denied");
        }
        if (content.visibilityScope === "specialty") {
          const tags = content.specialtyTags ?? [];
          const values = content.visibilityValues ?? [];
          const actorTags = new Set([...(actor.specialties ?? []), ...(actor.cadreCodes ?? [])]);
          const permitted = tags.some((tag) => actorTags.has(tag)) || (values.length > 0 && values.some((value) => actorTags.has(value)));
          if (!permitted) return deny(action, "content-specialty-denied");
        }
        if (content.visibilityScope === "organization" || content.visibilityScope === "department") {
          if (content.tenantId && content.tenantId !== actor.tenantId) return deny(action, "content-audience-denied");
        }
        if (content.expiresAt && content.expiresAt.getTime() <= Date.now()) return deny(action, "content-expired");
      }
    }
  }

  if ((action === "content.publish" || action === "content.review") && resource.authorUserId && resource.authorUserId === actor.userId) {
    return deny(action, "separation-of-duties");
  }

  if (action === "content.publish" && resource.expiresAt && resource.expiresAt.getTime() <= Date.now()) {
    return deny(action, "grant-expired");
  }

  if (resource.expiresAt && resource.expiresAt.getTime() <= Date.now()) {
    if (action === "role_grant.approve" || action === "privilege.review") return deny(action, "grant-expired");
  }

  return allow(action);
}

export class PolicyDeniedError extends Error {
  readonly status = 403;
  readonly code = "forbidden";
  readonly decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super(`Action denied (${decision.reason})`);
    this.decision = decision;
  }
}

export function assertAuthorized(actor: PolicyActor, action: Permission, resource: ResourceContext): void {
  const decision = authorize(actor, action, resource);
  if (!decision.allowed) throw new PolicyDeniedError(decision);
}
