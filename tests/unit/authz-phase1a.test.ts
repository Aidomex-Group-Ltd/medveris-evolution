import { describe, expect, it } from "vitest";
import {
  AUTHZ_CONTRACT_VERSION,
  ADMINISTRATIVE_DELEGATION_BOUNDARIES,
  LEGACY_CHECK_MAPPINGS,
  PERMISSIONS,
  POLICY_VERSION,
  isKnownPermission,
  normalizeRolesForCompatibility,
  authorize,
  permissionsForRoles,
  type Permission,
  type PolicyActor,
  type ResourceContext,
} from "@medveris/authz";

const staffBase: PolicyActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  roles: [],
  tenantId: "22222222-2222-4222-8222-222222222222",
  patientId: null,
  mfaVerified: true,
  mfaEnrolled: true,
  membershipActive: true,
  engagementActive: true,
  credentialValid: true,
  privileges: ["CLIN-SIGN"],
  careTeamPatientIds: ["33333333-3333-4333-8333-333333333333"],
};

describe("Phase 1A authz contract (remediation increment 1)", () => {
  it("exposes additive contract metadata and authoritative mappings", () => {
    expect(AUTHZ_CONTRACT_VERSION).toBe("2026-11-10.phase1a.remediation-1");
    expect(PERMISSIONS.length).toBeGreaterThan(0);
    expect(LEGACY_CHECK_MAPPINGS.length).toBeGreaterThan(0);
    expect(ADMINISTRATIVE_DELEGATION_BOUNDARIES.length).toBeGreaterThan(0);
  });

  it("validates permissions against the canonical registry only", () => {
    for (const permission of PERMISSIONS) expect(isKnownPermission(permission)).toBe(true);
    expect(isKnownPermission("clinical.note.sign" satisfies Permission)).toBe(true);
    expect(isKnownPermission("not.a.real.permission")).toBe(false);
    expect(isKnownPermission("finance.dashboard.read ")).toBe(false);
    expect(isKnownPermission(" clinical.note.sign")).toBe(false);
    expect(isKnownPermission("")).toBe(false);
    expect(isKnownPermission("   ")).toBe(false);
  });

  it("preserves resolved legacy mappings and marks unresolved semantics explicitly", () => {
    const byLegacy = new Map(LEGACY_CHECK_MAPPINGS.map((mapping) => [mapping.legacy, mapping]));
    expect(byLegacy.get("canTakePayments/assertCashier")?.canonicalPermissions).toEqual(["finance.payment.record"]);
    expect(byLegacy.get("assertPriceListManager")?.canonicalPermissions).toEqual([]);
    expect(byLegacy.get("assertPriceListManager")?.unresolved).toBe(true);
    for (const mapping of LEGACY_CHECK_MAPPINGS) {
      for (const permission of mapping.canonicalPermissions) expect(isKnownPermission(permission)).toBe(true);
    }
  });

  it("does not map price-list management to read-only finance permission", () => {
    const priceList = LEGACY_CHECK_MAPPINGS.find((mapping) => mapping.legacy === "assertPriceListManager");
    expect(priceList?.canonicalPermissions).not.toContain("finance.dashboard.read");
  });

  it("keeps compatibility normalization explicit and identity-preserving", () => {
    const roles = ["facility_admin", "finance"] as const;
    const normalized = normalizeRolesForCompatibility(roles);
    expect(normalized).toEqual(["facility_admin", "finance"]);
    expect(normalized).not.toBe(roles);
  });

  it("preserves professional/administrative separation boundaries", () => {
    const clinical = ADMINISTRATIVE_DELEGATION_BOUNDARIES.find((b) => b.domain === "clinical");
    expect(clinical?.mustNotDelegate).toContain("clinical.note.sign");
    const facility = permissionsForRoles(["facility_admin"]);
    expect(facility.has("organization.membership.manage")).toBe(true);
    expect(facility.has("clinical.note.sign")).toBe(false);
  });
});

