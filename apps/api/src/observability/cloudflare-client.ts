import { errorFields, logEvent, metric } from "@medveris/platform";
import { TtlCache } from "./cache.js";

/**
 * Read-only Cloudflare API client used by the platform observability routes. The token never
 * leaves this module: it is attached only to outbound Authorization headers and is never
 * logged, returned, or written to the cache. Every call is GET or a GraphQL query; no
 * mutation endpoint is reachable from here.
 */

export interface CloudflareObservabilityConfig {
  enabled: boolean;
  apiToken: string | null;
  accountId: string | null;
  timeoutMs: number;
  cacheTtlMs: number;
}

export type ObservabilitySource = "cloudflare-rest" | "cloudflare-graphql" | "app-local" | "unavailable";

export interface ObservabilityEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
  source: ObservabilitySource;
  fetchedAt: string;
  timeRange: TimeRange;
  /** True when this is a cached response older than the TTL, served because a refresh failed. */
  stale: boolean;
}

export interface TimeRange {
  start: string;
  end: string;
  /** Human-readable span, e.g. "1h". */
  span: string;
}

export type ObservabilitySpan = "1h" | "6h" | "24h" | "7d";

const SPAN_MS: Record<ObservabilitySpan, number> = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

export function parseSpan(raw: string | undefined | null): ObservabilitySpan {
  return raw === "6h" || raw === "24h" || raw === "7d" ? raw : "1h";
}

export function timeRangeFor(span: ObservabilitySpan, now = Date.now()): TimeRange {
  return {
    start: new Date(now - SPAN_MS[span]).toISOString(),
    end: new Date(now).toISOString(),
    span,
  };
}

const CF_API = "https://api.cloudflare.com/client/v4";
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

export class CloudflareObservabilityError extends Error {
  constructor(
    message: string,
    readonly kind: "not_configured" | "timeout" | "rate_limited" | "unauthorized" | "upstream" | "network",
  ) {
    super(message);
    this.name = "CloudflareObservabilityError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CloudflareClientOptions {
  config: CloudflareObservabilityConfig;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests. */
  now?: () => number;
  cache?: TtlCache;
}

export interface WorkersScriptSummary {
  id: string;
  title: string;
  modified_on: string;
  usage_model?: string;
  handlers?: string[];
}

export interface WorkersInvocationSample {
  scriptName: string | null;
  invocationCount: number;
  cpuTimeP50Ms: number | null;
  cpuTimeP99Ms: number | null;
  durationP50Ms: number | null;
  durationP99Ms: number | null;
  errorCount: number;
  outcomeCounts: Record<string, number>;
}

export interface GraphqlMetricRow {
  [key: string]: unknown;
}

export interface LogEventRow {
  timestamp: string;
  level: string;
  event: string | null;
  route: string | null;
  status: number | null;
  ms: number | null;
  message: string | null;
}

export interface TraceSpanSummary {
  traceId: string;
  rootRoute: string | null;
  startedAt: string;
  durationMs: number | null;
  status: number | null;
  spanCount: number;
}

export class CloudflareObservabilityClient {
  private readonly config: CloudflareObservabilityConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cache: TtlCache;

  constructor(options: CloudflareClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.cache = options.cache ?? new TtlCache(options.config.cacheTtlMs);
  }

  isConfigured(): boolean {
    return this.config.enabled && Boolean(this.config.apiToken) && Boolean(this.config.accountId);
  }

