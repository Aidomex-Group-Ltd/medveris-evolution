import { describe, expect, it } from "vitest";
import { assertInvitable, INVITABLE_FACILITY_ROLES, NON_INVITABLE_ROLES } from "../../apps/api/src/services/invitations.js";

describe("Phase 2 role-escalation boundaries", () => {
  it("allows only explicit facility/workspace roles through invitation and membership admin paths", () => {
    for (const role of INVITABLE_FACILITY_ROLES) {
      expect(assertInvitable([role])).toBeNull();
    }
  });

  it("denies platform, identity, and unknown roles", () => {
    for (const role of ["platform_operator", "credential_reviewer", "patient", "proxy", "superadmin", ""]) {
      expect(assertInvitable([role as string])).toContain("cannot be granted");
    }
  });

  it("keeps privileged/identity roles outside invitable set", () => {
    expect(INVITABLE_FACILITY_ROLES.has("platform_operator")).toBe(false);
    for (const role of NON_INVITABLE_ROLES) expect(INVITABLE_FACILITY_ROLES.has(role)).toBe(false);
  });
});
