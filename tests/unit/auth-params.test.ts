import { describe, expect, it } from "vitest";
import { destination, readMode, readRole } from "../../apps/web/src/features/auth/auth-params.js";
import type { MeResponse } from "../../apps/web/src/lib/types.js";

function params(init: string): URLSearchParams {
  return new URLSearchParams(init);
}

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return { memberships: [], activeTenant: null, patientId: null, ...overrides } as unknown as MeResponse;
}

describe("auth role resolution", () => {
  it("honors the explicit role parameter", () => {
    expect(readRole(params("role=patient&mode=signin"))).toBe("patient");
    expect(readRole(params("role=provider&mode=signup"))).toBe("provider");
  });

  it("maps legacy as=staff and type=facility to the provider view", () => {
    expect(readRole(params("as=staff"))).toBe("provider");
    expect(readRole(params("type=facility"))).toBe("provider");
    expect(readRole(params("as=staff&mode=signin"))).toBe("provider");
  });

  it("maps type=patient to the patient view", () => {
    expect(readRole(params("type=patient"))).toBe("patient");
  });

  it("defaults to patient for unknown values", () => {
    expect(readRole(params(""))).toBe("patient");
    expect(readRole(params("role=admin"))).toBe("patient");
    expect(readRole(params("role=staff"))).toBe("patient");
  });
});

describe("auth mode resolution", () => {
  it("honors explicit mode", () => {
    expect(readMode(params("mode=signin"))).toBe("signin");
    expect(readMode(params("mode=signup"))).toBe("signup");
  });

  it("derives signup mode from legacy type parameter", () => {
    expect(readMode(params("type=patient"))).toBe("signup");
    expect(readMode(params("type=facility"))).toBe("signup");
  });

  it("defaults to signin", () => {
    expect(readMode(params(""))).toBe("signin");
    expect(readMode(params("role=provider"))).toBe("signin");
  });
});

describe("post-authentication destination", () => {
  it("prefers an explicit safe return path", () => {
    expect(destination(me({ patientId: "p1" }), "patient", "/work-queues/pharmacy")).toBe("/work-queues/pharmacy");
  });

  it("routes patients with portal access to /portal", () => {
    expect(destination(me({ patientId: "p1" }), "patient", null)).toBe("/portal");
  });

  it("routes members with a single active facility to /dashboard", () => {
    expect(destination(me({ memberships: [{ tenantId: "t1", roles: ["clinician"] }], activeTenant: { id: "t1" } } as unknown as MeResponse), "provider", null)).toBe("/dashboard");
  });

  it("routes staff with multiple facilities and no active one to /facility-staff", () => {
    expect(destination(me({ memberships: [{ tenantId: "t1" }, { tenantId: "t2" }], activeTenant: null } as unknown as MeResponse), "provider", null)).toBe("/facility-staff");
    expect(destination(me(), "provider", null)).toBe("/facility-staff");
  });
});
