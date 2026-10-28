import { createSql, DatabaseRouter, replicaMonitor, ShardRouter, type Sql } from "@medveris/db";
import { CircuitOpenError, errorFields, logEvent } from "@medveris/platform";
import { runJobsCycle } from "../../jobs/src/cycle.js";
import { syncContentFeeds } from "../../jobs/src/feeds/sync.js";
import { consumeDeadLetters, consumeJobBatch, type QueueBatch } from "../../jobs/src/queue.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createApp } from "./app.js";
import { ResendEmailAdapter, UnconfiguredEmailAdapter } from "./lib/email.js";
import { R2Storage, UnconfiguredStorage } from "./lib/storage.js";
import { edgeCached, type CacheStore } from "./lib/edge-cache.js";
import { DATABASE_RETRY_AFTER_SECONDS, DatabaseUnavailableSignal, needsDatabase, primaryDatabaseBreaker } from "./lib/db-health.js";
import { CoordinatedRateLimiter, LocalRateLimiter } from "./lib/rate-limit.js";
import { DurableRealtimePublisher } from "./realtime/publisher.js";
import { handleRealtimeUpgrade, isRealtimeUpgrade } from "./realtime/upgrade.js";
import type { EmailAdapter } from "./lib/email.js";
import type { StorageAdapter } from "./lib/storage.js";
import type { AppDeps, AppEnv, RequestState } from "./types.js";
import type { Hono } from "hono";
import { bindingProblems, isLocalEnvironment, withVersionHeader, type WorkerEnv } from "./worker-support.js";

// workerd treats every named export of the entry module as an entrypoint, so only handlers and
// Durable Object classes are exported here; helpers live in worker-support.ts.
export { RateLimiterObject } from "./durable/rate-limiter.js";
export { RealtimeHub } from "./durable/realtime-hub.js";
export type { WorkerEnv } from "./worker-support.js";

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Runtime {
  config: AppConfig;
  email: EmailAdapter;
  storage: StorageAdapter;
  shards: ShardRouter;
  rateLimiter: CoordinatedRateLimiter;
  realtime: DurableRealtimePublisher | null;
  app: Hono<AppEnv>;
}

const JOBS_MAX_EVENTS_PER_RUN = 200;
const FEED_SOURCES_PER_RUN = 2;

// Holds configuration and the router only. Database clients own sockets, which Workers
// cannot reuse across requests, so they are created per request below.
let runtime: Runtime | null = null;
const localLimiter = new LocalRateLimiter();

function envString(env: WorkerEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
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
  const problems = bindingProblems(env, config);
  if (problems.length) throw new Error(problems.join("; "));
  const email: EmailAdapter =
    config.emailAdapter === "resend" ? new ResendEmailAdapter(config.resendApiKey, config.emailFrom) : new UnconfiguredEmailAdapter();
  const storage: StorageAdapter = env.UPLOADS ? new R2Storage(env.UPLOADS as never) : new UnconfiguredStorage();
  return {
    config,
    email,
    storage,
    shards: new ShardRouter(config.shardTopology),
    rateLimiter: new CoordinatedRateLimiter(env.RATE_LIMITER ?? null, localLimiter, config.rateLimit.overrides),
    realtime: env.REALTIME ? new DurableRealtimePublisher(env.REALTIME) : null,
    app: createApp({ config, email, storage }),
  };
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

function databaseUnavailable(retryAfterMs: number): Response {
  return new Response(
    JSON.stringify({ error: { code: "database_unavailable", message: "The service is temporarily unavailable. Try again shortly." } }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store, private",
        "retry-after": String(Math.max(DATABASE_RETRY_AFTER_SECONDS, Math.ceil(retryAfterMs / 1000))),
      },
    },
  );
}

function cacheStore(): CacheStore | null {
  const caches = (globalThis as unknown as { caches?: { default?: CacheStore } }).caches;
  return caches?.default ?? null;
}

async function serveApp(request: Request, env: WorkerEnv, ctx: WorkerContext, current: Runtime): Promise<Response> {
  const sql = createSql(runtimeConnectionString(env), { max: 5 });
  const replica = current.config.database.replicaEnabled && env.HYPERDRIVE_REPLICA
    ? createSql(env.HYPERDRIVE_REPLICA.connectionString, { max: 3, connectTimeoutSeconds: 5 })
    : null;
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
    const options = {
      maxLagMs: current.config.database.replicaMaxLagMs,
      healthTtlMs: current.config.database.replicaHealthTtlMs,
      healthTimeoutMs: current.config.database.replicaHealthTimeoutMs,
    };
    const db = replica ? new DatabaseRouter(sql, replica, replicaMonitor("HYPERDRIVE_REPLICA", options), options) : DatabaseRouter.primaryOnly(sql);
    const requestDeps: AppDeps = {
      sql,
      db,
      shards: current.shards,
      rateLimiter: current.rateLimiter,
      realtime: current.realtime ?? undefined,
      config: current.config,
      email: current.email,
      storage: current.storage,
    };
    const requestState: RequestState = { databaseUnavailable: false };
    const response = await current.app.fetch(request, { requestDeps, requestState, waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) });
    if (requestState.databaseUnavailable) throw new DatabaseUnavailableSignal(response);
    return response;
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
    if (replica) ctx.waitUntil(replica.end({ timeout: 5 }));
  }
}

