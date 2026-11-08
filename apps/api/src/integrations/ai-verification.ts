import type { AppConfig } from "../config.js";
import { createLiveOllamaClient, type OllamaConnectionStatus } from "./ollama.js";
import { loadVerifications, recordVerification, type VerificationRun } from "./verification.js";
import { type VerificationCheck } from "./verification.js";
import { type IntegrationId } from "./registry.js";
import type { Sql, Tx } from "@medveris/db";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { status: OllamaConnectionStatus; expiresAt: number }>();

export function clearAiStatusCache(): void {
  cache.clear();
}

function aiCacheKey(config: AppConfig): string {
  return `ai|${config.appEnv}|${config.ai.baseUrl}|${config.aiModel.model}`;
}

export async function loadAiStatus(sql: Sql | Tx, config: AppConfig): Promise<OllamaConnectionStatus | null> {
  if (!config.features.ai || !config.ai.baseUrl) return null;
  const key = aiCacheKey(config);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  try {
    const verification = await loadVerifications(sql, config);
    const record = verification.ai;
    if (record && record.outcome === "passed" && record.mode === "live") {
      const client = createLiveOllamaClient({
        baseUrl: config.ai.baseUrl,
        token: config.ai.token,
        model: config.aiModel.model,
        timeoutMs: config.aiModel.timeoutMs,
        provider: "ollama",
      });
      // Refresh the runtime status from the server so status reflects the current inventory.
      const status = await client.verifyConnection();
      cache.set(key, { status, expiresAt: Date.now() + CACHE_TTL_MS });
      return status;
    }
  } catch {
    // Fail closed: treat as unverified.
  }
  return null;
}

export async function runAiVerification(
  sql: Sql | Tx,
  config: AppConfig,
  runBy: string,
  startedAt: Date,
): Promise<VerificationRun> {
  if (!config.ai.baseUrl) {
    return { outcome: "failed", checks: [{ name: "configuration", passed: false, detail: "AI_BASE_URL is not set", durationMs: 0 }] };
  }
  const client = createLiveOllamaClient({
    baseUrl: config.ai.baseUrl,
    token: config.ai.token,
    model: config.aiModel.model,
    timeoutMs: Math.max(5_000, Math.min(config.aiModel.timeoutMs, 60_000)),
    provider: "ollama",
  });
  const checks: VerificationCheck[] = [];
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, passed: true, detail, durationMs: Date.now() - started });
      return true;
    } catch (error) {
      checks.push({ name, passed: false, detail: error instanceof Error ? error.message : "unexpected failure", durationMs: Date.now() - started });
      return false;
    }
  };
  const done = (): VerificationRun => ({ outcome: checks.every((check) => check.passed) ? "passed" : "failed", checks });

  if (!(await step("endpoint", async () => {
    const status = await client.verifyConnection();
    if (!status.version) throw new Error("the endpoint did not return an Ollama version");
    return `Ollama ${status.version} at ${status.url}`;
  }))) return done();

  if (!(await step("model-inventory", async () => {
    const status = await client.verifyConnection();
    if (!status.models.length) throw new Error("the endpoint reported no models");
    return `${status.models.length} model(s): ${status.models.map((m) => m.name).join(", ")}`;
  }))) return done();

  if (!(await step("requested-model-present", async () => {
    const status = await client.verifyConnection();
    const requested = config.aiModel.model;
    if (!status.models.some((m) => m.name === requested || m.model === requested)) {
      throw new Error(`the configured model ${requested} is not in the server inventory`);
    }
    return `model ${requested} is present in the server inventory`;
  }))) return done();

  await recordVerification(sql, config, "ai", done(), runBy, startedAt);
  return done();
}
