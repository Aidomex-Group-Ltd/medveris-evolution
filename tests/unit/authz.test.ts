import { describe, expect, it } from "vitest";
import {
  assertClinicalRead,
  assertClinicalWrite,
  assertDepartmentAccess,
  assertMembershipAdmin,
  assertSign,
  assertUnitAccess,
  canReadClinical,
  canUseEmergencyOverride,
  hasDepartmentAccess,
  hasUnitAccess,
  hasWorkspaceWideScope,
  ROLES,
  permissionsForRoles,
  withImpliedRoles,
  type ActorContext,
  type Role,
} from "@medveris/authz";

const base: ActorContext = {
  userId: "u1",
  roles: [],
  tenantId: "t1",
  patientId: null,
  mfaVerified: true,
  mfaEnrolled: true,
};

describe("role boundaries", () => {
  it("denies clinical access to facility administrators by role alone", () => {
    const admin = { ...base, roles: ["facility_admin"] as Role[] };
    expect(canReadClinical(admin)).toBe(false);
    expect(() => assertClinicalRead(admin)).toThrow();
    expect(() => assertClinicalWrite(admin)).toThrow();
    expect(() => assertSign(admin)).toThrow();
    expect(() => assertMembershipAdmin(admin)).not.toThrow();
  });

  it("allows nurses to document but not sign clinical notes", () => {
    const nurse = { ...base, roles: ["nurse"] as Role[] };
    expect(canReadClinical(nurse)).toBe(true);
    expect(() => assertClinicalWrite(nurse)).not.toThrow();
    expect(() => assertSign(nurse)).toThrow();
  });

  it("allows clinicians to sign only with enrolled and verified MFA for audit actions", () => {
    const clinician = { ...base, roles: ["clinician"] as Role[] };
    expect(() => assertSign(clinician)).not.toThrow();
    expect(canUseEmergencyOverride(clinician)).toBe(true);
    expect(canUseEmergencyOverride({ ...clinician, mfaVerified: false })).toBe(false);
    expect(canUseEmergencyOverride({ ...clinician, mfaEnrolled: false })).toBe(false);
  });

  it("denies clinical access to reception, finance and auditor roles", () => {
    for (const role of ["receptionist", "finance", "auditor"] as const) {
      const actor = { ...base, roles: [role] as Role[] };
      expect(canReadClinical(actor)).toBe(false);
      expect(() => assertSign(actor)).toThrow();
    }
  });
});

describe("specialised department roles", () => {
  it("implies department access without implying sign-off", () => {
    expect(withImpliedRoles(["radiographer"]).sort()).toEqual(["radiographer", "radiology"]);
    expect(withImpliedRoles(["lab_validator"]).sort()).toEqual(["lab_validator", "laboratory"]);
    expect(withImpliedRoles(["ward_manager"]).sort()).toEqual(["nurse", "ward_manager"]);
    expect(withImpliedRoles(["privacy_officer"])).toEqual(["privacy_officer"]);
  });

  it("lets only radiologists sign radiology reports", () => {
    const signers = ROLES.filter((role) => permissionsForRoles(withImpliedRoles([role])).has("radiology.report.sign"));
    expect(signers).toEqual(["radiologist"]);
    expect(permissionsForRoles(withImpliedRoles(["radiographer"])).has("radiology.report.draft")).toBe(true);
  });

  it("separates laboratory validation from result entry", () => {
    expect(permissionsForRoles(["laboratory"]).has("diagnostic.result.validate")).toBe(false);
    expect(permissionsForRoles(["lab_validator"]).has("diagnostic.result.validate")).toBe(true);
  });

  it("gives the privacy officer audit access and no clinical record access", () => {
    const permissions = permissionsForRoles(withImpliedRoles(["privacy_officer"]));
    expect(permissions.has("audit.read")).toBe(true);
    expect(permissions.has("privacy.access.review")).toBe(true);
    expect([...permissions].some((permission) => permission.startsWith("clinical.") || permission.startsWith("medication."))).toBe(false);
  });
});

describe("unit and department boundaries", () => {
  it("limits a unit lead to its own unit and denies unrelated units", () => {
    const actorInUnit: ActorContext = { ...base, roles: ["unit_lead"], unitId: "unit-icu" };
    const actorNoUnit: ActorContext = { ...base, roles: ["unit_lead"] };
    const actorNoTenant: ActorContext = { ...base, tenantId: null, roles: ["unit_lead"], unitId: "unit-icu" };

    expect(hasWorkspaceWideScope(actorInUnit)).toBe(false);
    expect(hasUnitAccess(actorInUnit, "unit-icu")).toBe(true);
    expect(hasUnitAccess(actorInUnit, "unit-opd")).toBe(false);
    expect(hasUnitAccess(actorNoUnit, "unit-icu")).toBe(false);
    expect(hasUnitAccess(actorNoTenant, "unit-icu")).toBe(false);

    expect(() => assertUnitAccess(actorInUnit, "unit-icu")).not.toThrow();
    expect(() => assertUnitAccess(actorInUnit, "unit-opd")).toThrow(/Unit access is not permitted/);
    expect(() => assertUnitAccess(actorNoUnit, "unit-icu")).toThrow(/Unit access is not permitted/);
  });

  it("limits a department administrator to its own department", () => {
    const actorInDept: ActorContext = { ...base, roles: ["department_admin"], departmentId: "dept-peds" };
    const actorNoDept: ActorContext = { ...base, roles: ["department_admin"] };
    const actorNoTenant: ActorContext = { ...base, tenantId: null, roles: ["department_admin"], departmentId: "dept-peds" };

    expect(hasDepartmentAccess(actorInDept, "dept-peds")).toBe(true);
    expect(hasDepartmentAccess(actorInDept, "dept-surgery")).toBe(false);
    expect(hasDepartmentAccess(actorNoDept, "dept-peds")).toBe(false);
    expect(hasDepartmentAccess(actorNoTenant, "dept-peds")).toBe(false);

    expect(() => assertDepartmentAccess(actorInDept, "dept-peds")).not.toThrow();
    expect(() => assertDepartmentAccess(actorInDept, "dept-surgery")).toThrow(/Department access is not permitted/);
    expect(() => assertDepartmentAccess(actorNoDept, "dept-peds")).toThrow(/Department access is not permitted/);
  });

  it("keeps workspace-wide roles able to act across the tenant", () => {
    const admin: ActorContext = { ...base, roles: ["facility_admin"] };
    expect(hasWorkspaceWideScope(admin)).toBe(true);
    expect(hasUnitAccess(admin, "unit-icu")).toBe(true);
    expect(hasDepartmentAccess(admin, "dept-peds")).toBe(true);
  });

  it("denies any scope without an active tenant", () => {
    const actor: ActorContext = { ...base, tenantId: null, roles: ["facility_admin"], unitId: "unit-icu", departmentId: "dept-peds" };
    expect(hasWorkspaceWideScope(actor)).toBe(false);
    expect(hasUnitAccess(actor, "unit-icu")).toBe(false);
    expect(hasDepartmentAccess(actor, "dept-peds")).toBe(false);
  });
});
