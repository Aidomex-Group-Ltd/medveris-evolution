/**
 * Shared decision contract for matrix actions.
 *
 * This composes, and never replaces, the existing policy engine:
 * role/permission and contextual policy run first, then matrix
 * scope and requirement checks. A null permission (unresolved action)
 * always denies.
 *
 * Import from `packages/authz/src/matrix/decision` or the compat facade
 * at `packages/authz/src/matrix.ts` — do not use both simultaneously.
 */
import { authorize } from "../../policy.js";
import type { PolicyActor, PolicyReason, ResourceContext } from "../../policy.js";
import type { Permission } from "../../permissions.js";
import { AUTHORIZATION_MATRIX_VERSION } from "../version/index.js";
import { MATRIX_BY_KEY } from "../lookup/index.js";
import type { AuthorizationScope, MatrixEntry } from "../types/index.js";

export interface MatrixDecision {
  allowed: boolean;
  reason: PolicyReason;
  actionKey: string;
  permission: Permission | null;
  scope: AuthorizationScope;
  matrixVersion: string;
  policyVersion: string;
}

const SCOPED_ROLE_NAMES: ReadonlySet<string> = new Set(["department_admin", "unit_lead"]);

function isScopedActor(actor: PolicyActor): boolean {
  return actor.roles.some((role) => SCOPED_ROLE_NAMES.has(role));
}

function decideScope(
  actor: PolicyActor,
  entry: MatrixEntry,
  resource: ResourceContext,
): PolicyReason | null {
  if (entry.requirements.includes("platform-role") || entry.scope === "platform") {
    if (!actor.platformRoles?.includes("platform_operator")) return "platform-role-required";
  }

  if (entry.scope === "organization") {
    const organizationId = resource.organizationId;
    if (organizationId) {
      if (!actor.organizationIds?.includes(organizationId)) return "organization-mismatch";
    } else if (!actor.organizationIds?.length) {
      return "organization-mismatch";
    }
  }

  if (entry.scope === "department") {
    if (resource.departmentId && isScopedActor(actor)) {
      if (!actor.departmentIds?.includes(resource.departmentId)) return "department-mismatch";
    }
  }

  if (entry.scope === "unit") {
    if (resource.unitId && isScopedActor(actor)) {
      if (!actor.unitId || actor.unitId !== resource.unitId) return "unit-mismatch";
    }
  }

  if (entry.scope === "self") {
    if (resource.ownerUserId && resource.ownerUserId !== actor.userId) return "self-context-required";
    if (resource.patientId && actor.patientId !== resource.patientId) return "self-context-required";
  }

  if (entry.scope === "care-team" && resource.patientId) {
    const relationship = resource.relationship
      ?? (actor.careTeamPatientIds?.includes(resource.patientId) ? "care-team" : null);
    if (relationship !== "care-team" && relationship !== "emergency") {
      return "care-relationship-required";
    }
  }

  return null;
}

function decideRequirements(
  actor: PolicyActor,
  entry: MatrixEntry,
  resource: ResourceContext,
): PolicyReason | null {
  const requires = new Set(entry.requirements);

  if (requires.has("tenant")) {
    if (!actor.tenantId) return "tenant-required";
    if (resource.tenantId && resource.tenantId !== actor.tenantId) return "tenant-mismatch";
  }
  if (requires.has("membership") && actor.membershipActive === false) return "membership-inactive";
  if (requires.has("mfa") && (!actor.mfaVerified || !actor.mfaEnrolled)) return "mfa-required";
  if (requires.has("engagement") && actor.engagementActive === false) return "engagement-inactive";
  if (requires.has("credential") && actor.credentialValid === false) return "credential-invalid";
  if (requires.has("privilege") && !(actor.privileges?.length)) return "credential-invalid";
  if (requires.has("consent")) {
    const emergency = resource.legalBasis === "emergency";
    if (!resource.consentGranted && !emergency) return "consent-required";
  }
  if (requires.has("separation-of-duties")) {
    if (resource.ownerUserId && resource.ownerUserId === actor.userId) return "self-approval-forbidden";
    if (resource.authorUserId && resource.authorUserId === actor.userId) return "separation-of-duties";
  }
  if (requires.has("organization-membership") && resource.organizationId) {
    if (!actor.organizationIds?.includes(resource.organizationId)) return "organization-mismatch";
  }
  if (requires.has("resource-ownership") && resource.ownerUserId && resource.ownerUserId !== actor.userId) {
    return "self-context-required";
  }

  return null;
}

/**
 * Shared decision contract for matrix actions. This composes, and never replaces, the
 * existing policy engine: role/permission and contextual policy run first, then matrix
 * scope and requirement checks. A null permission (unresolved action) always denies.
 */
export function decideAction(
  actor: PolicyActor,
  actionKeyOrEntry: string | MatrixEntry,
  resource: ResourceContext,
): MatrixDecision {
  const entry = typeof actionKeyOrEntry === "string" ? MATRIX_BY_KEY.get(actionKeyOrEntry) : actionKeyOrEntry;

  if (!entry) {
    return {
      allowed: false,
      reason: "unknown-action",
      actionKey: typeof actionKeyOrEntry === "string" ? actionKeyOrEntry : actionKeyOrEntry.key,
      permission: null,
      scope: "contextual",
      matrixVersion: AUTHORIZATION_MATRIX_VERSION,
      policyVersion: "unknown",
    };
  }

  if (!entry.permission) {
    return {
      allowed: false,
      reason: "unresolved-action",
      actionKey: entry.key,
      permission: null,
      scope: entry.scope,
      matrixVersion: AUTHORIZATION_MATRIX_VERSION,
      policyVersion: "unknown",
    };
  }

  const base = authorize(actor, entry.permission, resource);
  if (!base.allowed) {
    return {
      allowed: false,
      reason: base.reason,
      actionKey: entry.key,
      permission: entry.permission,
      scope: entry.scope,
      matrixVersion: AUTHORIZATION_MATRIX_VERSION,
      policyVersion: base.policyVersion,
    };
  }

  const scopeReason = decideScope(actor, entry, resource);
  if (scopeReason) {
    return {
      allowed: false,
      reason: scopeReason,
      actionKey: entry.key,
      permission: entry.permission,
      scope: entry.scope,
      matrixVersion: AUTHORIZATION_MATRIX_VERSION,
      policyVersion: base.policyVersion,
    };
  }

  const requirementReason = decideRequirements(actor, entry, resource);
  if (requirementReason) {
    return {
      allowed: false,
      reason: requirementReason,
      actionKey: entry.key,
      permission: entry.permission,
      scope: entry.scope,
      matrixVersion: AUTHORIZATION_MATRIX_VERSION,
      policyVersion: base.policyVersion,
    };
  }

  return {
    allowed: true,
    reason: "allowed",
    actionKey: entry.key,
    permission: entry.permission,
    scope: entry.scope,
    matrixVersion: AUTHORIZATION_MATRIX_VERSION,
    policyVersion: base.policyVersion,
  };
}

export class MatrixDeniedError extends Error {
  readonly status = 403;
  readonly code = "forbidden";
  readonly decision: MatrixDecision;
  constructor(decision: MatrixDecision) {
    super(`Action denied (${decision.reason})`);
    this.decision = decision;
  }
}

export function assertMatrixAuthorized(
  actor: PolicyActor,
  actionKeyOrEntry: string | MatrixEntry,
  resource: ResourceContext,
): MatrixDecision {
  const decision = decideAction(actor, actionKeyOrEntry, resource);
  if (!decision.allowed) throw new MatrixDeniedError(decision);
  return decision;
}
