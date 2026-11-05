export interface AiModelConfig {
  provider: "workers-ai" | "ollama";
  model: string;
  inputTokensMax: number;
  timeoutMs: number;
}

export interface AiRunInput {
  model: string;
  prompt: string;
  system?: string;
  context?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens: number;
  temperature?: number;
}

export interface AiRunOutput {
  text: string;
  tokens_used?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface AiRunResult {
  ok: boolean;
  output: AiRunOutput | null;
  provider: "workers-ai" | "ollama" | "unconfigured" | "fallback";
  latencyMs: number | null;
  error: { code: string; message: string } | null;
  usage: Record<string, number | string | null> | null;
}
