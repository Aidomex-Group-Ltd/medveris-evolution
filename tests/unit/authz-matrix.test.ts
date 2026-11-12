import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_MATRIX,
  AUTHORIZATION_MATRIX_VERSION,
  NON_PERMISSION_ENDPOINTS,
  assertMatrixAuthorized,
  decideAction,
  getMatrixEntry,
  isKnownMatrixAction,
  isKnownMatrixPermission,
  matrixDualAuthorizationCandidates,
  matrixEntriesForDomain,
  matrixEntriesForPermission,
  matrixEntriesForRouteFile,
  matrixUnresolvedActions,
  permissionsForRoles,
  MatrixDeniedError,
  type MatrixEntry,
  type Permission,
  type PolicyActor,
  type ResourceContext,
} from "@medveris/authz";

const actor: PolicyActor = {
  userId: "u1",
  roles: ["clinician"],
  tenantId: "t1",
  patientId: null,
  mfaVerified: true,
  mfaEnrolled: true,
  membershipActive: true,
  engagementActive: true,
  departmentIds: ["d1"],
  organizationIds: ["org1"],
  privileges: ["CLIN-SIGN"],
  credentialValid: true,
  careTeamPatientIds: ["p1"],
};

const record: ResourceContext = {
  kind: "clinical-record",
  tenantId: "t1",
  patientId: "p1",
  relationship: "care-team",
};

describe("authorization matrix integrity", () => {
  it("uses unique, stable action keys", () => {
    const keys = AUTHORIZATION_MATRIX.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only references canonical permissions, and unresolved actions have none", () => {
    for (const entry of AUTHORIZATION_MATRIX) {
      if (entry.status === "unresolved") {
        expect(entry.permission, entry.key).toBeNull();
        continue;
      }
      expect(entry.permission, entry.key).not.toBeNull();
      expect(isKnownMatrixPermission(entry.permission as string), entry.key).toBe(true);
    }
  });

  it("binds every action to at least one HTTP route", () => {
    for (const entry of AUTHORIZATION_MATRIX) {
      expect(entry.routePatterns.length, entry.key).toBeGreaterThan(0);
      for (const pattern of entry.routePatterns) {
        expect(pattern, entry.key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
      }
    }
  });

  it("lists intentionally non-permission endpoints with controls", () => {
    for (const endpoint of NON_PERMISSION_ENDPOINTS) {
      expect(endpoint.routePatterns.length).toBeGreaterThan(0);
      expect(endpoint.controls.length).toBeGreaterThan(0);
    }
  });

  it("exposes high-risk dual-authorization candidates as design-only entries", () => {
    const candidates = matrixDualAuthorizationCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["clinical.note.sign", "finance.payment.reverse", "patient.merge.approve"]),
    );
  });

  it("supports lookup helpers by key, domain, route file and permission", () => {
    const entry = getMatrixEntry("clinical.record.read_authorized");
    expect(entry?.permission).toBe("clinical.record.read_authorized");
    expect(isKnownMatrixAction("clinical.record.read_authorized")).toBe(true);
    expect(isKnownMatrixAction("does.not.exist")).toBe(false);
    expect(matrixEntriesForDomain("clinical").length).toBeGreaterThan(0);
    expect(matrixEntriesForRouteFile("clinical.ts").length).toBeGreaterThan(0);
    expect(matrixEntriesForPermission("clinical.note.sign").length).toBeGreaterThan(0);
    expect(matrixUnresolvedActions().every((item) => item.permission === null)).toBe(true);
  });

  it("versions the matrix independently of the policy engine", () => {
    expect(AUTHORIZATION_MATRIX_VERSION).toBe("2026-11-12.phase0-1.foundation");
  });
});

