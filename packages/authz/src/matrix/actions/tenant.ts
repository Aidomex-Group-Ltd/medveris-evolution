import type { MatrixEntry } from "../types/index.js";

/**
 * tenant domain protected actions.
 */
export const TENANT_ACTIONS: readonly MatrixEntry[] = [
  {
    key: "workspace.profile.manage",
    domain: "tenant",
    resource: "workspace-profile",
    verb: "manage",
    description: "Update workspace profile and enabled modules.",
    scope: "tenant",
    permission: "workspace.profile.manage",
    routeFile: "workspace.ts",
    routePatterns: ["PUT /workspace/profile", "PUT /workspace/modules"],
    enforcement: "session-permission",
    tenantBound: true,
    rls: true,
    requirements: ["tenant", "membership", "mfa"],
    status: "canonical",
  },
  {
    key: "facility.logo.manage",
    domain: "tenant",
    resource: "facility-logo",
    verb: "manage",
    description: "Upload or remove the facility logo.",
    scope: "tenant",
    permission: "workspace.profile.manage",
    routeFile: "facility-logo.ts",
    routePatterns: ["POST /logo", "DELETE /logo"],
    enforcement: "role-predicate",
    tenantBound: true,
    rls: true,
    requirements: ["tenant", "membership", "mfa"],
    status: "legacy",
    notes: "Route currently requires staff; workspace-profile permission is the intended canonical boundary and needs confirmation.",
  },
];
