import { Hono } from "hono";
import type { Context } from "hono";
import { breakerSnapshots, withTimeout } from "@medveris/platform";
import { DatabaseRouter } from "@medveris/db";
import { isPlatformOperator, withPlatformActor } from "../auth/middleware.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { requestLatency } from "../lib/observability.js";
import { listIntegrations } from "../integrations/registry.js";
import { loadVerifications } from "../integrations/verification.js";
import {
  CloudflareObservabilityClient,
  parseSpan,
  type ObservabilitySpan,
} from "../observability/cloudflare-client.js";
import type { AppDeps, AppEnv } from "../types.js";

/**
 * Platform observability: a read-only proxy to Cloudflare Logs/Traces/Workers metrics plus
 * local counters this deployment already records. Gated by platform_operator. The Cloudflare
 * token is only read on the server; the browser never sees it. When the token is absent every
 * Cloudflare-backed endpoint returns a structured "unavailable" envelope rather than empty
 * metrics. No PHI is requested or returned: Workers Logs are emitted through `safeFields` at
 * write time, and this proxy only surfaces roll-ups.
 */
export const platformObservabilityRoutes = new Hono<AppEnv>();

function requireOperator(c: Context<AppEnv>): void {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
}

function clientFor(deps: AppDeps): CloudflareObservabilityClient {
  if (deps.cloudflareObservability) return deps.cloudflareObservability;
  return new CloudflareObservabilityClient({
    config: {
      enabled: deps.config.cloudflare.enabled,
      apiToken: deps.config.cloudflare.apiToken,
      accountId: deps.config.cloudflare.accountId,
      timeoutMs: deps.config.cloudflare.timeoutMs,
      cacheTtlMs: deps.config.cloudflare.cacheTtlMs,
    },
  });
}

function spanParam(c: Context<AppEnv>): ObservabilitySpan {
  const raw = c.req.query("span");
  if (raw !== undefined && raw !== "1h" && raw !== "6h" && raw !== "24h" && raw !== "7d") {
    throw new ValidationError("span must be one of 1h, 6h, 24h, 7d");
  }
  return parseSpan(raw);
}

platformObservabilityRoutes.get("/platform/observability/overview", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const span = spanParam(c);
  const client = clientFor(deps);
  const router = deps.db ?? DatabaseRouter.primaryOnly(deps.sql);
  const replica = router.hasReplica() ? await router.refreshReplicaStatus() : router.replicaStatus();
  let database: "reachable" | "unreachable" = "unreachable";
  try {
    await withTimeout("observability.primary", 2_000, () => deps.sql`select 1 as ok`);
    database = "reachable";
  } catch {
    database = "unreachable";
  }
  const [scripts, invocations] = await Promise.all([client.listWorkersScripts(), client.workersInvocations(span)]);
  return c.json({
    generatedAt: new Date().toISOString(),
    span,
    configured: client.isConfigured(),
    cache: client.cacheStats(),
    local: {
      database,
      replica: { state: replica.state, lagMs: replica.lagMs, reason: replica.reason },
      breakers: breakerSnapshots(),
      latency: requestLatency(),
      features: {
        realtime: deps.config.realtime.enabled && Boolean(deps.realtime),
        distributedRateLimit: Boolean(deps.rateLimiter),
        cloudflareObservability: client.isConfigured(),
      },
    },
    cloudflare: { scripts, invocations },
  });
});

platformObservabilityRoutes.get("/platform/observability/api-metrics", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const span = spanParam(c);
  const client = clientFor(deps);
  const metrics = await client.httpMetrics(span);
  return c.json({
    generatedAt: new Date().toISOString(),
    span,
    configured: client.isConfigured(),
    local: {
      latency: requestLatency(),
      scope: "Isolate-local counters for the instance that answered; Cloudflare metrics are account-wide.",
    },
    cloudflare: metrics,
  });
});

platformObservabilityRoutes.get("/platform/observability/workers", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const span = spanParam(c);
  const client = clientFor(deps);
  const [scripts, invocations] = await Promise.all([client.listWorkersScripts(), client.workersInvocations(span)]);
  return c.json({
    generatedAt: new Date().toISOString(),
    span,
    configured: client.isConfigured(),
    scripts,
    invocations,
  });
});

