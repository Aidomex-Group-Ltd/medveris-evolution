import type { AiModelConfig, AiRunInput, AiRunOutput, AiRunResult } from "./types.js";

export interface AiDependencies {
  ai?: { run: (params: AiRunInput) => Promise<unknown> } | null;
  logAiRun(result: AiRunResult, meta: Record<string, string | number | null>): void;
}

const MAX_TOKEN_UNITS = ["token", "tokens"];

export function normalizeAiUsage(raw: unknown): Record<string, number | string | null> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number | string | null> = {};
  const r = raw as Record<string, unknown>;
  if (typeof r.input_tokens === "number") out.input_tokens = r.input_tokens;
  if (typeof r.output_tokens === "number") out.output_tokens = r.output_tokens;
  if (typeof r.total_tokens === "number") out.total_tokens = r.total_tokens;
  if (typeof r.prompt_tokens === "number") out.prompt_tokens = r.prompt_tokens;
  if (typeof r.completion_tokens === "number") out.completion_tokens = r.completion_tokens;
  if (typeof r.tokens === "number") out.total_tokens = r.tokens;
  if (typeof r.usage === "object" && r.usage !== null) {
    const u = r.usage as Record<string, unknown>;
    if (typeof u.input_tokens === "number") out.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") out.output_tokens = u.output_tokens;
    if (typeof u.total_tokens === "number") out.total_tokens = u.total_tokens;
  }
  return out;
}

function isAiBinding(deps: AiDependencies["ai"]): deps is Required<Pick<AiDependencies, "ai">>["ai"] {
  return typeof deps === "object" && deps !== null && typeof deps.run === "function";
}

export async function runAi(
  deps: AiDependencies,
  config: AiModelConfig,
  input: AiRunInput,
  meta: Record<string, string | number | null>,
): Promise<AiRunResult> {
  const started = performance.now();
  const result: AiRunResult = {
    ok: false,
    output: null,
    provider: "unconfigured",
    latencyMs: null,
    error: null,
    usage: null,
  };

  if (!isAiBinding(deps.ai)) {
    result.provider = "unconfigured";
    result.error = { code: "ai_unconfigured", message: "Cloudflare Workers AI binding is not configured for this environment" };
    deps.logAiRun(result, meta);
    return result;
  }
  const ai = deps.ai as { run: (params: AiRunInput) => Promise<unknown> };

  const sanitized: AiRunInput = {
    model: input.model,
    prompt: String(input.prompt).slice(0, config.inputTokensMax * 4),
    system: input.system ? String(input.system).slice(0, config.inputTokensMax * 4) : undefined,
    context: input.context?.filter((c) => c && typeof c === "object" && typeof c.role === "string" && typeof c.content === "string").map((c) => ({
      role: c.role as "system" | "user" | "assistant",
      content: String(c.content).slice(0, config.inputTokensMax * 4),
    })) ?? [],
    max_tokens: Math.max(1, Math.min(config.inputTokensMax, Number.isFinite(input.max_tokens) ? input.max_tokens : 1024)),
    temperature: typeof input.temperature === "number" && Number.isFinite(input.temperature) && input.temperature >= 0 ? input.temperature : 0.2,
  };

  let lastError: Error | null = null;
  const attempts = [config.timeoutMs, config.timeoutMs, config.timeoutMs / 2];
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    try {
      const response = await Promise.race([
        ai.run(sanitized),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ai_timeout")), attempts[attempt])),
      ]);
      const payload = response as { text?: string; usage?: Record<string, unknown>; error?: { message?: string } };
      const text = typeof payload?.text === "string" ? payload.text : "";
      if (!result.ok && text.trim().length === 0) {
        lastError = new Error("ai_empty_output");
        continue;
      }
      const output: AiRunOutput = {
        text,
        tokens_used: typeof payload?.usage === "object" && payload.usage !== null ? (payload.usage as Record<string, unknown>).total_tokens as number | undefined : undefined,
      };
      if (typeof payload?.usage === "object" && payload.usage !== null) {
        const u = payload.usage as Record<string, unknown>;
        if (typeof u.input_tokens === "number") output.input_tokens = u.input_tokens;
        if (typeof u.output_tokens === "number") output.output_tokens = u.output_tokens;
        if (typeof u.total_tokens === "number") output.tokens_used = u.total_tokens;
      }
      result.ok = true;
      result.provider = "workers-ai";
      result.output = output;
      result.latencyMs = Math.round(performance.now() - started);
      result.usage = normalizeAiUsage(payload.usage ?? null);
      deps.logAiRun(result, meta);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts.length - 1) continue;
    }
  }

  result.provider = "workers-ai";
  result.error = { code: "ai_inference_failed", message: lastError ? lastError.message : "AI inference failed after retries" };
  deps.logAiRun(result, meta);
  return result;
}
