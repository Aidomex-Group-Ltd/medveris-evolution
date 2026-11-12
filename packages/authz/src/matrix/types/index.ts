import type { ActionVerb, ResourceDomain } from "../../contract.js";
import type { Permission } from "../../permissions.js";

/**
 * Shared matrix types used across all modularized matrix modules.
 * Import these types rather than duplicating them.
 *
 * Professional cadres/job titles are reference data, not security authority.
 * Membership roles, explicit permissions, clinical privileges, credentials,
 * tenant/organization scope and RLS remain the authorization inputs.
 */

export type AuthorizationScope =
  | "global"
  | "platform"
  | "organization"
  | "tenant"
  | "department"
  | "unit"
  | "self"
  | "care-team"
  | "contextual";

export type MatrixEnforcement =
  | "session-permission"
  | "policy"
  | "role-predicate"
  | "platform-operator"
  | "organization-role"
  | "webhook"
  | "public"
  | "authenticated-self"
  | "system";

export type MatrixRequirement =
  | "tenant"
  | "membership"
  | "mfa"
  | "engagement"
  | "care-relationship"
  | "consent"
  | "credential"
  | "privilege"
  | "department-scope"
  | "unit-scope"
  | "resource-ownership"
  | "separation-of-duties"
  | "signature-verification"
  | "platform-role"
  | "organization-membership";

export type MatrixStatus = "canonical" | "legacy" | "unresolved";

export interface MatrixEntry {
  /** Stable operation key, e.g. `finance.payment.record`. */
  key: string;
  domain: ResourceDomain;
  resource: string;
  verb: ActionVerb;
  description: string;
  scope: AuthorizationScope;
  /** Null only when no canonical permission exists yet; `status` must be `unresolved`. */
  permission: Permission | null;
  routeFile: string;
  routePatterns: readonly string[];
  enforcement: MatrixEnforcement;
  tenantBound: boolean;
  rls: boolean;
  requirements: readonly MatrixRequirement[];
  dualAuthorizationCandidate?: boolean;
  status: MatrixStatus;
  notes?: string;
}

export interface NonPermissionEndpoint {
  routeFile: string;
  routePatterns: readonly string[];
  kind: "public" | "webhook" | "health" | "authenticated-self" | "flow-token";
  controls: readonly string[];
  notes?: string;
}
