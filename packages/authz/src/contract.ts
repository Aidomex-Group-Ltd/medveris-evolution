import { PERMISSIONS, type Permission } from "./permissions.js";
import type { Role } from "./index.js";

/**
 * Canonical authorization contract (Phase 1A, additive; remediated in remediation increment 1).
 *
 * Contract boundary (must remain explicit in enforcement and documentation):
 * 1. Authentication: who is making the request (session/service identity/webhook verification).
 * 2. Permission: is the authenticated actor allowed to attempt the action category.
 * 3. Contextual policy: is the action allowed for this tenant, organization, membership,
 *    resource ownership/state, and server-resolved scope.
 * 4. Domain invariant: does the operation satisfy clinical/finance/workflow/business rules.
 * 5. RLS: database-level isolation/authorization backstop; never replaced by app checks.
 *
 * A permission check alone never replaces contextual policy, domain validation, or RLS.
 * This module does not introduce an action registry beyond the canonical permission catalog
 * because current enforcement composes permissions with route/service contextual policy and
 * resource-specific assertions; adding a parallel registry in this increment would duplicate
 * semantics without evidence-backed route bindings.
 */

export const AUTHZ_CONTRACT_VERSION = "2026-11-10.phase1a.remediation-1";

export type ResourceDomain =
  | "identity"
  | "organization"
  | "tenant"
  | "membership"
  | "patient"
  | "clinical"
  | "pharmacy"
  | "diagnostics"
  | "radiology"
  | "finance"
  | "billing"
  | "inventory"
  | "workforce"
  | "content"
  | "directory"
  | "integration"
  | "platform"
  | "audit"
  | "operations";

export type ActionVerb = "create" | "read" | "update" | "delete" | "execute" | "approve" | "manage" | "export";

/**
 * Typed action descriptor for future evidence-backed registries. Not a runtime enforcement
 * registry in this increment; only fields justifiable from existing policy/permission semantics.
 */
export interface ActionDefinition {
  permission: Permission;
  domain: ResourceDomain;
  resource: string;
  verb: ActionVerb;
  description: string;
  /** Minimum scope expectation for enforcement; RLS remains an independent control. */
  scope: "global" | "platform" | "organization" | "tenant" | "department" | "unit" | "self" | "care-team" | "contextual";
  /** High-risk actions that are candidates for future dual authorization (design only). */
  dualAuthorizationCandidate?: boolean;
}

/**
 * Administrative, clinical, and financial privilege boundaries must remain explicit.
 * A professional cadre/title or organizational job title does not itself grant a
 * security permission unless a verified role/permission mapping does so.
 */
export interface DelegationBoundary {
  domain: ResourceDomain;
  mayDelegate: readonly Permission[];
  mustNotDelegate: readonly Permission[];
  notes: string;
}

export const ADMINISTRATIVE_DELEGATION_BOUNDARIES: readonly DelegationBoundary[] = [
  {
    domain: "membership",
    mayDelegate: ["organization.membership.manage", "workforce.onboard.manage", "role_grant.request"],
    mustNotDelegate: ["platform.operations.manage", "credential.review", "role_grant.approve"],
    notes:
      "Facility/department administration may manage memberships only within authorized tenant/department scope and existing role-grant policies. Ownership and platform privileges are not delegable as generic admin actions.",
  },
  {
    domain: "clinical",
    mayDelegate: ["clinical.care_team.manage", "clinical.worklist.read_assigned"],
    mustNotDelegate: ["clinical.note.sign", "clinical.note.amend", "emergency.access.activate"],
    notes: "Clinical signing and emergency access require explicit privileges/credentials/MFA and are never implied by administrative title.",
  },
  {
    domain: "finance",
    mayDelegate: ["finance.dashboard.read", "finance.payment.record"],
    mustNotDelegate: ["platform.operations.manage"],
    notes:
      "Financial operations require finance/admin authorization and separation-of-duties controls for high-risk mutations; titles/cadres do not grant finance privileges.",
  },
];

export interface LegacyRoleCheckMapping {
  legacy: string;
  /** Canonical permissions that are evidence-supported equivalents. Empty when no single permission preserves semantics. */
  canonicalPermissions: readonly Permission[];
  /** True when legacy check implies authority not safely representable as the listed permissions alone. */
  unresolved?: boolean;
  notes: string;
}

/**
 * Compatibility mapping from common legacy checks to canonical permissions.
 * Intentionally non-exhaustive; extend only with evidence from existing behavior.
 * Do not treat this mapping as a replacement for contextual policy or domain invariants.
 */
export const LEGACY_CHECK_MAPPINGS: readonly LegacyRoleCheckMapping[] = [
  {
    legacy: "canManageTenant/facility_admin",
    canonicalPermissions: ["organization.membership.manage", "organization.structure.manage"],
    notes:
      "Administrative management scope; facility_admin holds additional permissions by role bundle, but clinical/finance/platform actions still require specific permissions and contextual checks.",
  },
  {
    legacy: "assertPriceListManager",
    canonicalPermissions: [],
    unresolved: true,
    notes:
      "Legacy price-list/catalog mutation guard is role-based (finance/facility_admin) and is not equivalent to finance.dashboard.read or finance.payment.record. No dedicated catalog/price permission exists in the current catalog; endpoint hardening must preserve role+tenant checks until an owner-approved permission is introduced.",
  },
  {
    legacy: "canTakePayments/assertCashier",
    canonicalPermissions: ["finance.payment.record"],
    notes:
      "Evidence-supported for payment collection/recording checks; refunds/reversals/voids/waivers remain high-risk and require additional contextual and separation-of-duties controls.",
  },
  {
    legacy: "assertDiagnostics/canManageDiagnostics",
    canonicalPermissions: ["diagnostic.report.create", "diagnostic.result.validate", "clinical.worklist.read_assigned"],
    notes:
      "Bundle-style legacy guard covers multiple diagnostic actions; actual endpoint must enforce the specific action permission and modality/sign/validate context.",
  },
  {
    legacy: "canSignClinical/assertSign",
    canonicalPermissions: ["clinical.note.sign"],
    notes:
      "Requires clinician privilege/credential/MFA and policy context (tenant, engagement, clinical sign privilege) per existing enforcement; not a permission-only grant.",
  },
  {
    legacy: "platform_operator",
    canonicalPermissions: ["platform.operations.manage"],
    notes:
      "Platform role eligibility signal. Not a complete privileged execution context: actor resolution, MFA/step-up, action-specific checks, audit attribution, and resource scope remain required where applicable.",
  },
  {
    legacy: "content_editor/reviewer checks",
    canonicalPermissions: ["content.draft", "content.review", "content.publish", "content.archive"],
    notes:
      "Exact permission depends on lifecycle action; publish/review remain subject to separation-of-duties and content-state policy.",
  },
];

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

/** Runtime guard: true only for canonical permission identifiers in the authoritative registry. */
export function isKnownPermission(value: string): value is Permission {
  return typeof value === "string" && KNOWN_PERMISSIONS.has(value);
}

/**
 * Compatibility hook retained for additive API stability.
 * No role normalization is currently required or evidence-supported; this intentionally
 * preserves role identity. Remove only after confirming no external/internal callers rely on it.
 */
export function normalizeRolesForCompatibility(roles: readonly Role[]): readonly Role[] {
  return [...roles];
}
