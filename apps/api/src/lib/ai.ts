import { runAi, type AiDependencies, type AiModelConfig, type AiRunResult } from "@medveris/ai";
import { config } from "../config.js";
import type { AppDeps } from "../types.js";

export const AI_MODEL_CONFIG: AiModelConfig = {
  provider: "workers-ai",
  model: config.ai.model,
  inputTokensMax: config.ai.inputTokensMax,
  timeoutMs: config.ai.timeoutMs,
};

export function aiDependencies(deps: AppDeps): AiDependencies {
  return {
    ai: deps.config.ai.enabled && deps.ai ? deps.ai : undefined,
    logAiRun(result: AiRunResult, meta: Record<string, string | number | null>) {
      deps.logAiRun?.(result, meta);
    },
  };
}

export async function runClinicalAi(
  deps: AppDeps,
  request: { taskType: string; patientId: string; evidenceEntryIds: string[]; studyId: string | null; prompt: string },
): Promise<AiRunResult> {
  const meta = {
    taskType: request.taskType,
    tenantId: deps.auth?.activeTenant?.id ?? null,
    patientId: request.patientId,
    evidenceEntryCount: request.evidenceEntryIds.length,
    studyId: request.studyId ?? null,
  };
  return runAi(aiDependencies(deps), AI_MODEL_CONFIG, {
    model: AI_MODEL_CONFIG.model,
    prompt: request.prompt,
    max_tokens: config.ai.maxTokens,
    temperature: config.ai.temperature,
  }, meta);
}
