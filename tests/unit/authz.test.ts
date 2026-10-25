import { describe, expect, it } from "vitest";
import {
  assertClinicalRead,
  assertClinicalWrite,
  assertMembershipAdmin,
  assertSign,
  canReadClinical,
  canUseEmergencyOverride,
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
