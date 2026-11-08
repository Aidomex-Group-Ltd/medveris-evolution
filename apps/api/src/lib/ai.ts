import { runAi, type AiDependencies, type AiRunResult } from "@medveris/ai";
import { createOllamaClient, createLiveOllamaClient } from "../integrations/ollama.js";
import type { AppDeps } from "../types.js";
import type { AuthContext } from "../types.js";

export function aiDependencies(deps: AppDeps): AiDependencies {
  const mode = deps.config.modes.ai;
  if (mode === "sandbox") {
    // Sandbox is explicitly refused in production and is never reported as available.
    return {
      ai: createOllamaClient(deps.config.ollama),
      providerName: "ollama",
      logAiRun(result, meta) {
        deps.logAiRun?.(result, { ...meta, simulated: "true", source: "sandbox:ollama" });
      },
    };
  }

  // Live Ollama provider path: used when the operator has configured a real HTTPS Ollama endpoint
  // for the AI integration and the feature is requested. This is a distinct path from the sandbox
  // adapter above, and it is authenticated with AI_TOKEN (Worker secret in staging/production).
  if (deps.config.features.ai && deps.config.ai.baseUrl) {
    const client = createLiveOllamaClient({
      baseUrl: deps.config.ai.baseUrl,
      token: deps.config.ai.token,
      model: deps.config.aiModel.model,
      timeoutMs: deps.config.aiModel.timeoutMs,
      provider: "ollama",
    });
    return {
      ai: client,
      providerName: "ollama",
      logAiRun(result: AiRunResult, meta: Record<string, string | number | null>) {
        deps.logAiRun?.(result, { ...meta, simulated: undefined, source: "live:ollama" });
      },
    };
  }

  return {
    ai: deps.config.features.ai && deps.ai ? deps.ai : undefined,
    providerName: "workers-ai",
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