async function handleFetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
  let current: Runtime;
  try {
    current = getRuntime(env);
  } catch (error) {
    console.error(JSON.stringify({ event: "worker_error", message: (error as Error).message }));
    return misconfigured();
  }
  if (isRealtimeUpgrade(request)) {
    const sql = createSql(runtimeConnectionString(env), { max: 1 });
    try {
      return await handleRealtimeUpgrade(request, { sql, config: current.config, hubs: env.REALTIME ?? null });
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  }
  const keyVersion = `${env.CF_VERSION_METADATA?.id ?? "dev"}:${current.config.cache.keyEpoch}`;
  return edgeCached(
    request,
    { store: cacheStore(), keyVersion, waitUntil: (promise) => ctx.waitUntil(promise), sampleRate: current.config.observability.requestLogSampleRate },
    async (originRequest) => {
      if (!needsDatabase(new URL(originRequest.url).pathname)) return serveApp(originRequest, env, ctx, current);
      const breaker = primaryDatabaseBreaker();
      try {
        return await breaker.execute(() => serveApp(originRequest, env, ctx, current));
      } catch (error) {
        if (error instanceof DatabaseUnavailableSignal) return error.response;
        if (error instanceof CircuitOpenError) return databaseUnavailable(error.retryAfterMs);
        throw error;
      }
    },
  );
}

function jobsSql(env: WorkerEnv): Sql {
  const connectionString = env.HYPERDRIVE_JOBS?.connectionString;
  if (!connectionString) throw new Error("HYPERDRIVE_JOBS binding is required for scheduled jobs");
  return createSql(connectionString, { max: 2 });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    return withVersionHeader(await handleFetch(request, env, ctx), env);
  },

  async scheduled(_controller: unknown, env: WorkerEnv, ctx: WorkerContext): Promise<void> {
    const config = loadConfig(env as Record<string, string | undefined>);
    const sql = jobsSql(env);
    try {
      await assertExpectedDatabase(env, sql);
      const result = await runJobsCycle(sql, config.auditSigningKey, config.auditSigningKeyId, {
        maxEvents: JOBS_MAX_EVENTS_PER_RUN,
        producer: env.JOBS_QUEUE ?? null,
        realtime: env.REALTIME && config.realtime.enabled ? new DurableRealtimePublisher(env.REALTIME) : null,
        realtimeEventTypes: config.realtime.eventTypes,
        relayBatchSize: config.jobs.relayBatchSize,
        perTenantBatchLimit: config.jobs.perTenantBatchLimit,
      });
      if (result.checkpointError) {
        console.error(JSON.stringify({ event: "checkpoint_failed", message: result.checkpointError }));
      }
      console.log(JSON.stringify({
        event: "jobs_cycle",
        processed: result.processed,
        relayed: result.relay?.published ?? 0,
        relayFailed: result.relay?.failed ?? 0,
        reclaimed: result.reclaimed.processing + result.reclaimed.queued,
        checkpoints: result.checkpoints.map((checkpoint) => ({ tenant: checkpoint.tenantId, batch: checkpoint.batchNumber, count: checkpoint.eventCount })),
      }));
      if (config.contentFeedsEnabled) {
        try {
          const feeds = await syncContentFeeds(sql, { maxSources: FEED_SOURCES_PER_RUN });
          if (feeds.length) console.log(JSON.stringify({ event: "content_feeds", sources: feeds }));
        } catch (error) {
          console.error(JSON.stringify({ event: "content_feeds_failed", message: (error as Error).message }));
        }
      }
      if (result.checkpointError) throw new Error("Integrity checkpoint failed");
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },

  /** Consumers for the jobs queue and its dead-letter queue (queue names end in -dlq). */
  async queue(batch: QueueBatch, env: WorkerEnv, ctx: WorkerContext): Promise<void> {
    const config = loadConfig(env as Record<string, string | undefined>);
    const sql = jobsSql(env);
    try {
      await assertExpectedDatabase(env, sql);
      if (batch.queue.endsWith("-dlq")) {
        const recorded = await consumeDeadLetters(batch, sql);
        logEvent("warn", "dead_letter_batch", { queue: batch.queue, messages: batch.messages.length, recorded });
        return;
      }
      const counts = await consumeJobBatch(batch, {
        sql,
        dlq: env.JOBS_DLQ ?? null,
        realtime: env.REALTIME && config.realtime.enabled ? new DurableRealtimePublisher(env.REALTIME) : null,
        realtimeEventTypes: config.realtime.eventTypes,
      });
      logEvent("info", "job_batch", { queue: batch.queue, messages: batch.messages.length, ...counts });
    } catch (error) {
      // Unacknowledged messages are redelivered by the queue with its retry policy.
      logEvent("error", "job_batch_failed", { queue: batch.queue, messages: batch.messages.length, ...errorFields(error, false) });
      throw error;
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};