describe("Policy engine authorization cases", () => {
  it("allows authorized clinical sign with required context", () => {
    const actor: PolicyActor = { ...staffBase, roles: ["clinician"] as any };
    const resource: ResourceContext = { kind: "clinical-record", tenantId: actor.tenantId };
    const decision = authorize(actor, "clinical.note.sign", resource);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("allowed");
    expect(decision.policyVersion).toBe(POLICY_VERSION);
  });

  it("denies unauthenticated actor", () => {
    const decision = authorize({ ...staffBase, userId: null, roles: ["clinician"] as any }, "clinical.note.sign", { kind: "clinical-record", tenantId: staffBase.tenantId });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unauthenticated");
  });

  it("denies cross-tenant staff access", () => {
    const actor: PolicyActor = { ...staffBase, roles: ["facility_admin"] as any };
    const decision = authorize(actor, "organization.membership.manage", { kind: "organization", tenantId: "99999999-9999-4999-8999-999999999999" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("tenant-mismatch");
  });

  it("denies missing tenant context for staff permission", () => {
    const actor: PolicyActor = { ...staffBase, tenantId: null, roles: ["facility_admin"] as any };
    const decision = authorize(actor, "organization.membership.manage", { kind: "organization" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("tenant-required");
  });

  it("denies inactive membership and missing MFA", () => {
    const inactive = authorize({ ...staffBase, roles: ["facility_admin"] as any, membershipActive: false }, "organization.membership.manage", { kind: "organization", tenantId: staffBase.tenantId });
    expect(inactive.reason).toBe("membership-inactive");
    const noMfa = authorize({ ...staffBase, roles: ["facility_admin"] as any, mfaVerified: false }, "organization.membership.manage", { kind: "organization", tenantId: staffBase.tenantId });
    expect(noMfa.reason).toBe("mfa-required");
  });

  it("denies revoked session", () => {
    const decision = authorize({ ...staffBase, roles: ["clinician"] as any, sessionRevokedAt: new Date() }, "clinical.note.sign", { kind: "clinical-record", tenantId: staffBase.tenantId });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unauthenticated");
  });

  it("denies role escalation / missing permission", () => {
    const receptionist = authorize({ ...staffBase, roles: ["receptionist"] as any }, "clinical.note.sign", { kind: "clinical-record", tenantId: staffBase.tenantId });
    expect(receptionist.reason).toBe("role-permission-missing");
    const finance = authorize({ ...staffBase, roles: ["finance"] as any }, "clinical.record.read_authorized", { kind: "clinical-record", tenantId: staffBase.tenantId, patientId: staffBase.careTeamPatientIds![0], relationship: "care-team" });
    expect(finance.reason).toBe("role-permission-missing");
  });

  it("denies clinical read without care relationship", () => {
    const actor: PolicyActor = { ...staffBase, roles: ["clinician"] as any, careTeamPatientIds: [] };
    const decision = authorize(actor, "clinical.record.read_authorized", { kind: "clinical-record", tenantId: actor.tenantId, patientId: "33333333-3333-4333-8333-333333333333" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("care-relationship-required");
  });

  it("denies self-approval and enforces content separation of duties", () => {
    const actor: PolicyActor = { ...staffBase, roles: ["facility_admin"] as any };
    const selfApprove = authorize(actor, "role_grant.approve", { kind: "role-grant", tenantId: actor.tenantId, ownerUserId: actor.userId! });
    expect(selfApprove.reason).toBe("self-approval-forbidden");
    const selfPublish = authorize({ ...staffBase, roles: ["content_reviewer"] as any }, "content.publish", { kind: "content", tenantId: staffBase.tenantId, authorUserId: staffBase.userId! });
    expect(selfPublish.reason).toBe("separation-of-duties");
  });

  it("denies expired proxy and requires patient self/proxy context", () => {
    const actor: PolicyActor = { ...staffBase, tenantId: null, roles: ["proxy"] as any, patientId: null, proxyScopes: ["patient.record.read_released_self"], proxyExpiresAt: new Date(Date.now() - 1000) };
    const expired = authorize(actor, "patient.record.read_released_self", { kind: "patient-record", patientId: "44444444-4444-4444-8444-444444444444", relationship: "proxy" });
    expect(expired.reason).toBe("proxy-expired");
  });
});
