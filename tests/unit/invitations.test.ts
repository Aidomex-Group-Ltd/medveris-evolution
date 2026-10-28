import { describe, expect, it } from "vitest";
import { adminInvitationStatus, assertInvitable, invitationEmail, invitationStatus, maskEmail } from "../../apps/api/src/services/invitations.js";
import { safeReturnPath } from "../../apps/web/src/lib/navigation.js";

const now = new Date("2026-10-28T08:00:00Z");
const future = new Date("2026-11-04T08:00:00Z");

function loaded(overrides: Record<string, unknown> = {}, facilityStatus = "active", inviterIsAdmin = true): any {
  return {
    invitation: { acceptedAt: null, revokedAt: null, declinedAt: null, expiresAt: future, ...overrides },
    facility: { status: facilityStatus },
    inviterIsAdmin,
  };
}

describe("invitation status", () => {
  it("is pending only while unused, unexpired, at an active facility and from a current administrator", () => {
    expect(invitationStatus(loaded(), now)).toBe("pending");
    expect(invitationStatus(loaded({ expiresAt: now }), now)).toBe("expired");
    expect(invitationStatus(loaded({}, "suspended"), now)).toBe("facility_unavailable");
    expect(invitationStatus(loaded({}, "active", false), now)).toBe("inviter_unauthorized");
  });

  it("reports a recorded outcome before expiry", () => {
    expect(invitationStatus(loaded({ acceptedAt: now, expiresAt: now }), now)).toBe("accepted");
    expect(invitationStatus(loaded({ revokedAt: now }), now)).toBe("revoked");
    expect(invitationStatus(loaded({ declinedAt: now }), now)).toBe("declined");
    expect(adminInvitationStatus({ acceptedAt: null, revokedAt: null, declinedAt: null, expiresAt: now }, now)).toBe("expired");
  });
});

describe("invitation email and roles", () => {
  it("carries the facility, the confirmation link and expiry, and nothing about other staff", () => {
    const email = invitationEmail({ origin: "https://medveris.example", facilityName: "Kampala Clinic", token: "tok_123", expiresAt: future });
    expect(email.subject).toContain("Kampala Clinic");
    expect(email.text).toContain("https://medveris.example/accept-invitation?token=tok_123");
    expect(email.text).toContain("does not accept the invitation");
  });

  it("masks the invited address", () => {
    expect(maskEmail("nurse.jane@clinic.example")).toBe("n•••@clinic.example");
  });

  it("refuses roles that are not facility staff roles", () => {
    expect(assertInvitable(["nurse", "facility_admin"])).toBeNull();
    expect(assertInvitable(["nurse", "patient", "credential_reviewer"])).toBe("patient, credential_reviewer cannot be granted through a facility invitation");
  });
});

describe("return path after sign-in", () => {
  it("keeps same-application paths with their query", () => {
    expect(safeReturnPath("/accept-invitation?token=abc")).toBe("/accept-invitation?token=abc");
    expect(safeReturnPath("/admin")).toBe("/admin");
  });

  it("rejects other sites, the sign-in page and non-strings", () => {
    for (const value of ["//evil.example/x", "https://evil.example", "/\\evil.example", "/login", "/login?as=staff", "admin", null, 42]) {
      expect(safeReturnPath(value), String(value)).toBeNull();
    }
  });
});