describe("matrix decision contract", () => {
  it("allows a canonical care-team action under matching context", () => {
    const decision = decideAction(actor, "clinical.record.read_authorized", record);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowed");
    expect(decision.permission).toBe("clinical.record.read_authorized");
  });

  it("composes the policy engine before matrix checks", () => {
    const decision = decideAction(actor, "clinical.record.read_authorized", { ...record, tenantId: "t2" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("tenant-mismatch");
  });

it("denies actions when the actor lacks the permission", () => {
  const decision = decideAction(actor, "patient.merge.approve", {
    kind: "patient-record",
    tenantId: "t1",
  });
  expect(decision.allowed).toBe(false);
  expect(decision.reason).toBe("role-permission-missing");
  expect(decision.permission).toBe("patient.merge.approve");
});

it("denies unresolved actions even when the actor is privileged", () => {
  const decision = decideAction(actor, "patient.merge.request", {
    kind: "patient-record",
  });
  expect(decision.allowed).toBe(false);
  expect(decision.reason).toBe("unresolved-action");
  expect(decision.permission).toBeNull();
});

  it("denies unknown action keys", () => {
    const decision = decideAction(actor, "does.not.exist", record);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown-action");
  });

  it("requires a platform role for platform-scoped actions", () => {
    const operator: PolicyActor = { ...actor, roles: ["it_admin"] };
    const withoutGrant = decideAction(operator, "platform.operations.manage", { kind: "dashboard" });
    expect(withoutGrant.allowed).toBe(false);
    expect(withoutGrant.reason).toBe("platform-role-required");

    const withGrant = decideAction(
      { ...operator, platformRoles: ["platform_operator"] },
      "platform.operations.manage",
      { kind: "dashboard" },
    );
    expect(withGrant.allowed).toBe(true);
  });

  it("enforces organization scope", () => {
    const admin: PolicyActor = { ...actor, roles: ["facility_admin"] };
    const decision = decideAction(admin, "organization.manage", {
      kind: "organization",
      organizationId: "org2",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("organization-mismatch");
  });

  it("enforces self-scope and separation of duties", () => {
    const selfDecision = decideAction({ ...actor, roles: ["patient"] }, "patient.profile.read_self", {
      kind: "patient-profile",
      ownerUserId: "u2",
    });
    expect(selfDecision.allowed).toBe(false);
    expect(selfDecision.reason).toBe("self-context-required");

    const admin: PolicyActor = { ...actor, roles: ["facility_admin"] };
    const sodDecision = decideAction(admin, "role_grant.approve", {
      kind: "role-grant",
      tenantId: "t1",
      ownerUserId: "u1",
    });
    expect(sodDecision.allowed).toBe(false);
    expect(sodDecision.reason).toBe("self-approval-forbidden");
  });

  it("throws a structured denial for assertMatrixAuthorized", () => {
    expect(() => assertMatrixAuthorized(actor, "patient.merge.request", { kind: "patient-record" })).toThrow(
      MatrixDeniedError,
    );
    expect(() => assertMatrixAuthorized(actor, "clinical.record.read_authorized", record)).not.toThrow();
  });

  it("accepts a resolved MatrixEntry directly", () => {
    const entry = getMatrixEntry("clinical.record.read_authorized") as MatrixEntry;
    expect(decideAction(actor, entry, record).allowed).toBe(true);
  });
});

describe("approved gap-mapping reuse slice (2026-11-12)", () => {
  const expectations: readonly [string, string, readonly string[]][] = [
    ["inventory.asset.read", "inventory.asset.read", ["GET /inventory/assets", "GET /inventory/assets/:id"]],
    ["inventory.asset.manage", "inventory.asset.manage", ["POST /inventory/assets", "POST /inventory/assets/:id/events"]],
    ["inventory.count.manage", "inventory.count.manage", ["POST /inventory/counts"]],
    [
      "inventory.report.read",
      "inventory.report.read",
      [
        "GET /inventory/reports/asset-downtime",
        "GET /inventory/reports/consumption",
        "GET /inventory/reports/count-variance",
        "GET /inventory/reports/expiry",
        "GET /inventory/reports/low-stock",
        "GET /inventory/reports/maintenance-due",
        "GET /inventory/reports/recall-status",
        "GET /inventory/reports/requisition-fulfilment",
        "GET /inventory/reports/transfer-discrepancies",
        "GET /inventory/reports/valuation",
      ],
    ],
    [
      "radiology.images.view",
      "radiology.images.view",
      [
        "GET /radiology/images/status",
        "GET /radiology/studies/:id/images/series/:seriesUid",
        "GET /radiology/studies/:id/images/series/:seriesUid/instances/:instanceUid/frames/:frame",
      ],
    ],
    ["radiology.report.draft", "radiology.report.draft", ["POST /radiology/reports/:id/critical-communications"]],
    [
      "radiology.study.register",
      "radiology.study.register",
      ["POST /radiology/studies/:id/pacs-link", "POST /radiology/studies/:id/pacs-unlink"],
    ],
    [
      "organization.link.lifecycle",
      "organization.link.manage",
      ["POST /organizations/:id/links/:linkId/end", "POST /organizations/:id/links/:linkId/inventory-mode"],
    ],
    ["onboarding.catalogue.read", "onboarding.catalogue.read", ["GET /onboarding/catalogue/versions"]],
  ];

  it("binds each approved reuse route to its existing permission", () => {
    for (const [key, permission, patterns] of expectations) {
      const entry = getMatrixEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.permission, key).toBe(permission);
      for (const pattern of patterns) expect(entry?.routePatterns, key).toContain(pattern);
    }
  });

  it("allows an inventory asset read for a pharmacist and denies reception", () => {
    const pharmacist: PolicyActor = { ...actor, roles: ["pharmacist"] };
    expect(decideAction(pharmacist, "inventory.asset.read", { kind: "dashboard", tenantId: "t1" }).allowed).toBe(true);

    const receptionist: PolicyActor = { ...actor, roles: ["receptionist"] };
    expect(decideAction(receptionist, "inventory.asset.read", { kind: "dashboard", tenantId: "t1" }).allowed).toBe(false);
  });
});

describe("approved inventory gap mappings (NEW, 2026-11-12)", () => {
  const expectations: readonly [string, readonly string[]][] = [
    ["inventory.adjustment.read", ["GET /inventory/adjustments"]],
    ["inventory.count.read", ["GET /inventory/counts"]],
    ["inventory.item.read", ["GET /inventory/items"]],
    ["inventory.location.read", ["GET /inventory/locations"]],
    ["inventory.policy.read", ["GET /inventory/policies"]],
    ["inventory.recall.read", ["GET /inventory/recalls"]],
    ["inventory.requisition.read", ["GET /inventory/requisitions", "GET /inventory/requisitions/:id"]],
    ["inventory.requisition.manage", ["POST /inventory/requisitions"]],
    ["inventory.requisition.submit", ["POST /inventory/requisitions/:id/submit"]],
    ["inventory.transfer.read", ["GET /inventory/transfers", "GET /inventory/transfers/:id"]],
    ["inventory.movement.reverse.manage", ["POST /inventory/movements/:id/reverse"]],
    ["inventory.reservation.manage", ["POST /inventory/reservations"]],
    ["inventory.reservation.release.manage", ["POST /inventory/reservations/:id/release"]],
  ];

  it("binds each approved new inventory route to its new permission", () => {
    for (const [key, patterns] of expectations) {
      const entry = getMatrixEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.permission, key).toBe(key);
      expect(entry?.status, key).toBe("canonical");
      for (const pattern of patterns) expect(entry?.routePatterns, key).toContain(pattern);
    }
  });

  it("grants the approved candidate roles and not unrelated roles", () => {
    for (const role of ["pharmacist", "ward_manager", "facility_admin", "cssd", "biomedical"] as const) {
      const granted = permissionsForRoles([role]);
      for (const [key] of expectations) expect(granted.has(key as Permission), `${role}:${key}`).toBe(true);
    }
    const receptionist = permissionsForRoles(["receptionist"]);
    expect(receptionist.has("inventory.item.read")).toBe(false);
    expect(receptionist.has("inventory.reservation.manage")).toBe(false);
  });

  it("allows an approved read for a biomedical user and denies reception", () => {
    const biomedical: PolicyActor = { ...actor, roles: ["biomedical"] };
    expect(decideAction(biomedical, "inventory.item.read", { kind: "dashboard", tenantId: "t1" }).allowed).toBe(true);

    const receptionist: PolicyActor = { ...actor, roles: ["receptionist"] };
    expect(decideAction(receptionist, "inventory.item.read", { kind: "dashboard", tenantId: "t1" }).allowed).toBe(false);
  });
});
