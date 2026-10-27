import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";

const strong = {
  SESSION_SECRET: "a".repeat(20) + "Session-Secret-Value-1",
  AUDIT_SIGNING_KEY: "b".repeat(20) + "Audit-Signing-Value-2",
  MFA_ENCRYPTION_KEY: "c".repeat(20) + "Mfa-Encryption-Value-3",
};

describe("loadConfig startup validation", () => {
  it("accepts a well-formed staging configuration", () => {
    const config = loadConfig({ ...strong, APP_ENV: "staging", APP_ORIGIN: "https://medveris-staging.example.workers.dev" });
    expect(config.origin).toBe("https://medveris-staging.example.workers.dev");
    expect(config.devShowTotpSecrets).toBe(false);
  });

  it("refuses the development TOTP endpoint outside development and tests", () => {
    for (const appEnv of ["staging", "production"]) {
      expect(() => loadConfig({ ...strong, APP_ENV: appEnv, APP_ORIGIN: "https://medveris.example", DEV_SHOW_TOTP_SECRETS: "true" }))
        .toThrow("DEV_SHOW_TOTP_SECRETS must be false");
    }
    expect(loadConfig({ ...strong, APP_ENV: "development", DEV_SHOW_TOTP_SECRETS: "true" }).devShowTotpSecrets).toBe(true);
  });

  it("names a missing or placeholder secret without echoing its value", () => {
    const placeholder = "replace-with-at-least-32-random-characters";
    let message = "";
    try {
      loadConfig({ ...strong, APP_ENV: "development", MFA_ENCRYPTION_KEY: placeholder });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MFA_ENCRYPTION_KEY");
    expect(message).not.toContain(placeholder);
    expect(() => loadConfig({ ...strong, APP_ENV: "development", SESSION_SECRET: "" })).toThrow("SESSION_SECRET");
  });

  it("requires distinct keys", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "development", MFA_ENCRYPTION_KEY: strong.AUDIT_SIGNING_KEY }))
      .toThrow("must be different values");
  });

  it("requires a Resend key and a real sender when Resend is selected outside local development", () => {
    const staging = { ...strong, APP_ENV: "staging", APP_ORIGIN: "https://medveris-staging.example.workers.dev", EMAIL_ADAPTER: "resend" };
    expect(() => loadConfig({ ...staging, EMAIL_FROM: "MedVeris <no-reply@mail.example.org>" })).toThrow("RESEND_API_KEY");
    expect(() => loadConfig({ ...staging, RESEND_API_KEY: "re_synthetic_key_value" })).toThrow("EMAIL_FROM");
    expect(() => loadConfig({ ...staging, RESEND_API_KEY: "re_synthetic_key_value", EMAIL_FROM: "MedVeris <no-reply@medveris.local>" })).toThrow("EMAIL_FROM");
    const config = loadConfig({ ...staging, RESEND_API_KEY: "re_synthetic_key_value", EMAIL_FROM: "MedVeris <no-reply@mail.example.org>" });
    expect(config.emailAdapter).toBe("resend");
    expect(loadConfig({ ...strong, APP_ENV: "development", EMAIL_ADAPTER: "resend" }).emailAdapter).toBe("resend");
  });

  it("requires an HTTPS origin without placeholders outside local development", () => {
    expect(() => loadConfig({ ...strong, APP_ENV: "staging", APP_ORIGIN: "http://medveris.example" })).toThrow("HTTPS");
    expect(() => loadConfig({ ...strong, APP_ENV: "staging", APP_ORIGIN: "https://medveris-staging.REPLACE_WITH_X.workers.dev" }))
      .toThrow("placeholder");
    expect(() => loadConfig({ ...strong, APP_ENV: "staging", APP_ORIGIN: "https://medveris.example/app" })).toThrow("origin");
    expect(() => loadConfig({ ...strong, APP_ENV: "staging" })).toThrow("APP_ORIGIN is required");
  });
});