  /** Cache statistics for the status payload; never includes keys with tenant data. */
  cacheStats(): { ttlMs: number; entries: number } {
    return { ttlMs: this.config.cacheTtlMs, entries: this.cache.size() };
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Runs a read through the cache. A fresh hit is returned immediately; a miss fetches upstream.
   * On failure the last good response is served with `stale: true` so the operator still sees
   * the previous snapshot rather than an empty page.
   */
  private async cached<T>(
    key: string,
    span: ObservabilitySpan,
    fetcher: (range: TimeRange) => Promise<T>,
    source: ObservabilitySource,
  ): Promise<ObservabilityEnvelope<T>> {
    const range = timeRangeFor(span, this.now());
    if (!this.isConfigured()) {
      return this.unavailable<T>(span, "Cloudflare observability is not configured; set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
    }
    const hit = this.cache.get<T>(key, this.now());
    if (hit) {
      return { ok: true, data: hit.value, error: null, source, fetchedAt: new Date(hit.fetchedAt).toISOString(), timeRange: hit.fetchedAt ? timeRangeFor(span, hit.fetchedAt) : range, stale: false };
    }
    try {
      const data = await fetcher(range);
      this.cache.set(key, data, this.now());
      metric("observability.cloudflare.fetch", 1, { key, outcome: "ok" });
      return { ok: true, data, error: null, source, fetchedAt: new Date(this.now()).toISOString(), timeRange: range, stale: false };
    } catch (error) {
      const stale = this.cache.peek<T>(key);
      if (stale) {
        this.cache.markStale(key);
        logEvent("warn", "observability.cloudflare.stale", { key, ...errorFields(error) });
        metric("observability.cloudflare.fetch", 1, { key, outcome: "stale" });
        return {
          ok: true,
          data: stale.value,
          error: null,
          source,
          fetchedAt: new Date(stale.fetchedAt).toISOString(),
          timeRange: timeRangeFor(span, stale.fetchedAt),
          stale: true,
        };
      }
      logEvent("warn", "observability.cloudflare.failed", { key, ...errorFields(error) });
      metric("observability.cloudflare.fetch", 1, { key, outcome: "error" });
      return {
        ok: false,
        data: null,
        error: error instanceof Error ? error.message : "Cloudflare request failed",
        source: "unavailable",
        fetchedAt: new Date(this.now()).toISOString(),
        timeRange: range,
        stale: false,
      };
    }
  }

  private unavailable<T>(span: ObservabilitySpan, message: string): ObservabilityEnvelope<T> {
    return {
      ok: false,
      data: null,
      error: message,
      source: "unavailable",
      fetchedAt: new Date(this.now()).toISOString(),
      timeRange: timeRangeFor(span, this.now()),
      stale: false,
    };
  }

  private requireAuth(): { token: string; accountId: string } {
    if (!this.isConfigured() || !this.config.apiToken || !this.config.accountId) {
      throw new CloudflareObservabilityError("Cloudflare observability is not configured", "not_configured");
    }
    return { token: this.config.apiToken, accountId: this.config.accountId };
  }

  private async restGet<T>(path: string, signal?: AbortSignal): Promise<T> {
    const { token } = this.requireAuth();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${CF_API}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        throw new CloudflareObservabilityError(retry ? `Rate limited; retry after ${retry}s` : "Rate limited", "rate_limited");
      }
      if (response.status === 401 || response.status === 403) {
        throw new CloudflareObservabilityError("Cloudflare rejected the API token", "unauthorized");
      }
      if (!response.ok) throw new CloudflareObservabilityError(`Cloudflare returned HTTP ${response.status}`, "upstream");
      const body = (await response.json()) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> };
      if (body.success === false) {
        const message = body.errors?.[0]?.message ?? "Cloudflare reported an error";
        throw new CloudflareObservabilityError(message, "upstream");
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof CloudflareObservabilityError) throw error;
      if (signal?.aborted) throw error;
      if ((error as Error).name === "AbortError") throw new CloudflareObservabilityError("Cloudflare request timed out", "timeout");
      throw new CloudflareObservabilityError((error as Error).message || "Network error talking to Cloudflare", "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const { token } = this.requireAuth();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        throw new CloudflareObservabilityError(retry ? `Rate limited; retry after ${retry}s` : "Rate limited", "rate_limited");
      }
      if (response.status === 401 || response.status === 403) {
        throw new CloudflareObservabilityError("Cloudflare rejected the API token", "unauthorized");
      }
      if (!response.ok) throw new CloudflareObservabilityError(`Cloudflare GraphQL returned HTTP ${response.status}`, "upstream");
      const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
      if (body.errors?.length) {
        throw new CloudflareObservabilityError(body.errors[0]?.message ?? "Cloudflare GraphQL reported an error", "upstream");
      }
      if (body.data === undefined || body.data === null) {
        throw new CloudflareObservabilityError("Cloudflare GraphQL returned no data", "upstream");
      }
      return body.data;
    } catch (error) {
      if (error instanceof CloudflareObservabilityError) throw error;
      if (signal?.aborted) throw error;
      if ((error as Error).name === "AbortError") throw new CloudflareObservabilityError("Cloudflare GraphQL request timed out", "timeout");
      throw new CloudflareObservabilityError((error as Error).message || "Network error talking to Cloudflare", "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Account-level Workers scripts list (REST). */
  async listWorkersScripts(signal?: AbortSignal): Promise<ObservabilityEnvelope<WorkersScriptSummary[]>> {
    return this.cached("workers.scripts", "1h", async () => {
      const { accountId } = this.requireAuth();
      const result = await this.restGet<WorkersScriptSummary[]>(`/accounts/${accountId}/workers/scripts`, signal);
      return (result ?? []).map((script) => ({
        id: script.id,
        title: script.title,
        modified_on: script.modified_on,
        usage_model: script.usage_model,
        handlers: script.handlers,
      }));
    }, "cloudflare-rest");
  }

  /**
   * Workers invocations over the Observability GraphQL dataset. When the account has not
   * enabled Workers Observability the upstream returns an error, which is surfaced as a
   * structured failure rather than empty metrics.
   */
  async workersInvocations(span: ObservabilitySpan, signal?: AbortSignal): Promise<ObservabilityEnvelope<WorkersInvocationSample[]>> {
    return this.cached(`workers.invocations.${span}`, span, async (range) => {
      const { accountId } = this.requireAuth();
      const query = `
        query WorkersInvocations($accountTag: string!, $since: Time!, $until: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              workersInvocationsAdaptive(limit: 50, filter: { datetime_geq: $since, datetime_leq: $until }) {
                count
                max { cpuTimeUs durationMs }
                dimensions { scriptName outcome }
              }
            }
          }
        }`;
      const data = await this.graphql<{
        viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{
          count: number;
          max?: { cpuTimeUs?: number; durationMs?: number };
          dimensions?: { scriptName?: string; outcome?: string };
        }> }> };
      }>(query, { accountTag: accountId, since: range.start, until: range.end }, signal);
      const rows = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      const byScript = new Map<string, WorkersInvocationSample>();
      for (const row of rows) {
        const name = row.dimensions?.scriptName ?? "unknown";
        const outcome = row.dimensions?.outcome ?? "unknown";
        const entry = byScript.get(name) ?? {
          scriptName: name,
          invocationCount: 0,
          cpuTimeP50Ms: null,
          cpuTimeP99Ms: null,
          durationP50Ms: null,
          durationP99Ms: null,
          errorCount: 0,
          outcomeCounts: {},
        };
        entry.invocationCount += Number(row.count ?? 0);
        entry.outcomeCounts[outcome] = (entry.outcomeCounts[outcome] ?? 0) + Number(row.count ?? 0);
        if (outcome === "exception" || outcome === "exceededCpu" || outcome === "exceededMemory") {
          entry.errorCount += Number(row.count ?? 0);
        }
        const cpuMs = row.max?.cpuTimeUs != null ? Number(row.max.cpuTimeUs) / 1000 : null;
        if (cpuMs != null && (entry.cpuTimeP99Ms == null || cpuMs > entry.cpuTimeP99Ms)) entry.cpuTimeP99Ms = cpuMs;
        const durationMs = row.max?.durationMs != null ? Number(row.max.durationMs) : null;
        if (durationMs != null && (entry.durationP99Ms == null || durationMs > entry.durationP99Ms)) entry.durationP99Ms = durationMs;
        byScript.set(name, entry);
      }
      return [...byScript.values()];
    }, "cloudflare-graphql");
  }

