import type { Sql } from "@medveris/db";
import { withContext } from "@medveris/db";
import { runAi, type AiDependencies, type AiModelConfig, type AiRunInput } from "@medveris/ai";
import { clinicalAiPrompt } from "@medveris/domain";
import { errorFields, logEvent, metric } from "@medveris/platform";
import { dispatchLocalEvent, type DispatchResult, type OutboxEvent } from "./outbox.js";

/**
 * Inference for AI jobs runs off the request path: the API only records the request and an outbox
 * event, and this handler performs the provider call. The handler claims the job atomically, so
 * retries after a crash cannot double-deliver inference work; the jobs row is the source of truth.
 * Jobs start from PHI-free prompts (task type and evidence counts only).
 */

export interface AiJobRuntime {
  ai: AiDependencies["ai"];
  providerName: AiDependencies["providerName"];
  modelConfig: AiModelConfig;
  /** Debug logging only; never logs prompts, outputs or patient data. */
  logAiRun: AiDependencies["logAiRun"];
}

export async function handleAiJobRequested(sql: Sql, runtime: AiJobRuntime | undefined, event: OutboxEvent): Promise<DispatchResult> {
  const jobId = event.aggregateId;
  if (!jobId) return { handled: true, detail: "ai-job-missing-aggregate" };
  const claimed = await withContext(sql, { actorKind: "system" }, async (tx) => tx`
    update ai_jobs set status = 'running'
     where id = ${jobId} and tenant_id = ${event.tenantId} and status = 'queued'
     returning id, task_type, evidence_entry_ids, study_id`);
  if (!claimed.length) return { handled: true, detail: "ai-job-already-claimed-or-missing" };
  const job = claimed[0]!;
  const evidenceCount = Array.isArray(job.evidenceEntryIds) ? (job.evidenceEntryIds as unknown[]).length : 0;
  const prompt = clinicalAiPrompt({ taskType: String(job.taskType), evidenceEntryIds: evidenceCount, studyId: job.studyId == null ? null : String(job.studyId) });
  if (!runtime) {
    await withContext(sql, { actorKind: "system" }, async (tx) => tx`
      update ai_jobs set status = 'failed', completed_at = now(), response_summary = null
       where id = ${jobId} and tenant_id = ${event.tenantId}`);
    return { handled: true, detail: "ai-job-runtime-not-configured" };
  }
  try {
    const result = await runAi(
      { ai: runtime.ai ?? null, providerName: runtime.providerName, logAiRun: runtime.logAiRun },
      runtime.modelConfig,
      {
        model: runtime.modelConfig.model,
        prompt,
        max_tokens: Math.max(1, Math.min(runtime.modelConfig.inputTokensMax, 1024)),
        temperature: 0.2,
      },
      { taskType: String(job.taskType), evidenceEntryCount: evidenceCount, studyReference: job.studyId == null ? null : "provided" },
    );
    const ok = result.ok;
    const summary = ok ? (result.output?.text?.trim() || null) : null;
    await withContext(sql, { actorKind: "system" }, async (tx) => tx`
      update ai_jobs set status = ${ok ? "completed" : "failed"}, provider = ${result.provider}, model = ${runtime.modelConfig.model},
        response_summary = ${summary}, completed_at = now()
       where id = ${jobId} and tenant_id = ${event.tenantId}`);
    metric("ai.job.completed", 1, { ok: ok ? "true" : "false", provider: result.provider });
    return { handled: true, detail: ok ? "ai-job-completed" : "ai-job-inference-failed" };
  } catch (error) {
    logEvent("error", "ai_job_failed", errorFields(error, false));
    await withContext(sql, { actorKind: "system" }, async (tx) => tx`
      update ai_jobs set status = 'failed', completed_at = now()
       where id = ${jobId} and tenant_id = ${event.tenantId}`).catch(() => undefined);
    // Retryable outage: surface to the outbox so the dead-letter path applies if it keeps failing.
    throw error;
  }
}

export function aiAwareDispatch(sql: Sql, runtime: AiJobRuntime | undefined): (event: OutboxEvent) => Promise<DispatchResult> {
  return async (event: OutboxEvent) =>
    event.eventType === "ai.job.requested" ? handleAiJobRequested(sql, runtime, event) : dispatchLocalEvent(event);
}

/**
 * Local/dev runner factory: AI inference only when AI_MODE=sandbox and OLLAMA_URL is set.
 * Production wiring happens in apps/api/src/worker.ts from the loaded config.
 */
export function aiRuntimeFromEnv(env: NodeJS.ProcessEnv): AiJobRuntime | undefined {
  if ((env.AI_MODE ?? "off").toLowerCase() !== "sandbox") return undefined;
  const url = (env.OLLAMA_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return undefined;
  const timeoutMs = Math.max(1_000, Math.min(Number(env.OLLAMA_TIMEOUT_MS ?? 60_000) || 60_000, 300_000));
  const model = (env.OLLAMA_MODEL ?? "llama3.2").trim() || "llama3.2";
  return {
    ai: {
      async run(params: AiRunInput) {
        const messages = [{ role: "user", content: params.prompt }];
        if (params.system) messages.unshift({ role: "system", content: params.system });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${url}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, messages, stream: false, options: { num_predict: params.max_tokens, temperature: params.temperature } }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Ollama reported HTTP ${response.status}`);
          const payload = (await response.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
          return {
            text: payload.message?.content ?? "",
            usage: { input_tokens: payload.prompt_eval_count, output_tokens: payload.eval_count, total_tokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0) },
          };
        } finally {
          clearTimeout(timer);
        }
      },
    },
    providerName: "ollama",
    modelConfig: { provider: "ollama", model, inputTokensMax: Math.max(64, Number(env.AI_INPUT_TOKENS_MAX ?? 4096) || 4096), timeoutMs },
    logAiRun: () => undefined,
  };
}
