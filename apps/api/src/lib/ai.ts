import { runAi, type AiDependencies, type AiRunResult } from "@medveris/ai";
import type { AppDeps } from "../types.js";
import type { AuthContext } from "../types.js";

export function aiDependencies(deps: AppDeps): AiDependencies {
  return {
    ai: deps.config.features.ai && deps.ai ? deps.ai : undefined,
    logAiRun(result: AiRunResult, meta: Record<string, string | number | null>) {
      deps.logAiRun?.(result, meta);
    },
  };
}

export async function runClinicalAi(
  deps: AppDeps,
  auth: AuthContext | null,
  request: { taskType: string; patientId: string; evidenceEntryIds: string[]; studyId: string | null; prompt: string },
): Promise<AiRunResult> {
  const meta = {
    taskType: request.taskType,
    tenantId: auth?.activeTenant?.id ?? null,
    patientId: request.patientId,
    evidenceEntryCount: request.evidenceEntryIds.length,
    studyId: request.studyId ?? null,
  };
  return runAi(aiDependencies(deps), deps.config.aiModel, {
    model: deps.config.aiModel.model,
    prompt: request.prompt,
    max_tokens: deps.config.aiModel.inputTokensMax,
    temperature: 0.2,
  }, meta);
}
