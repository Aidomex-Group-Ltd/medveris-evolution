import { createSql, type Sql } from "@medveris/db";
import { runJobsCycle } from "../../jobs/src/cycle.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createApp } from "./app.js";
import { ResendEmailAdapter, UnconfiguredEmailAdapter } from "./lib/email.js";
import { R2Storage, UnconfiguredStorage } from "./lib/storage.js";
import type { EmailAdapter } from "./lib/email.js";
import type { StorageAdapter } from "./lib/storage.js";
import type { AppDeps, AppEnv } from "./types.js";
import type { Hono } from "hono";

interface HyperdriveBinding {
  connectionString: string;
}

export interface WorkerEnv {
  /** Runtime role (medveris_runtime). Hyperdrive query caching must stay disabled. */
  HYPERDRIVE?: HyperdriveBinding;
  /** Jobs role (medveris_jobs) used only by the scheduled outbox/checkpoint cycle. */
  HYPERDRIVE_JOBS?: HyperdriveBinding;
  UPLOADS?: unknown;
  /** Workers version metadata; the blue-green deploy uses it to confirm which version answered. */
  CF_VERSION_METADATA?: { id: string; tag?: string };
  [key: string]: unknown;
}

export const VERSION_HEADER = "x-medveris-version";

export function withVersionHeader(response: Response, env: WorkerEnv): Response {
  const versionId = env.CF_VERSION_METADATA?.id;
  if (!versionId) return response;
  const tagged = new Response(response.body, response);
  tagged.headers.set(VERSION_HEADER, versionId);
  return tagged;
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Runtime {
  config: AppConfig;
  email: EmailAdapter;
  storage: StorageAdapter;
  app: Hono<AppEnv>;
}

const JOBS_MAX_EVENTS_PER_RUN = 200;

// Holds configuration and the router only. Database clients own sockets, which Workers
// cannot reuse across requests, so they are created per request below.
let runtime: Runtime | null = null;

function envString(env: WorkerEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function isLocalEnvironment(env: WorkerEnv): boolean {
  return ["development", "test"].includes(envString(env, "APP_ENV") ?? "development");
}

function runtimeConnectionString(env: WorkerEnv): string {
  const connectionString = env.HYPERDRIVE?.connectionString ?? (isLocalEnvironment(env) ? envString(env, "DATABASE_URL") : undefined);
  if (!connectionString) throw new Error("HYPERDRIVE binding is required (DATABASE_URL is accepted only in local development)");
  return connectionString;
}

let databaseVerified = false;

/** Refuses to run against any database other than EXPECTED_DATABASE_NAME when it is configured. */
async function assertExpectedDatabase(env: WorkerEnv, sql: Sql): Promise<void> {
  const expected = envString(env, "EXPECTED_DATABASE_NAME");
  if (!expected && !isLocalEnvironment(env)) throw new Error("EXPECTED_DATABASE_NAME is required outside local development");
  if (!expected) return;
  const [row] = await sql<{ name: string }[]>`select current_database() as name`;
  if (row?.name !== expected) throw new Error(`Connected database does not match EXPECTED_DATABASE_NAME (${expected})`);
}

function initialise(env: WorkerEnv): Runtime {
  runtimeConnectionString(env);
  const config = loadConfig(env as Record<string, string | undefined>);
  const email: EmailAdapter =
    config.emailAdapter === "resend" ? new ResendEmailAdapter(config.resendApiKey, config.emailFrom) : new UnconfiguredEmailAdapter();
  const storage: StorageAdapter = env.UPLOADS ? new R2Storage(env.UPLOADS as never) : new UnconfiguredStorage();
  return { config, email, storage, app: createApp({ config, email, storage }) };
}

function getRuntime(env: WorkerEnv): Runtime {
  if (!runtime) runtime = initialise(env);
  return runtime;
}

function misconfigured(): Response {
  return new Response(
    JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "exception", diagnostics: "The service is not configured correctly" }],
    }),
    { status: 503, headers: { "content-type": "application/fhir+json; charset=utf-8" } },
  );
}

async function handleFetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
  let current: Runtime;
  try {
    current = getRuntime(env);
  } catch (error) {
    console.error(JSON.stringify({ event: "worker_error", message: (error as Error).message }));
    return misconfigured();
  }
  const sql = createSql(runtimeConnectionString(env), { max: 5 });
  try {
    if (!databaseVerified) {
      try {
        await assertExpectedDatabase(env, sql);
        databaseVerified = true;
      } catch (error) {
        console.error(JSON.stringify({ event: "database_target_rejected", message: (error as Error).message }));
        return misconfigured();
      }
    }
    const requestDeps: AppDeps = { sql, config: current.config, email: current.email, storage: current.storage };
    return await current.app.fetch(request, { requestDeps });
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    return withVersionHeader(await handleFetch(request, env, ctx), env);
  },

  async scheduled(_controller: unknown, env: WorkerEnv, ctx: WorkerContext): Promise<void> {
    const connectionString = env.HYPERDRIVE_JOBS?.connectionString;
    if (!connectionString) throw new Error("HYPERDRIVE_JOBS binding is required for scheduled jobs");
    const config = loadConfig(env as Record<string, string | undefined>);
    const sql = createSql(connectionString, { max: 2 });
    try {
      await assertExpectedDatabase(env, sql);
      const result = await runJobsCycle(sql, config.auditSigningKey, config.auditSigningKeyId, { maxEvents: JOBS_MAX_EVENTS_PER_RUN });
      if (result.checkpointError) {
        console.error(JSON.stringify({ event: "checkpoint_failed", message: result.checkpointError }));
      }
      console.log(JSON.stringify({
        event: "jobs_cycle",
        processed: result.processed,
        checkpoints: result.checkpoints.map((checkpoint) => ({ tenant: checkpoint.tenantId, batch: checkpoint.batchNumber, count: checkpoint.eventCount })),
      }));
      if (result.checkpointError) throw new Error("Integrity checkpoint failed");
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};
