import type { MatrixEntry } from "../types/index.js";

/**
 * audit domain protected actions.
 */
export const AUDIT_ACTIONS: readonly MatrixEntry[] = [
  {
    key: "reports.run",
    domain: "audit",
    resource: "report",
    verb: "read",
    description: "Run role-scoped operational reports.",
    scope: "tenant",
    permission: "reports.run",
    routeFile: "reports.ts",
    routePatterns: ["GET /reports", "GET /reports/:id"],
    enforcement: "role-predicate",
    tenantBound: true,
    rls: true,
    requirements: ["tenant", "membership", "mfa", "department-scope"],
    status: "canonical",
    notes: "Owner-approved canonical report permission; role-scoped operational reports remain route-gated.",
  },
  {
    key: "audit.read",
    domain: "audit",
    resource: "audit",
    verb: "read",
    description: "Read access-review and audit information.",
    scope: "tenant",
    permission: "audit.read",
    routeFile: "content.ts",
    routePatterns: ["GET /admin/access-review"],
    enforcement: "session-permission",
    tenantBound: true,
    rls: true,
    requirements: ["tenant", "membership", "mfa"],
    status: "canonical",
  },
];
