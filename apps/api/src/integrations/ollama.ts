/**
 * Ollama AI model runner.
 *
 * Used in two distinct roles in this codebase:
 *  - Sandbox role: local/dev Ollama adapter behind OLLAMA_URL (not available in production).
 *  - Live role: production AI provider at AI_BASE_URL (HTTPS only in production), authenticated
 *    with Ollama HTTP Basic Auth (OLLAMA_USERNAME / OLLAMA_PASSWORD), with model inventory
 *    discovered from the live /api/tags endpoint. The legacy AI_TOKEN Bearer path is preserved
 *    only for other provider backends.
 *
 * Ollama exposes a REST API: POST /api/chat provides a streaming or non-streaming chat completion.
 * This client uses non-streaming mode and maps the medveris AI inputs to Ollama's format.
 */

import type { AiRunInput } from "@medveris/ai";
import type { Sql } from "@medveris/db";
import type { AppConfig, OllamaConfig } from "../config.js";
import { loadVerifications } from "./verification.js";

export class OllamaError extends Error {
  readonly retryable = true;
}

export interface OllamaClient {
  run(params: AiRunInput): Promise<unknown>;
}

/** Shape returned by Ollama /api/tags. */
export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  /** Present on newer Ollama versions. */
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
    embedding_length?: number;
    runner?: string;
  };
  capabilities?: string[];
}

export interface OllamaTagsResponse {
  models: OllamaModel[];
}

export interface OllamaVersionResponse {
  version: string;
}

/** Minimal connection summary for status reporting. */
export interface OllamaConnectionStatus {
  url: string;
  /** The Ollama server version observed during the last successful verification. */
  version: string | null;
  /** Models reported by the server during the last successful verification. Empty until verified. */
  models: OllamaModel[];
  /** When the server was last successfully verified. Null before any successful verification. */
  lastVerifiedAt: string | null;
}

function ollamaUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * HTTP Basic Auth value for Ollama requests, constructed from Worker secrets.
 * The encoded value is treated as secret material: it is never logged, never included in
 * error messages, and never returned to callers.
 */
function ollamaBasicAuth(username: string | null, password: string | null): string | null {
  if (!username || !password) return null;
  const encoded = btoa(`${username}:${password}`);
  if (!encoded) return null;
  return `Basic ${encoded}`;
}

/**
 * Authorization header value for Ollama requests. Only Basic Auth is emitted for the live
 * Ollama path; the result is intentionally free of tokens, passwords and encoded credentials
 * when they are absent or when Bearer auth is the requested transport.
 */
function basicAuthHeaders(
  username: string | null,
  password: string | null,
): Record<string, string> {
  const value = ollamaBasicAuth(username, password);
  return value ? { authorization: value } : {};
}

async function ollamaFetch(
  base: string,
  path: string,
  timeoutMs: number,
  init?: RequestInit,
  username: string | null = null,
  password: string | null = null,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const auth = path === "/api/chat" ? ollamaBasicAuth(username, password) : ollamaBasicAuth(username, password);
  const requestHeaders: HeadersInit | undefined = auth
    ? { ...(init?.headers as unknown as Record<string, string> | undefined), authorization: auth }
    : init?.headers;
  try {
    const response = await fetch(`${ollamaUrl(base)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: requestHeaders,
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "Unknown error");
      throw new OllamaError(`Ollama reported HTTP ${response.status}: ${error}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createOllamaClient(settings: OllamaConfig): OllamaClient {
  return createLiveOllamaClient({
    baseUrl: settings.url ?? "",
    token: null,
    ollamaUsername: null,
    ollamaPassword: null,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    provider: "ollama",
  });
}

/**
 * Production/discovery-capable Ollama client. Unlike the sandbox client returned by
 * `createOllamaClient`, this one is intended for a live, authenticated HTTPS endpoint and exposes
 * model discovery and connection status for status/health reporting.
 */
export function createLiveOllamaClient(settings: {
  baseUrl: string;
  token: string | null;
  ollamaUsername: string | null;
  ollamaPassword: string | null;
  model: string;
  timeoutMs: number;
  provider: "ollama";
}): OllamaClient & {
  discoverModels: () => Promise<OllamaTagsResponse>;
  verifyConnection: () => Promise<OllamaConnectionStatus>;
  status: OllamaConnectionStatus;
} {
  const status: OllamaConnectionStatus = {
    url: ollamaUrl(settings.baseUrl),
    version: null,
    models: [],
    lastVerifiedAt: null,
  };

  const client: OllamaClient & {
    discoverModels: () => Promise<OllamaTagsResponse>;
    verifyConnection: () => Promise<OllamaConnectionStatus>;
    status: OllamaConnectionStatus;
  } = {
    status,

    async run(params) {
      if (!settings.baseUrl) throw new OllamaError("AI_BASE_URL is not set");

      const messages: Array<{ role: string; content: string }> = [];
      if (params.system) messages.push({ role: "system", content: params.system });
      if (params.context) {
        for (const msg of params.context) {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
      messages.push({ role: "user", content: params.prompt });

      const url = `${ollamaUrl(settings.baseUrl)}/api/chat`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
            ...basicAuthHeaders(settings.ollamaUsername, settings.ollamaPassword),
          },
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

    async discoverModels() {
      const payload = (await ollamaFetch(settings.baseUrl, "/api/tags", settings.timeoutMs, { method: "GET" }, settings.ollamaUsername, settings.ollamaPassword)) as OllamaTagsResponse;
      return payload;
    },

    async verifyConnection() {
      let version: string | null = null;
      try {
        const payload = (await ollamaFetch(settings.baseUrl, "/api/version", settings.timeoutMs, { method: "GET" }, null, null)) as OllamaVersionResponse;
        if (payload && typeof payload.version === "string") {
          version = payload.version;
        }
      } catch {
        // Fall through: status stays unverified.
      }

      let models: OllamaModel[] = [];
      if (version) {
        try {
          const tags = await client.discoverModels();
          models = Array.isArray(tags.models) ? tags.models : [];
        } catch {
          // A model-inventory failure does not undo a successful version probe.
        }
      }

      status.version = version;
      status.models = models;
      status.lastVerifiedAt = version ? new Date().toISOString() : status.lastVerifiedAt;
      return status;
    },   };

  return client;
}

/** Returns only a verified connection status when a passing verification record exists; otherwise
 * null so callers can report "configured but not yet verified". */
export async function loadAiStatus(sql: Sql, config: AppConfig): Promise<OllamaConnectionStatus | null> {
  const verifications = await loadVerifications(sql, config);
  const ai = verifications.ai;
  if (!ai || ai.outcome !== "passed" || ai.mode === "sandbox" || !config.ai.baseUrl) return null;
  return createLiveOllamaClient({
    baseUrl: config.ai.baseUrl,
    token: config.ai.token,
    ollamaUsername: config.ai.ollamaUsername,
    ollamaPassword: config.ai.ollamaPassword,
    model: config.aiModel.model,
    timeoutMs: config.aiModel.timeoutMs,
    provider: "ollama",
  }).verifyConnection();
}