platformObservabilityRoutes.get("/platform/observability/logs", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const span = spanParam(c);
  const client = clientFor(deps);
  const logs = await client.logsSummary(span);
  return c.json({
    generatedAt: new Date().toISOString(),
    span,
    configured: client.isConfigured(),
    note: "Workers Logs are emitted through privacy-safe structured events; this proxy returns invocation-level roll-ups only, never raw log bodies.",
    cloudflare: logs,
  });
});

platformObservabilityRoutes.get("/platform/observability/traces", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const span = spanParam(c);
  const client = clientFor(deps);
  const traces = await client.tracesSummary(span);
  return c.json({
    generatedAt: new Date().toISOString(),
    span,
    configured: client.isConfigured(),
    note: "Trace roll-ups from Cloudflare Workers Observability; span payloads are not proxied.",
    cloudflare: traces,
  });
});

const SPAN_MINUTES: Record<ObservabilitySpan, number> = {
  "1h": 60,
  "6h": 360,
  "24h": 1440,
  "7d": 10080,
};

/**
 * Security-relevant audit rollups over a sliding window: counts only (action, decision, reasonCode),
 * never identifiers. The SQL function is SECURITY DEFINER, platform_operator-gated and allowlisted.
 */
platformObservabilityRoutes.get("/platform/observability/security-events", async (c) => {
  requireOperator(c);
  const span = spanParam(c);
  const rows = await withPlatformActor(c, (tx) => tx`select * from app.security_event_summary(${SPAN_MINUTES[span]})`);
  const events = rows.map((row) => ({
    action: String(row.action),
    decision: row.decision == null ? null : String(row.decision),
    reasonCode: row.reasonCode == null ? null : String(row.reasonCode),
    events: Number(row.events),
  }));
  const total = events.reduce((sum, row) => sum + row.events, 0);
  const denied = events.filter((row) => row.decision === "deny").reduce((sum, row) => sum + row.events, 0);
  return c.json({
    generatedAt: new Date().toISOString(),
    source: "app-local",
    note: "Counts only; no identifiers are returned. WAF/Bot signals remain in the Cloudflare dashboard.",
    span,
    totals: { events: total, denied },
    events,
  });
});

/** Outbox backlog and job relay settings from this deployment's database, not Cloudflare. */
platformObservabilityRoutes.get("/platform/observability/jobs", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const backlog = await withPlatformActor(c, (tx) => tx`select * from app.outbox_backlog()`);
  return c.json({
    generatedAt: new Date().toISOString(),
    source: "app-local",
    outbox: backlog.map((row) => ({
      status: row.status,
      events: Number(row.events),
      oldestSeconds: Math.round(Number(row.oldestSeconds ?? 0)),
      maxAttempts: Number(row.maxAttempts ?? 0),
    })),
    relay: {
      batchSize: deps.config.jobs.relayBatchSize,
      perTenantBatchLimit: deps.config.jobs.perTenantBatchLimit,
    },
  });
});

/** Integration adapter state from this deployment's registry; not a Cloudflare call. */
platformObservabilityRoutes.get("/platform/observability/integrations", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  const rows = listIntegrations(deps.config, await loadVerifications(deps.sql, deps.config));
  return c.json({
    generatedAt: new Date().toISOString(),
    source: "app-local",
    integrations: rows.map((status) => ({
      id: status.id,
      name: status.name,
      state: status.state,
      reason: status.reason,
      requested: status.requested,
      enabledForEnvironment: status.enabledForEnvironment,
      adapterImplemented: status.adapterImplemented,
      lastVerificationOutcome: status.lastVerificationOutcome,
      lastSuccessfulVerificationAt: status.lastSuccessfulVerificationAt,
    })),
  });
});

/**
 * Security posture is app-local: rate-limit configuration and breaker state. Cloudflare
 * security events (WAF, Bot) are not proxied here; they stay in the Cloudflare dashboard so
 * this endpoint never becomes a second source of truth.
 */
platformObservabilityRoutes.get("/platform/observability/security", async (c) => {
  requireOperator(c);
  const deps = c.get("deps");
  return c.json({
    generatedAt: new Date().toISOString(),
    source: "app-local",
    note: "App-level security counters only; Cloudflare WAF and Bot score events remain in the Cloudflare dashboard.",
    rateLimit: {
      trustForwardedFor: deps.config.rateLimit.trustForwardedFor,
      distributed: Boolean(deps.rateLimiter),
      overrideCount: deps.config.rateLimit.overrides.length,
    },
    breakers: breakerSnapshots(),
    latency: requestLatency(),
  });
});

