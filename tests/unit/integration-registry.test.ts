import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import {
  IntegrationUnavailableError,
  assertIntegrationAvailable,
  integrationStatus,
  listIntegrations,
} from "../../apps/api/src/integrations/registry.js";

const base = { APP_ENV: "test", APP_ORIGIN: "http://localhost:5173" };

describe("integration availability registry", () => {
  it("reports the approved baseline with no integration available", () => {
    const states = Object.fromEntries(listIntegrations(loadConfig(base)).map((integration) => [integration.id, integration.state]));
    expect(states).toEqual({
      dicomweb: "unavailable", lab: "unavailable", pharmacy: "unavailable", telemedicine: "unavailable", devices: "unavailable",
      ai: "unavailable", payments: "unavailable", publicHealth: "unavailable", ledgerAnchoring: "not_requested",
    });
  });

  it("never treats a feature flag as availability", () => {
    const config = loadConfig({ ...base, FEATURE_DEVICES: "true", FEATURE_PAYMENTS: "true" });
    for (const id of ["devices", "payments"] as const) {
      const status = integrationStatus(config, id);
      expect(status.state).toBe("misconfigured");
      expect(status.requested).toBe(true);
      expect(status.enabledForEnvironment).toBe(false);
      expect(status.reason).toContain("no");
    }
  });

  it("exposes truthful verification metadata and remediation", () => {
    for (const status of listIntegrations(loadConfig(base))) {
      expect(status.lastSuccessfulVerificationAt).toBeNull();
      expect(status.lastVerificationOutcome).toBe("never-verified");
      expect(status.adapterImplemented).toBe(false);
      expect(status.missingPrerequisites.length).toBeGreaterThan(0);
      expect(status.remediation.length).toBeGreaterThan(20);
      expect(status.capabilities.every((capability) => capability.status === status.state)).toBe(true);
    }
  });

  it("refuses operations with a typed, non-retryable unavailable error", () => {
    const config = loadConfig(base);
    let error: unknown;
    try {
      assertIntegrationAvailable(config, "ai", "ai.job.create", "no inference was produced");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IntegrationUnavailableError);
    const typed = error as IntegrationUnavailableError;
    expect(typed.status).toBe(503);
    expect(typed.code).toBe("integration_unavailable");
    expect(typed.message).toContain("no inference was produced");
    expect(typed.details).toMatchObject({ integration: "ai", operation: "ai.job.create", state: "unavailable", retryable: false });
  });
});
