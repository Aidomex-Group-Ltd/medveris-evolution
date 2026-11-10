import type { Context } from "hono";
import { permissionsForRoles, type Permission, type PolicyActor, type ResourceContext } from "@medveris/authz";
import { ForbiddenError, UnauthorizedError } from "./errors.js";
import { loadAccessActor, loadStaffAccessActor } from "../services/access.js";
import { requestActor } from "./actor.js";
import type { AppEnv } from "../types.js";

/**
 * Backend authorization helpers (Phase 1A, remediation increment 1).
 *
 * Boundaries:
 * - Authentication: caller identity/session must already be established for session helpers
 *   (`requestActor`/`requireSessionPermission` return/throw 401 semantics when missing).
 * - Permission: role-bundle or policy permission required for an action category.
 * - Contextual policy: tenant/org/membership/resource ownership/state checks; use
 *   `requireAuthorized` or explicit route/service checks as applicable.
 * - Domain invariants and RLS remain independent required controls.
 *
 * These helpers do not claim complete resource authorization unless combined with the
 * required contextual checks for the specific operation.
 */

/**
 * Fast session-role permission check only. Requires an authenticated session context.
 * Does not evaluate tenant/resource ownership, full PolicyActor live state, domain invariants,
 * or RLS; callers must apply those controls where required.
 */
export function requireSessionPermission(c: Context<AppEnv>, permission: Permission, message?: string): void {
  const actor = requestActor(c);
  if (!permissionsForRoles(actor.roles).has(permission)) {
    throw new ForbiddenError(message ?? `Permission ${permission} is required for this operation`);
  }
}

/** Session-role permission predicate only; throws 401 if unauthenticated. Not full authorization. */
export function hasSessionPermission(c: Context<AppEnv>, permission: Permission): boolean {
  return permissionsForRoles(requestActor(c).roles).has(permission);
}

/**
 * Evaluates the policy engine against a live access actor and supplied resource context.
 * Use when contextual policy is expressible in the policy engine; still pair with domain
 * invariants, ownership checks, and RLS as required by the operation.
 */
export async function requireAuthorized(
  c: Context<AppEnv>,
  permission: Permission,
  resource: ResourceContext,
  options: { staff?: boolean } = {},
): Promise<PolicyActor> {
  const access = options.staff ? await loadStaffAccessActor(c) : await loadAccessActor(c);
  const { assertAuthorized } = await import("@medveris/authz");
  assertAuthorized(access.actor, permission, resource);
  return access.actor;
}

/**
 * Platform role-eligibility gate only (session must include platform_operator role).
 * Not a complete privileged execution context: does not by itself provide platform actor DB
 * scoping, MFA/step-up enforcement, action-specific permission checks, or audit attribution.
 * Use `withPlatformActor`/route-specific platform controls as required.
 */
export function requirePlatformOperator(c: Context<AppEnv>): void {
  const auth = c.get("auth");
  if (!auth) throw new UnauthorizedError("Authentication required");
  if (!auth.platformRoles.includes("platform_operator")) {
    throw new ForbiddenError("Platform operator permission is required");
  }
}
