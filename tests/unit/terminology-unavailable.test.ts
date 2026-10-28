import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import { DependencyError } from "../../apps/api/src/lib/errors.js";
import { createTerminology } from "../../apps/api/src/terminology/index.js";

const strong = {
  SESSION_SECRET: "a".repeat(20) + "Session-Secret-Value-1",
  AUDIT_SIGNING_KEY: "b".repeat(20) + "Audit-Signing-Value-2",
  MFA_ENCRYPTION_KEY: "c".repeat(20) + "Mfa-Encryption-Value-3",
};

describe("unavailable terminology mode", () => {
  it("is selected explicitly and needs no provider", () => {
    const config = loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "unavailable" });
    expect(config.terminologyMode).toBe("unavailable");
    expect(createTerminology(config).mode).toBe("unavailable");
  });

  it("rejects an unknown mode instead of silently falling back to synthetic codes", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "licensed" }))
      .toThrow("TERMINOLOGY_MODE must be synthetic, production or unavailable");
  });

  it("refuses synthetic terminology in production", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "synthetic" }))
      .toThrow("TERMINOLOGY_MODE=synthetic is not allowed in production");
    expect(() => loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example" }))
      .toThrow("TERMINOLOGY_MODE=synthetic is not allowed in production");
  });

  it("reports every operation as a dependency failure rather than a result", async () => {
    const adapter = createTerminology(loadConfig({ ...strong, APP_ENV: "production", APP_ORIGIN: "https://medveris.example", TERMINOLOGY_MODE: "unavailable" }));
    const calls = [
      adapter.lookup("http://snomed.info/sct", "38341003"),
      adapter.validateCode({ system: "http://snomed.info/sct", code: "38341003" }),
      adapter.expand({ valueSet: "x", count: 10, offset: 0, activeOnly: true }),
      adapter.translate({ conceptMap: "x", system: "http://snomed.info/sct", code: "38341003" }),
      adapter.search("diagnosis", "hyper", 5),
    ];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(DependencyError);
  });
});
