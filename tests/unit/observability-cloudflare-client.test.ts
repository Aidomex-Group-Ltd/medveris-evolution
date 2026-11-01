import { describe, expect, it } from "vitest";
import {
  CloudflareObservabilityClient,
  parseSpan,
  timeRangeFor,
  type CloudflareObservabilityConfig,
} from "../../apps/api/src/observability/cloudflare-client.js";
import { TtlCache } from "../../apps/api/src/observability/cache.js";

function config(overrides: Partial<CloudflareObservabilityConfig> = {}): CloudflareObservabilityConfig {
  return {
    enabled: true,
    apiToken: "cf-token-for-tests-only",
    accountId: "acct-123",
    timeoutMs: 5_000,
    cacheTtlMs: 60_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseSpan", () => {
  it("accepts the documented spans and defaults to 1h", () => {
    expect(parseSpan("1h")).toBe("1h");
    expect(parseSpan("6h")).toBe("6h");
    expect(parseSpan("24h")).toBe("24h");
    expect(parseSpan("7d")).toBe("7d");
    expect(parseSpan(undefined)).toBe("1h");
    expect(parseSpan("nonsense")).toBe("1h");
  });
});

describe("timeRangeFor", () => {
  it("computes a start/end window", () => {
    const range = timeRangeFor("1h", Date.UTC(2026, 0, 1, 12, 0, 0));
    expect(range.span).toBe("1h");
    expect(range.end).toBe("2026-01-01T12:00:00.000Z");
    expect(range.start).toBe("2026-01-01T11:00:00.000Z");
  });
});

describe("CloudflareObservabilityClient", () => {
  it("returns a structured unavailable envelope when not configured", async () => {
    const client = new CloudflareObservabilityClient({ config: config({ enabled: false }) });
    expect(client.isConfigured()).toBe(false);
    const result = await client.workersInvocations("1h");
    expect(result.ok).toBe(false);
    expect(result.source).toBe("unavailable");
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/not configured/i);
    expect(result.timeRange.span).toBe("1h");
  });

  it("returns unavailable when the token is missing", async () => {
    const client = new CloudflareObservabilityClient({ config: config({ apiToken: null }) });
    const result = await client.listWorkersScripts();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it("never returns the API token in the envelope", async () => {
    const client = new CloudflareObservabilityClient({
      config: config(),
      fetchImpl: async () => jsonResponse({ success: true, result: [] }),
    });
    const result = await client.listWorkersScripts();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("cf-token-for-tests-only");
  });

  it("sends the Authorization header and parses REST results", async () => {
    const seen: Request[] = [];
    const client = new CloudflareObservabilityClient({
      config: config(),
      fetchImpl: async (input, init) => {
        seen.push(new Request(input, init));
        return jsonResponse({
          success: true,
          result: [{ id: "w1", title: "medveris-api", modified_on: "2026-01-01T00:00:00Z", usage_model: "unlimited" }],
        });
      },
    });
    const result = await client.listWorkersScripts();
    expect(result.ok).toBe(true);
    expect(result.source).toBe("cloudflare-rest");
    expect(result.data?.[0]).toMatchObject({ id: "w1", title: "medveris-api" });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer cf-token-for-tests-only");
    expect(seen[0]?.url).toContain("/accounts/acct-123/workers/scripts");
  });

  it("surfaces HTTP 429 as a rate_limited error without leaking the token", async () => {
    const client = new CloudflareObservabilityClient({
      config: config(),
      fetchImpl: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
    });
    const result = await client.listWorkersScripts();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rate limited/i);
    expect(JSON.stringify(result)).not.toContain("cf-token-for-tests-only");
  });

  it("surfaces 401 as unauthorized", async () => {
    const client = new CloudflareObservabilityClient({
      config: config(),
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    const result = await client.listWorkersScripts();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected the API token/i);
  });

  it("caches a successful response and serves it without a second upstream call", async () => {
    let calls = 0;
    const client = new CloudflareObservabilityClient({
      config: config(),
      cache: new TtlCache(60_000),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ success: true, result: [{ id: "w1", title: "worker", modified_on: "2026-01-01T00:00:00Z" }] });
      },
    });
    const first = await client.listWorkersScripts();
    const second = await client.listWorkersScripts();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls).toBe(1);
    expect(second.data?.[0]?.id).toBe("w1");
  });

  it("serves the last known good response as stale when a refresh fails", async () => {
    let fail = false;
    const client = new CloudflareObservabilityClient({
      config: config(),
      cache: new TtlCache(1_000),
      now: () => Date.now(),
      fetchImpl: async () => {
        if (fail) return new Response("boom", { status: 500 });
        return jsonResponse({ success: true, result: [{ id: "w1", title: "worker", modified_on: "2026-01-01T00:00:00Z" }] });
      },
    });
    const first = await client.listWorkersScripts();
    expect(first.ok).toBe(true);
    fail = true;
    // Force expiry by using a cache with a 1s TTL and waiting is flaky; mark stale and force a miss
    // by clearing the live path: use a second client sharing the cache after TTL via peek path.
    // Simpler: call after setting fail and clearing the live entry via markStale + expired TTL.
    // We simulate by constructing a new client on the same cache and relying on peek after failure
    // when get() returns null (entry expired). Advance by using a 1s TTL and a short sleep.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await client.listWorkersScripts();
    expect(second.ok).toBe(true);
    expect(second.stale).toBe(true);
    expect(second.data?.[0]?.id).toBe("w1");
  });

  it("aggregates GraphQL workers invocations by script", async () => {
    const client = new CloudflareObservabilityClient({
      config: config(),
      fetchImpl: async (input) => {
        if (String(input).includes("graphql")) {
          return jsonResponse({
            data: {
              viewer: {
                accounts: [{
                  workersInvocationsAdaptive: [
                    { count: 10, max: { cpuTimeUs: 2_000, durationMs: 50 }, dimensions: { scriptName: "api", outcome: "ok" } },
                    { count: 1, max: { cpuTimeUs: 9_000, durationMs: 120 }, dimensions: { scriptName: "api", outcome: "exception" } },
                    { count: 3, max: { durationMs: 20 }, dimensions: { scriptName: "jobs", outcome: "ok" } },
                  ],
                }],
              },
            },
          });
        }
        return jsonResponse({ success: true, result: [] });
      },
    });
    const result = await client.workersInvocations("1h");
    expect(result.ok).toBe(true);
    expect(result.source).toBe("cloudflare-graphql");
    const api = result.data?.find((row) => row.scriptName === "api");
    const jobs = result.data?.find((row) => row.scriptName === "jobs");
    expect(api?.invocationCount).toBe(11);
    expect(api?.errorCount).toBe(1);
    expect(api?.cpuTimeP99Ms).toBe(9);
    expect(jobs?.invocationCount).toBe(3);
    expect(jobs?.errorCount).toBe(0);
  });

  it("surfaces GraphQL errors without inventing metrics", async () => {
    const client = new CloudflareObservabilityClient({
      config: config(),
      fetchImpl: async () => jsonResponse({ errors: [{ message: "workersInvocationsAdaptive is not enabled" }] }),
    });
    const result = await client.httpMetrics("1h");
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/not enabled/i);
  });
});
