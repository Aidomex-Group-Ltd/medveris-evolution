import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import {
  IMPLEMENTED_ADAPTERS,
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
      ai: "unavailable", payments: "unavailable", publicHealth: "unavailable", ehmis: "not_requested", nhfr: "unavailable",
      ledgerAnchoring: "not_requested",
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
      expect(status.adapterImplemented).toBe(IMPLEMENTED_ADAPTERS.has(status.id) || status.id === "ehmis");
      expect(status.missingPrerequisites.length).toBeGreaterThan(0);
      expect(status.remediation.length).toBeGreaterThan(20);
      expect(status.capabilities.every((capability) => capability.status === status.state)).toBe(true);
    }
  });

  it("keeps the eHMIS connector misconfigured until the deployment authorization is recorded", () => {
    const missing = integrationStatus(loadConfig({ ...base, FEATURE_EHMIS: "true" }), "ehmis");
    expect(missing.state).toBe("misconfigured");
    expect(missing.reason).toContain("EHMIS_DEPLOYMENT_AUTHORIZATION_REF");
    const configured = integrationStatus(loadConfig({
      ...base, FEATURE_EHMIS: "true", EHMIS_DEPLOYMENT_AUTHORIZATION_REF: "MOH/DHI/EMRS/TEST-0001", EHMIS_CREDENTIALS_KEY: "k".repeat(40),
    }), "ehmis");
    expect(configured.state).toBe("available");
    expect(configured.reason).toContain("Each facility still needs verified eligibility");
    expect(configured.missingPrerequisites).toContain("per-facility connection test");
  });

  it("makes Yo! mobile money available only when requested and fully configured", () => {
    const partial = integrationStatus(loadConfig({ ...base, FEATURE_PAYMENTS: "true", YO_MODE: "sandbox", YO_API_USERNAME: "u", YO_API_PASSWORD: "p" }), "payments");
    expect(partial.state).toBe("misconfigured");
    expect(partial.reason).toContain("YO_PUBLIC_KEY");
    const configured = integrationStatus(loadConfig({
      ...base, FEATURE_PAYMENTS: "true", YO_MODE: "sandbox", YO_API_USERNAME: "u", YO_API_PASSWORD: "p",
      YO_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\\nMIIB\\n-----END PUBLIC KEY-----",
    }), "payments");
    expect(configured).toMatchObject({ state: "available", adapterImplemented: true, enabledForEnvironment: true });
    expect(integrationStatus(loadConfig({ ...base, YO_MODE: "sandbox" }), "payments").state).toBe("unavailable");
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
