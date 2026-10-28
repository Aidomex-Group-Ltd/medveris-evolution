import { Hono } from "hono";
import { breakerSnapshots, withTimeout } from "@medveris/platform";
import { DatabaseRouter } from "@medveris/db";
import { withPlatformActor } from "../auth/middleware.js";
import { requestLatency } from "../lib/observability.js";
import type { AppEnv } from "../types.js";

export const opsRoutes = new Hono<AppEnv>();

const READY_TIMEOUT_MS = 2_000;

/**
 * Liveness answers without touching dependencies. Readiness checks the primary within a short
 * timeout and reports replica and dependency breaker states by name only; it never includes
 * hosts, errors or configuration.
 */
opsRoutes.get("/health/ready", async (c) => {
  const deps = c.get("deps");
  const router = deps.db ?? DatabaseRouter.primaryOnly(deps.sql);
  let database: "reachable" | "unreachable" = "unreachable";
  try {
    await withTimeout("health.primary", READY_TIMEOUT_MS, () => deps.sql`select 1 as ok`);
    database = "reachable";
  } catch {
    database = "unreachable";
  }
  const replica = router.hasReplica()
    ? await withTimeout("health.replica", READY_TIMEOUT_MS, () => router.refreshReplicaStatus()).then((status) => status.state, () => "unknown")
    : "absent";
  const dependencies = Object.fromEntries(breakerSnapshots().map((breaker) => [breaker.name, breaker.state]));
  const ready = database === "reachable";
  return c.json({ status: ready ? "ready" : "unavailable", database, replica, dependencies }, ready ? 200 : 503);
});

/** Operational snapshot for platform operators: aggregate counts and states only, no tenant or patient data. */
opsRoutes.get("/ops/status", async (c) => {
  const deps = c.get("deps");
  const router = deps.db ?? DatabaseRouter.primaryOnly(deps.sql);
  const backlog = await withPlatformActor(c, (tx) => tx`select * from app.outbox_backlog()`);
  const replica = router.hasReplica() ? await router.refreshReplicaStatus() : router.replicaStatus();
  return c.json({
    generatedAt: new Date().toISOString(),
    scope: "Counters and latency are for the instance that answered; queue backlog is global.",
    outbox: backlog.map((row) => ({ status: row.status, events: Number(row.events), oldestSeconds: Math.round(Number(row.oldestSeconds ?? 0)), maxAttempts: Number(row.maxAttempts ?? 0) })),
    database: { replica: { state: replica.state, lagMs: replica.lagMs, reason: replica.reason } },
    shards: deps.shards ? { mode: deps.shards.topology.mode, version: deps.shards.topology.version, shards: Object.keys(deps.shards.topology.shards) } : null,
    breakers: breakerSnapshots(),
    latency: requestLatency(),
    features: {
      realtime: deps.config.realtime.enabled && Boolean(deps.realtime),
      distributedRateLimit: Boolean(deps.rateLimiter),
    },
  });
});