  /** Aggregate HTTP request metrics for the account (GraphQL). */
  async httpMetrics(span: ObservabilitySpan, signal?: AbortSignal): Promise<ObservabilityEnvelope<GraphqlMetricRow[]>> {
    return this.cached(`http.metrics.${span}`, span, async (range) => {
      const { accountId } = this.requireAuth();
      const query = `
        query HttpRequests($accountTag: string!, $since: Time!, $until: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              httpRequests1mGroups(limit: 20, filter: { datetime_geq: $since, datetime_leq: $until }) {
                max { requests cachedRequests bytes cachedBytes }
                dimensions { date clientHTTPVersion clientCountryName }
              }
            }
          }
        }`;
      const data = await this.graphql<{
        viewer?: { accounts?: Array<{ httpRequests1mGroups?: Array<{
          max?: { requests?: number; cachedRequests?: number; bytes?: number; cachedBytes?: number };
          dimensions?: { date?: string; clientHTTPVersion?: string; clientCountryName?: string };
        }> }> };
      }>(query, { accountTag: accountId, since: range.start, until: range.end }, signal);
      const rows = data.viewer?.accounts?.[0]?.httpRequests1mGroups ?? [];
      return rows.map((row) => ({
        date: row.dimensions?.date ?? null,
        clientHTTPVersion: row.dimensions?.clientHTTPVersion ?? null,
        clientCountryName: row.dimensions?.clientCountryName ?? null,
        requests: Number(row.max?.requests ?? 0),
        cachedRequests: Number(row.max?.cachedRequests ?? 0),
        bytes: Number(row.max?.bytes ?? 0),
        cachedBytes: Number(row.max?.cachedBytes ?? 0),
      }));
    }, "cloudflare-graphql");
  }

