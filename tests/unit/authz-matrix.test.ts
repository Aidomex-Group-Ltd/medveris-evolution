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
        expect(pattern, entry.key).toMatch(/^(GET|POST|PUT|PATCH|DELETE|ALL) \//);
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

describe("approved small-domain gap mappings (2026-11-12)", () => {
  const expectations: readonly [string, readonly string[]][] = [
    ["clinical.case.read", ["GET /emergency/cases", "GET /emergency/cases/:id"]],
    ["clinical.case.observation.manage", ["POST /emergency/cases/:id/observations"]],
    ["clinical.session.read", ["GET /telehealth/sessions", "GET /telehealth/sessions/:id"]],
    ["clinical.session.participant.read", ["GET /telehealth/sessions/:id/participants"]],
    ["clinical.session.consent.manage", ["POST /telehealth/sessions/:id/consent"]],
    ["clinical.draft.update", ["PUT /entries/:id/draft"]],
    ["document.resource.read", ["GET /document-templates", "GET /document-templates/:id", "GET /documents", "GET /documents/:id"]],
    ["ai.job.read", ["GET /ai/jobs", "GET /ai/jobs/:id"]],
    ["devices.resource.read", ["GET /device-alerts", "GET /devices"]],
    ["organization.resource.read", ["GET /logo"]],
    ["billing.subscription_checkout.quote.read", ["GET /billing/subscription-checkout/quote"]],
    ["billing.subscription_renewal.read", ["GET /billing/subscription-renewal"]],
    ["billing.subscription_checkout.cancel.manage", ["POST /billing/subscription-checkout/:id/cancel"]],
    ["inventory.purchase_order.read", ["GET /procurement/purchase-orders", "GET /procurement/purchase-orders/:id"]],
    ["inventory.supplier.read", ["GET /procurement/suppliers"]],
    ["inventory.purchase_order.receive", ["POST /procurement/purchase-orders/:id/receive"]],
    ["inventory.supplier.status.manage", ["POST /procurement/suppliers/:id/status"]],
    ["platform.observability.api_metric.read", ["GET /platform/observability/api-metrics"]],
    ["platform.observability.integration.read", ["GET /platform/observability/integrations"]],
    ["platform.observability.log.read", ["GET /platform/observability/logs"]],
    ["platform.observability.trace.read", ["GET /platform/observability/traces"]],
    ["platform.observability.worker.read", ["GET /platform/observability/workers"]],
  ];

  it("binds each approved small-domain route", () => {
    for (const [key, patterns] of expectations) {
      const entry = getMatrixEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.permission, key).toBe(key);
      for (const pattern of patterns) expect(entry?.routePatterns, key).toContain(pattern);
    }
  });

  it("grants the approved candidate roles", () => {
    const clinician = permissionsForRoles(["clinician"]);
    expect(clinician.has("clinical.case.read")).toBe(true);
    expect(clinician.has("document.resource.read")).toBe(true);
    expect(clinician.has("ai.job.read")).toBe(true);

    const biomedical = permissionsForRoles(["biomedical"]);
    expect(biomedical.has("devices.resource.read")).toBe(true);
    expect(biomedical.has("inventory.purchase_order.receive")).toBe(true);

    const admin = permissionsForRoles(["facility_admin"]);
    expect(admin.has("billing.subscription_checkout.cancel.manage")).toBe(true);
    expect(admin.has("organization.resource.read")).toBe(true);

    const itAdmin = permissionsForRoles(["it_admin"]);
    expect(itAdmin.has("platform.observability.trace.read")).toBe(true);

    const receptionist = permissionsForRoles(["receptionist"]);
    expect(receptionist.has("clinical.case.read")).toBe(false);
    expect(receptionist.has("platform.observability.trace.read")).toBe(false);
  });

  it("requires a platform operator grant for observability reads", () => {
    const actorWithoutGrant: PolicyActor = { ...actor, roles: ["it_admin"] };
    const denied = decideAction(actorWithoutGrant, "platform.observability.log.read", { kind: "dashboard" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("platform-role-required");

    const operator: PolicyActor = { ...actorWithoutGrant, platformRoles: ["platform_operator"] };
    expect(decideAction(operator, "platform.observability.log.read", { kind: "dashboard" }).allowed).toBe(true);
  });
});

describe("approved operations/content gap mappings (2026-11-12)", () => {
  const expectations: readonly [string, readonly string[]][] = [
    ["operations.task.read", ["GET /housekeeping/tasks", "GET /porter/tasks"]],
    ["operations.case.read", ["GET /mortuary/cases", "GET /mortuary/cases/:id"]],
    ["operations.bed.read", ["GET /operations/beds"]],
    ["operations.asset.read", ["GET /technical/assets"]],
    ["operations.cssd_cycle.read", ["GET /technical/cssd-cycles"]],
    ["operations.work_order.read", ["GET /technical/work-orders"]],
    ["operations.task.transition.manage", ["POST /housekeeping/tasks/:id/transition", "POST /porter/tasks/:id/transition"]],
    ["operations.case.effect.manage", ["POST /mortuary/cases/:id/effects"]],
    ["operations.case.movement.manage", ["POST /mortuary/cases/:id/movements"]],
    ["operations.case.release.manage", ["POST /mortuary/cases/:id/release"]],
    ["operations.cssd_cycle.manage", ["POST /technical/cssd-cycles"]],
    ["operations.cssd_cycle.release.manage", ["POST /technical/cssd-cycles/:id/release"]],
    ["operations.work_order.transition.manage", ["POST /technical/work-orders/:id/transition"]],
    ["content.bookmark.delete", ["DELETE /content/:id/bookmark"]],
    ["content.summary.read", ["GET /access/summary"]],
    ["organization.care_team.read", ["GET /admin/care-team"]],
    ["organization.bookmark.mine.read", ["GET /content/bookmarks/mine"]],
    ["organization.editorial.item.read", ["GET /content/editorial/items"]],
    ["organization.preference.mine.read", ["GET /content/preferences/mine"]],
    ["organization.source.read", ["GET /content/sources"]],
    ["organization.patient.read", ["GET /dashboards/patient"]],
    ["organization.specialist.read", ["GET /dashboards/specialist"]],
    ["organization.opportunity.withdraw.manage", ["POST /content-feeds/opportunities/:id/withdraw"]],
    ["organization.bookmark.manage", ["POST /content/:id/bookmark", "POST /opportunities/:id/bookmark"]],
    ["organization.report.manage", ["POST /content/:id/report", "POST /opportunities/:id/report"]],
    ["organization.preference.mine.update", ["PUT /content/preferences/mine"]],
  ];

  it("binds each approved route", () => {
    for (const [key, patterns] of expectations) {
      const entry = getMatrixEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.permission, key).toBe(key);
      for (const pattern of patterns) expect(entry?.routePatterns, key).toContain(pattern);
    }
    expect(getMatrixEntry("operations.asset.manage")?.routePatterns).toContain("POST /technical/assets");
    expect(getMatrixEntry("organization.resource.read")?.routePatterns).toContain("GET /opportunities");
  });

  it("grants the approved candidate roles", () => {
    const admin = permissionsForRoles(["facility_admin"]);
    expect(admin.has("operations.task.read")).toBe(true);
    expect(admin.has("operations.work_order.transition.manage")).toBe(true);
    expect(admin.has("organization.bookmark.manage")).toBe(true);

    const wardManager = permissionsForRoles(["ward_manager"]);
    expect(wardManager.has("operations.case.read")).toBe(true);
    expect(wardManager.has("organization.bookmark.manage")).toBe(false);

    const quality = permissionsForRoles(["quality"]);
    expect(quality.has("operations.cssd_cycle.release.manage")).toBe(true);

    const hr = permissionsForRoles(["hr"]);
    expect(hr.has("organization.care_team.read")).toBe(true);
    expect(hr.has("operations.task.read")).toBe(false);

    const editor = permissionsForRoles(["content_editor"]);
    expect(editor.has("content.bookmark.delete")).toBe(true);
    expect(editor.has("content.summary.read")).toBe(true);

    const moderator = permissionsForRoles(["opportunity_moderator"]);
    expect(moderator.has("content.summary.read")).toBe(true);

    const receptionist = permissionsForRoles(["receptionist"]);
    expect(receptionist.has("operations.task.read")).toBe(false);
    expect(receptionist.has("content.bookmark.delete")).toBe(false);
  });

  it("authorizes operations reads for a ward manager and denies reception", () => {
    const wardManager: PolicyActor = { ...actor, roles: ["ward_manager"] };
    const allowed = decideAction(wardManager, "operations.task.read", {
      kind: "organization",
      tenantId: "t1",
      departmentId: "d1",
    });
    expect(allowed.allowed).toBe(true);

    const receptionist: PolicyActor = { ...actor, roles: ["receptionist"] };
    expect(
      decideAction(receptionist, "operations.task.read", {
        kind: "organization",
        tenantId: "t1",
        departmentId: "d1",
      }).allowed,
    ).toBe(false);
  });
});

describe("approved maternity/inpatient/diagnostics gap mappings (2026-11-12)", () => {
  const expectations: readonly [string, readonly string[]][] = [
    ["clinical.episode.read", ["GET /maternity/episodes", "GET /maternity/episodes/:id"]],
    ["clinical.newborn.status.update", ["PATCH /maternity/newborns/:newbornId/status"]],
    ["clinical.resource.read", ["GET /admissions/:id"]],
    ["clinical.resource.manage", ["POST /admissions", "POST /wards"]],
    ["clinical.bed.manage", ["POST /wards/:id/beds"]],
    ["diagnostic.resource.read", ["GET /critical-communications", "GET /diagnostic-orders", "GET /diagnostic-orders/:id", "GET /lab-tests"]],
    ["diagnostic.resource.manage", ["POST /imaging-studies", "POST /lab-tests"]],
    ["diagnostic.critical_communication.manage", ["POST /lab-results/:id/critical-communications"]],
  ];

  it("binds representative approved routes", () => {
    for (const [key, patterns] of expectations) {
      const entry = getMatrixEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.permission, key).toBe(key);
      for (const pattern of patterns) expect(entry?.routePatterns, key).toContain(pattern);
    }
  });

  it("grants maternity/inpatient permissions to clinical roles and diagnostics to lab roles", () => {
    const clinician = permissionsForRoles(["clinician"]);
    expect(clinician.has("clinical.episode.read")).toBe(true);
    expect(clinician.has("clinical.bed.manage")).toBe(true);
    const nurse = permissionsForRoles(["nurse"]);
    expect(nurse.has("clinical.newborn.patient.manage")).toBe(true);
    const midwife = permissionsForRoles(["midwife"]);
    expect(midwife.has("clinical.episode.observation.manage")).toBe(true);

    const lab = permissionsForRoles(["laboratory"]);
    expect(lab.has("diagnostic.resource.read")).toBe(true);
    expect(lab.has("diagnostic.critical_communication.manage")).toBe(true);
    const validator = permissionsForRoles(["lab_validator"]);
    expect(validator.has("diagnostic.assign.manage")).toBe(true);
    const diag = permissionsForRoles(["diagnostic_practitioner"]);
    expect(diag.has("diagnostic.worklist.read")).toBe(true);

    const receptionist = permissionsForRoles(["receptionist"]);
    expect(receptionist.has("clinical.episode.read")).toBe(false);
    expect(receptionist.has("diagnostic.resource.read")).toBe(false);
  });
});
