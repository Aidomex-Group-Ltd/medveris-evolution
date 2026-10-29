import type { Role } from "./types";

const WORKSPACE_SCOPE_ROLES: readonly Role[] = ["facility_admin", "auditor", "finance", "quality", "it_admin"];

/** Query suffix for inventory lists: every location for workspace-wide roles, otherwise the caller's own. */
export function inventoryScope(roles: readonly Role[] | undefined): string {
  return roles?.some((role) => WORKSPACE_SCOPE_ROLES.includes(role)) ? "scope=all" : "";
}