  /**
   * Structured Workers Logs (GraphQL `workersInvocationsAdaptive` is the invocation source;
   * raw log lines are not requested here because PHI-safe filtering is done at emit time and
   * re-querying full bodies would risk patient data). This returns invocation-level outcomes only.
   */
  async logsSummary(span: ObservabilitySpan, signal?: AbortSignal): Promise<ObservabilityEnvelope<LogEventRow[]>> {
    return this.cached(`logs.summary.${span}`, span, async (range) => {
      const { accountId } = this.requireAuth();
      const query = `
        query WorkersLogs($accountTag: string!, $since: Time!, $until: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $since, datetime_leq: $until }) {
                count
                dimensions { scriptName outcome datetime }
              }
            }
          }
        }`;
      const data = await this.graphql<{
        viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{
          count: number;
          dimensions?: { scriptName?: string; outcome?: string; datetime?: string };
        }> }> };
      }>(query, { accountTag: accountId, since: range.start, until: range.end }, signal);
      const rows = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      return rows.map((row) => ({
        timestamp: row.dimensions?.datetime ?? range.start,
        level: row.dimensions?.outcome === "exception" ? "error" : "info",
        event: "worker_invocation",
        route: row.dimensions?.scriptName ?? null,
        status: null,
        ms: null,
        message: `${row.count} invocation(s) with outcome ${row.dimensions?.outcome ?? "unknown"}`,
      }));
    }, "cloudflare-graphql");
  }

  /**
   * Trace summaries from the Workers invocations dataset. Cloudflare's Trace product stores
   * per-span detail; this endpoint returns roll-ups only so the operator sees latency shape
   * without pulling span payloads into the API response.
   */
  async tracesSummary(span: ObservabilitySpan, signal?: AbortSignal): Promise<ObservabilityEnvelope<TraceSpanSummary[]>> {
    return this.cached(`traces.summary.${span}`, span, async (range) => {
      const { accountId } = this.requireAuth();
      const query = `
        query WorkersTrace($accountTag: string!, $since: Time!, $until: Time!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              workersInvocationsAdaptive(limit: 50, filter: { datetime_geq: $since, datetime_leq: $until }) {
                count
                max { durationMs }
                dimensions { scriptName datetime }
              }
            }
          }
        }`;
      const data = await this.graphql<{
        viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{
          count: number;
          max?: { durationMs?: number };
          dimensions?: { scriptName?: string; datetime?: string };
        }> }> };
      }>(query, { accountTag: accountId, since: range.start, until: range.end }, signal);
      const rows = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
      return rows.map((row, index) => ({
        traceId: `cf-rollup-${index}-${row.dimensions?.datetime ?? range.start}`,
        rootRoute: row.dimensions?.scriptName ?? null,
        startedAt: row.dimensions?.datetime ?? range.start,
        durationMs: row.max?.durationMs != null ? Number(row.max.durationMs) : null,
        status: null,
        spanCount: Number(row.count ?? 0),
      }));
    }, "cloudflare-graphql");
  }
}

/** Builds a client from AppConfig-shaped values; used by the API when deps.cloudflareObservability is absent. */
export function createCloudflareObservabilityClient(
  config: CloudflareObservabilityConfig,
  options: Omit<CloudflareClientOptions, "config"> = {},
): CloudflareObservabilityClient {
  return new CloudflareObservabilityClient({ config, ...options });
}
