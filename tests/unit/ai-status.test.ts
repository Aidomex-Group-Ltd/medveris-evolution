import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import { integrationStatus, aiConfigProblems } from "../../apps/api/src/integrations/registry.js";
import { loadAiStatus } from "../../apps/api/src/integrations/ollama.js";
import type { VerificationRecord } from "../../apps/api/src/integrations/registry.js";

const base = { APP_ENV: "test", APP_ORIGIN: "http://localhost:5173" };

function verifiedRecord(finishedAt: string): VerificationRecord {
  return { outcome: "passed", finishedAt, failure: null, mode: "live" };
}

describe("AI integration status reporting", () => {
  it("reports configured but unverified as misconfigured when live Basic Auth creds are missing", () => {
    const config = loadConfig({
      ...base,
      FEATURE_AI: "true",
      AI_BASE_URL: "https://ollama.medveris.online",
      
      AI_MODEL: "llama3.2",
      AI_MODE: "live",
    });
    const status = integrationStatus(config, "ai", undefined);
    expect(status.state).toBe("misconfigured");
    expect(status.enabledForEnvironment).toBe(false);
    expect(status.adapterImplemented).toBe(true);
    expect(status.capabilities[0]!.status).toBe("misconfigured");
  });

  it("reports a configured live verification as available, sandbox verification does not count", () => {
    const passed = verifiedRecord("2026-11-08T10:00:00.000Z");
    const config = loadConfig({
      ...base,
      FEATURE_AI: "true",
      AI_BASE_URL: "https://ollama.medveris.online",
      
      AI_MODEL: "llama3.2",
      AI_MODE: "live",
      OLLAMA_USERNAME: "ollama",
      OLLAMA_PASSWORD: "p".repeat(20),
    });
    const status = integrationStatus(config, "ai", passed);
    expect(status.state).toBe("available");
    expect(status.lastVerificationOutcome).toBe("passed");
    expect(status.lastSuccessfulVerificationAt).toBe("2026-11-08T10:00:00.000Z");
    expect(status.reason).toContain("Verified against the configured endpoint");
    expect(status.capabilities[0]!.status).toBe("available");

    const sandboxPassed: Parameters<typeof integrationStatus>[2] = { outcome: "passed", finishedAt: "2026-11-08T10:00:00.000Z", failure: null, mode: "sandbox" as const };
    const sandboxStatus = integrationStatus(config, "ai", sandboxPassed);
    expect(sandboxStatus.state).toBe("sandbox");
    expect(sandboxStatus.lastVerificationOutcome).toBe("passed");
  });

  it("names the live Ollama host in the mode label when configured and verified", () => {
    const config = loadConfig({
      ...base,
      FEATURE_AI: "true",
      AI_BASE_URL: "https://ollama.medveris.online",
      
      AI_MODEL: "llama3.2:1b",
      AI_MODE: "live",
    });
    const status = integrationStatus(config, "ai", verifiedRecord("2026-11-08T10:00:00.000Z"));
    expect(status.modeLabel).toContain("LIVE");
    expect(status.modeLabel).toContain("ollama.medveris.online");
    expect(status.modeLabel).toContain("Ollama model provider");
  });

  it("reports the requested model separately from the mode label", () => {
    const config = loadConfig({
      ...base,
      FEATURE_AI: "true",
      AI_BASE_URL: "https://ollama.medveris.online",
      
      AI_MODEL: "llama3.2:1b",
      AI_MODE: "live",
    });
    const status = integrationStatus(config, "ai", verifiedRecord("2026-11-08T10:00:00.000Z"));
    expect(status.requiredConfiguration.join(" ")).toContain("AI_MODEL");
  });

  it("lists the same live-ollama configuration problems as the registry", () => {
    const missingUrl = loadConfig({ ...base, FEATURE_AI: "true" });
    const missingToken = loadConfig({ ...base, FEATURE_AI: "true", AI_BASE_URL: "https://ollama.medveris.online" });
    const complete = loadConfig({
      ...base, FEATURE_AI: "true", AI_BASE_URL: "https://ollama.medveris.online",  AI_MODEL: "llama3.2",
      OLLAMA_USERNAME: "ollama", OLLAMA_PASSWORD: "p".repeat(20),
    });
    expect(aiConfigProblems(missingUrl)).toContainEqual(expect.stringContaining("AI_BASE_URL"));
    expect(aiConfigProblems(missingToken)).toContainEqual(expect.stringContaining("OLLAMA_USERNAME and OLLAMA_PASSWORD"));
    expect(aiConfigProblems(complete)).toEqual([]);
  });

  it("keeps the public status route fail-safe when the provider is not yet verified (null connection)", async () => {
    const config = loadConfig({
      ...base,
      FEATURE_AI: "true",
      AI_BASE_URL: "https://ollama.medveris.online",
      
      AI_MODEL: "llama3.2",
      AI_MODE: "live",
    });
    const connection = await loadAiStatus((vi.fn() as unknown) as Parameters<typeof loadAiStatus>[0], config);
    expect(connection).toBeNull();
  });
});
