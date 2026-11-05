/**
 * Ollama (ollama.com) local AI model runner, used as the sandbox AI adapter.
 *
 * Ollama exposes a REST API: POST /api/chat provides a streaming or non-streaming chat completion.
 * The sandbox adapter uses non-streaming mode and maps the medveris AI inputs to Ollama's format.
 */

import type { OllamaConfig } from "../config.js";
import type { AiRunInput } from "@medveris/ai";

export class OllamaError extends Error {
  readonly retryable = true;
}

export interface OllamaClient {
  run(params: AiRunInput): Promise<unknown>;
}

export function createOllamaClient(settings: OllamaConfig): OllamaClient {
  return {
    async run(params) {
      if (!settings.url) throw new OllamaError("OLLAMA_URL is not set");
      
      const messages: Array<{ role: string; content: string }> = [];
      if (params.system) messages.push({ role: "system", content: params.system });
      if (params.context) {
        for (const msg of params.context) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: "user", content: params.prompt });

      const url = `${settings.url.replace(/\/+$/, "")}/api/chat`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
      
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: settings.model,
            messages,
            stream: false,
            options: {
              num_predict: params.max_tokens,
              temperature: params.temperature,
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.text().catch(() => "Unknown error");
          throw new OllamaError(`Ollama reported HTTP ${response.status}: ${error}`);
        }

        const payload = await response.json() as {
          message?: { content: string };
          prompt_eval_count?: number;
          eval_count?: number;
        };

        // Map Ollama response to the shape @medveris/ai expects from workers-ai
        return {
          text: payload.message?.content ?? "",
          usage: {
            input_tokens: payload.prompt_eval_count,
            output_tokens: payload.eval_count,
            total_tokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
          },
        };
      } catch (error) {
        if (error instanceof OllamaError) throw error;
        throw new OllamaError(`Ollama request failed: ${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
