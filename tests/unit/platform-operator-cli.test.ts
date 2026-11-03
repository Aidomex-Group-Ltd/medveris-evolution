import { describe, expect, it } from "vitest";
import { assertBreakGlassAllowed } from "../../apps/api/src/lib/platform-roles.js";
import { loadConfig } from "../../apps/api/src/config.js";

const baseEnv = {
  APP_ENV: "production",
  APP_ORIGIN: "https://app.example.org",
  SESSION_SECRET: "x".repeat(48),
  AUDIT_SIGNING_KEY: "y".repeat(48),
  MFA_ENCRYPTION_KEY: "z".repeat(48),
};

describe("break-glass CLI gate", () => {
  it("refuses production without the explicit flag", () => {
    expect(() => assertBreakGlassAllowed("production", ["grant", "--user", "u", "--reason", "bootstrap"]))
      .toThrow(/--allow-production/);
  });

  it("refuses production with the flag but without a written reason", () => {
    expect(() => assertBreakGlassAllowed("production", ["grant", "--user", "u", "--allow-production"]))
      .toThrow(/--reason/);
  });

  it("allows production only with both the flag and a reason", () => {
    expect(() => assertBreakGlassAllowed("production", [
      "grant", "--user", "u", "--allow-production", "--reason=bootstrap",
    ])).not.toThrow();
  });

  it("does not require the production flag in synthetic environments", () => {
    expect(() => assertBreakGlassAllowed("test", ["grant", "--user", "u", "--reason", "synthetic"])).not.toThrow();
  });
});

describe("legacy elevate environment gate", () => {
  it("refuses a configuration that enables the retired endpoints in production", () => {
    expect(() => loadConfig({
      ...baseEnv,
      TERMINOLOGY_MODE: "production",
      TERMINOLOGY_PROVIDER_URL: "https://terminology.example.org",
      PLATFORM_ROLE_LEGACY_ELEVATE_ENVIRONMENTS: "production,staging",
    })).toThrow(/must never include production/);
  });

  it("keeps the retired endpoints disabled by default", () => {
    const config = loadConfig({ ...baseEnv, TERMINOLOGY_MODE: "unavailable" });
    expect(config.platformRoles.legacyElevateEnvironments).toEqual([]);
  });
});
