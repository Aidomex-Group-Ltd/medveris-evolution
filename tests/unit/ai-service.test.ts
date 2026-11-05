import { describe, expect, it, vi } from "vitest";
import { normalizeAiUsage, runAi } from "@medveris/ai";
import type { AiDependencies, AiModelConfig, AiRunInput, AiRunResult } from "@medveris/ai";

const config: AiModelConfig = {
  provider: "workers-ai",
  model: "@cf/meta/llama-3.1-8b-instruct-fp8",
  inputTokensMax: 128,
  timeoutMs: 100,
};

function collector(): { deps: AiDependencies; runs: AiRunResult[] } {
  const runs: AiRunResult[] = [];
  return {
    runs,
    deps: {
      logAiRun(result, _meta) {
        runs.push(result);
      },
    },
  };
}

describe("central AI service", () => {
  it("degrades to unconfigured, without throwing, when no binding is available", async () => {
    const { deps, runs } = collector();
    const result = await runAi(deps, config, { model: config.model, prompt: "hello", max_tokens: 16 }, { tenantId: "t1" });
    expect(result).toMatchObject({ ok: false, provider: "unconfigured", output: null, latencyMs: null });
    expect(result.error?.code).toBe("ai_unconfigured");
    expect(runs).toHaveLength(1);
  });

  it("returns validated output and normalized usage from the binding", async () => {
    const { deps, runs } = collector();
    const run = vi.fn(async () => ({ text: "Summary for review", usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }));
    const result = await runAi({ ...deps, ai: { run } }, config, {
      model: config.model, prompt: "hello", max_tokens: 16,
    }, { tenantId: "t1" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, provider: "workers-ai", error: null });
    expect(result.output?.text).toBe("Summary for review");
    expect(result.output?.tokens_used).toBe(7);
    expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(runs).toHaveLength(1);
  });

  it("truncates oversized prompts and context and clamps generation parameters", async () => {
    const { deps } = collector();
    const run = vi.fn(async (input: AiRunInput) => ({ text: input.prompt.length > 0 ? "ok" : "" }));
    await runAi({ ...deps, ai: { run } }, { ...config, inputTokensMax: 10 }, {
      model: config.model,
      prompt: "x".repeat(1_000),
      system: "s".repeat(1_000),
      context: [{ role: "user", content: "c".repeat(1_000) }, { role: "not-a-role" as never, content: "drop" }],
      max_tokens: 999,
      temperature: -1,
    }, { tenantId: "t1" });
    const input = run.mock.calls[0]![0];
    expect(input.prompt).toHaveLength(40);
    expect(input.system).toHaveLength(40);
    expect(input.context).toHaveLength(1);
    expect(input.context?.[0]?.content).toHaveLength(40);
    expect(input.max_tokens).toBe(10);
    expect(input.temperature).toBe(0.2);
  });

  it("retries an empty response and reports the failure once", async () => {
    const { deps, runs } = collector();
    const run = vi.fn(async () => ({ text: "   " }));
    const result = await runAi({ ...deps, ai: { run } }, config, { model: config.model, prompt: "hello", max_tokens: 16 }, { tenantId: "t1" });
    expect(run).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, provider: "workers-ai", output: null });
    expect(result.error?.code).toBe("ai_inference_failed");
    expect(result.error?.message).toContain("ai_empty_output");
    expect(runs).toHaveLength(1);
  });

  it("retries a thrown inference error and never leaks the failure to the caller", async () => {
    const { deps } = collector();
    const run = vi.fn(async () => { throw new Error("model unavailable"); });
    const result = await runAi({ ...deps, ai: { run } }, config, { model: config.model, prompt: "hello", max_tokens: 16 }, { tenantId: "t1" });
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("model unavailable");
  });

  it("enforces the per-attempt timeout", async () => {
    const { deps } = collector();
    const run = vi.fn(() => new Promise<never>(() => undefined));
    const result = await runAi({ ...deps, ai: { run } }, { ...config, timeoutMs: 5 }, {
      model: config.model, prompt: "hello", max_tokens: 16,
    }, { tenantId: "t1" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("ai_timeout");
  });

  it("normalizes the usage shapes Cloudflare and providers return", () => {
    expect(normalizeAiUsage({ tokens: 12 })).toEqual({ total_tokens: 12 });
    expect(normalizeAiUsage({ usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })).toEqual({
      input_tokens: 1, output_tokens: 2, total_tokens: 3,
    });
    expect(normalizeAiUsage({ usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 } })).toEqual({
      prompt_tokens: 18, completion_tokens: 2, total_tokens: 20,
    });
    expect(normalizeAiUsage(null)).toEqual({});
    expect(normalizeAiUsage({ unrelated: "value" })).toEqual({});
  });
});
