import { assertServableTopology } from "@medveris/db";
import type { QueueProducer } from "../../jobs/src/queue.js";
import type { AppConfig } from "./config.js";
import type { DurableObjectNamespaceLike } from "./lib/rate-limit.js";

export interface HyperdriveBinding {
  connectionString: string;
}

export interface WorkerEnv {
  /** Runtime role (medveris_runtime). Hyperdrive query caching must stay disabled. */
  HYPERDRIVE?: HyperdriveBinding;
  /** Jobs role (medveris_jobs) used only by the scheduled cycle and queue consumers. */
  HYPERDRIVE_JOBS?: HyperdriveBinding;
  /** Optional read replica (runtime role, caching disabled); used only when DB_REPLICA_ENABLED=true. */
  HYPERDRIVE_REPLICA?: HyperdriveBinding;
  UPLOADS?: unknown;
  RATE_LIMITER?: DurableObjectNamespaceLike;
  REALTIME?: DurableObjectNamespaceLike;
  JOBS_QUEUE?: QueueProducer;
  JOBS_DLQ?: QueueProducer;
  /** Workers version metadata; the blue-green deploy uses it to confirm which version answered. */
  CF_VERSION_METADATA?: { id: string; tag?: string };
  [key: string]: unknown;
}

export const VERSION_HEADER = "x-medveris-version";

export function withVersionHeader(response: Response, env: WorkerEnv): Response {
  const versionId = env.CF_VERSION_METADATA?.id;
  if (!versionId || response.status === 101) return response;
  const tagged = new Response(response.body, response);
  tagged.headers.set(VERSION_HEADER, versionId);
  return tagged;
}

function envString(env: WorkerEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

export function isLocalEnvironment(env: WorkerEnv): boolean {
  return ["development", "test"].includes(envString(env, "APP_ENV") ?? "development");
}

/**
 * Bindings are checked once per isolate. Outside local development a missing coordination
 * binding is a misconfiguration, not a reason to fall back to weaker per-isolate controls.
 */
export function bindingProblems(env: WorkerEnv, config: AppConfig): string[] {
  const problems: string[] = [];
  const local = isLocalEnvironment(env);
  const bindings = new Set(Object.keys(env).filter((key) => env[key] && typeof env[key] === "object"));
  if (local && envString(env, "DATABASE_URL")) bindings.add("HYPERDRIVE");
  try {
    assertServableTopology(config.shardTopology, bindings);
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (config.database.replicaEnabled && !env.HYPERDRIVE_REPLICA) problems.push("DB_REPLICA_ENABLED requires the HYPERDRIVE_REPLICA binding");
  if (!local && !env.RATE_LIMITER) problems.push("RATE_LIMITER Durable Object binding is required outside local development");
  if (config.realtime.enabled && !env.REALTIME) problems.push("REALTIME_ENABLED requires the REALTIME Durable Object binding");
  return problems;
}

