import type { Context } from "hono";
import type { Tx } from "@medveris/db";
import type { AppEnv } from "../types.js";
import { ForbiddenError, ValidationError } from "./errors.js";

/** Roles that act across the whole workspace regardless of any membership scope. */
const WORKSPACE_WIDE_ROLES = new Set(["facility_admin", "owner", "hr", "auditor", "quality", "finance", "it_admin"]);

export type ActorScope =
  | { kind: "workspace" }
  | { kind: "department"; departmentId: string }
  | { kind: "unit"; departmentId: string; unitId: string };

/**
 * The part of the workspace a department administrator or unit lead may act on. Everyone else keeps the
 * workspace-wide behaviour their roles already have.
 */
export async function actorScope(tx: Tx, c: Context<AppEnv>): Promise<ActorScope> {
  const active = c.get("auth")?.activeTenant;
  if (!active) throw new ForbiddenError("An active facility context is required");
  const roles = active.roles as string[];
  if (roles.some((role) => WORKSPACE_WIDE_ROLES.has(role))) return { kind: "workspace" };
  const scoped = roles.includes("department_admin") || roles.includes("unit_lead");
  if (!scoped) return { kind: "workspace" };
  const scope = active.scope ?? { departmentId: null, unitId: null };
  if (scope.unitId) {
    const [unit] = await tx`select department_id from units where id = ${scope.unitId} and tenant_id = ${active.id}`;
    if (!unit) throw new ForbiddenError("Your membership scope refers to a unit that no longer exists");
    if (roles.includes("department_admin") && scope.departmentId === unit.departmentId) {
      return { kind: "department", departmentId: String(unit.departmentId) };
    }
    return { kind: "unit", departmentId: String(unit.departmentId), unitId: scope.unitId };
  }
  if (scope.departmentId) return { kind: "department", departmentId: scope.departmentId };
  throw new ForbiddenError("Your role is limited to a department or unit, but no scope is recorded on your membership");
}

/** Refuses an inventory location outside the actor's department or unit. */
export async function assertLocationInScope(tx: Tx, c: Context<AppEnv>, locationId: string): Promise<void> {
  const scope = await actorScope(tx, c);
  if (scope.kind === "workspace") return;
  const tenantId = c.get("auth")!.activeTenant!.id;
  const [location] = await tx`select department_id, unit_id from inventory_locations where id = ${locationId} and tenant_id = ${tenantId}`;
  if (!location) return;
  const inDepartment = location.departmentId === scope.departmentId;
  const inUnit = scope.kind === "unit" ? location.unitId === scope.unitId : true;
  if (!inDepartment || !inUnit) throw new ForbiddenError("This stock location belongs to another department or unit");
}

/** Validates that a department and optional unit belong to the active workspace and fit the actor's scope. */
export async function assertDepartmentInScope(tx: Tx, c: Context<AppEnv>, departmentId: string | null | undefined, unitId: string | null | undefined): Promise<void> {
  const tenantId = c.get("auth")!.activeTenant!.id;
  if (unitId) {
    const [unit] = await tx`select department_id from units where id = ${unitId} and tenant_id = ${tenantId}`;
    if (!unit) throw new ValidationError("The unit does not belong to this workspace");
    if (departmentId && unit.departmentId !== departmentId) throw new ValidationError("The unit does not belong to the selected department");
    departmentId = String(unit.departmentId);
  }
  if (departmentId) {
    const [department] = await tx`select id from departments where id = ${departmentId} and tenant_id = ${tenantId}`;
    if (!department) throw new ValidationError("The department does not belong to this workspace");
  }
  const scope = await actorScope(tx, c);
  if (scope.kind === "workspace") return;
  if (departmentId !== scope.departmentId || (scope.kind === "unit" && unitId !== scope.unitId)) {
    throw new ForbiddenError("You can only record this for your own department or unit");
  }
}

export interface Attribution { departmentId: string | null; unitId: string | null }

/**
 * The department and unit a new transaction belongs to: the requested ones when they fit the actor's scope,
 * otherwise the actor's own department or unit when their role is scoped, otherwise none.
 */
export async function resolveAttribution(tx: Tx, c: Context<AppEnv>, departmentId: string | null | undefined, unitId: string | null | undefined): Promise<Attribution> {
  if (!departmentId && !unitId) {
    const scope = await actorScope(tx, c);
    if (scope.kind === "department") return { departmentId: scope.departmentId, unitId: null };
    if (scope.kind === "unit") return { departmentId: scope.departmentId, unitId: scope.unitId };
    return { departmentId: null, unitId: null };
  }
  await assertDepartmentInScope(tx, c, departmentId, unitId);
  if (unitId && !departmentId) {
    const [unit] = await tx`select department_id from units where id = ${unitId}`;
    return { departmentId: String(unit!.departmentId), unitId };
  }
  return { departmentId: departmentId ?? null, unitId: unitId ?? null };
}
