import { describe, expect, it } from "vitest";
import { loadConfig, refuseSandboxInProduction } from "../../apps/api/src/config.js";
import { integrationStatus, isIntegrationOperational, isIntegrationAvailable } from "../../apps/api/src/integrations/registry.js";

describe("sandbox modes and constraints", () => {
  it("refuses sandbox mode in production", () => {
    const env = {
      APP_ENV: "production",
      SESSION_SECRET: "a".repeat(32),
      AUDIT_SIGNING_KEY: "b".repeat(32),
      MFA_ENCRYPTION_KEY: "c".repeat(32),
      APP_ORIGIN: "https://medveris.example",
      AI_MODE: "sandbox",
    };
    expect(() => refuseSandboxInProduction(env, "production")).toThrow("AI_MODE=sandbox is not allowed in production");
  });

  it("never reports a sandbox integration as available", () => {
    const config = loadConfig({
      APP_ENV: "test",
      APP_ORIGIN: "http://localhost:5173",
      FEATURE_AI: "true",
      AI_MODE: "sandbox",
      OLLAMA_URL: "http://localhost:11434",
    });
    const status = integrationStatus(config, "ai");
    expect(status.state).toBe("sandbox");
    expect(isIntegrationAvailable(config, "ai")).toBe(false);
    expect(isIntegrationOperational(config, "ai")).toBe(true);
  });
});
