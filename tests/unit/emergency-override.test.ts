import { describe, expect, it } from "vitest";
import {
  canAudit,
  canUseEmergencyOverride,
  getMatrixEntry,
  type ActorContext,
  type Role,
} from "@medveris/authz";
import {
  emergencyOverrideSchema,
  emergencyOverrideRevokeSchema,
} from "@medveris/contracts";

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: "u1",
    roles: ["clinician"],
    tenantId: "t1",
    patientId: null,
    mfaVerified: true,
    mfaEnrolled: true,
    platformRoles: [],
    ...overrides,
  } as ActorContext;
}

describe("break-glass eligibility (canUseEmergencyOverride)", () => {
  it("admits a clinician or nurse with enrolled and verified MFA", () => {
    expect(canUseEmergencyOverride(actor())).toBe(true);
    expect(canUseEmergencyOverride(actor({ roles: ["nurse"] }))).toBe(true);
  });

  it("denies enrolled-but-unverified or unenrolled MFA", () => {
    expect(canUseEmergencyOverride(actor({ mfaVerified: false }))).toBe(false);
    expect(canUseEmergencyOverride(actor({ mfaEnrolled: false }))).toBe(false);
  });

  it("denies non-clinical and non-staff roles even with MFA", () => {
    for (const roles of [["facility_admin"], ["reception"], ["pharmacist"], ["midwife"], ["records"], ["auditor"]] as string[][]) {
      expect(canUseEmergencyOverride(actor({ roles: roles as Role[] }))).toBe(false);
    }
  });

  // Note: tenant scoping is enforced by requireStaff middleware + RLS, not by canUseEmergencyOverride.
});

describe("governance review access (canAudit)", () => {
  it("admits facility_admin and auditor only", () => {
    expect(canAudit(actor({ roles: ["facility_admin"] }))).toBe(true);
    expect(canAudit(actor({ roles: ["auditor"] }))).toBe(true);
    expect(canAudit(actor({ roles: ["clinician"] }))).toBe(false);
    expect(canAudit(actor({ roles: ["nurse"] }))).toBe(false);
  });
});

describe("emergency override schemas", () => {
  const validCreate = {
    patientId: crypto.randomUUID(),
    encounterId: crypto.randomUUID(),
    reason: "unconscious patient, no next of kin reachable",
    password: "correct horse",
    totpCode: "123456",
  };

  it("accepts a well-formed override activation", () => {
    expect(emergencyOverrideSchema.safeParse(validCreate).success).toBe(true);
  });

  it("rejects short reasons and malformed TOTP codes", () => {
    expect(emergencyOverrideSchema.safeParse({ ...validCreate, reason: "short" }).success).toBe(false);
    expect(emergencyOverrideSchema.safeParse({ ...validCreate, totpCode: "12345" }).success).toBe(false);
    expect(emergencyOverrideSchema.safeParse({ ...validCreate, totpCode: "abcdef" }).success).toBe(false);
  });

  it("accepts a well-formed revocation and rejects thin reasons", () => {
    expect(emergencyOverrideRevokeSchema.safeParse({ reason: "access no longer needed" }).success).toBe(true);
    expect(emergencyOverrideRevokeSchema.safeParse({ reason: "n/a" }).success).toBe(false);
  });
});

describe("authorization matrix binding", () => {
  it("binds the override revocation route to its permission", () => {
    const entry = getMatrixEntry("emergency.access.revoke");
    expect(entry).toBeDefined();
    expect(entry?.permission).toBe("emergency.access.revoke");
    expect(entry?.routePatterns).toContain("POST /emergency-overrides/:id/revoke");
    expect(entry?.routeFile).toBe("consent.ts");
    expect(entry?.tenantBound).toBe(true);
    expect(entry?.rls).toBe(true);
  });

  it("keeps activate and revoke as distinct permissioned actions", () => {
    const activate = getMatrixEntry("emergency.access.activate");
    const revoke = getMatrixEntry("emergency.access.revoke");
    expect(activate?.permission).toBe("emergency.access.activate");
    expect(revoke?.permission).toBe("emergency.access.revoke");
  });
});
