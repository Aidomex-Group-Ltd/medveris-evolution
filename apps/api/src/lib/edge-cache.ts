import { errorFields, logEvent, metric } from "@medveris/platform";
import { cacheDecision, etagMatches, type CacheRule } from "./cache-policy.js";

/** The subset of the Workers Cache API used here; tests pass an in-memory store. */
export interface CacheStore {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete?(request: Request): Promise<boolean>;
}

interface Captured {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

const STORED_AT = "x-medveris-stored-at";
/** The stored copy carries the Worker-cache lifetime; this keeps the policy browsers receive. */
const BROWSER_POLICY = "x-medveris-browser-cache-control";
export const CACHE_STATUS_HEADER = "x-medveris-cache";

export type CacheOutcome = "hit" | "miss" | "stale-if-error" | "bypass" | "error";

/** Concurrent misses for one key in this isolate share a single origin request. */
const inflight = new Map<string, Promise<Captured>>();

async function capture(response: Response): Promise<Captured> {
  return { status: response.status, headers: [...response.headers.entries()], body: await response.arrayBuffer() };
}

function toResponse(captured: Captured, outcome: CacheOutcome, request: Request, ageSeconds?: number): Response {
  const headers = new Headers(captured.headers);
  headers.delete(STORED_AT);
  const browserPolicy = headers.get(BROWSER_POLICY);
  if (browserPolicy) headers.set("cache-control", browserPolicy);
  headers.delete(BROWSER_POLICY);
  headers.set(CACHE_STATUS_HEADER, outcome);
  if (ageSeconds !== undefined) headers.set("age", String(Math.max(0, Math.floor(ageSeconds))));
  if (captured.status === 200 && etagMatches(request.headers.get("if-none-match"), headers.get("etag"))) {
    headers.delete("content-length");
    headers.delete("content-type");
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : captured.body, { status: captured.status, headers });
}

function cacheable(captured: Captured): boolean {
  const headers = new Headers(captured.headers);
  return captured.status === 200
    && !headers.has("set-cookie")
    && /(^|,)\s*public\b/.test(headers.get("cache-control") ?? "");
}

export interface EdgeCacheOptions {
  store: CacheStore | null;
  /** Deployment version plus CACHE_KEY_EPOCH: a new release or an epoch bump invalidates every key. */
  keyVersion: string;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  sampleRate?: number;
}

/**
 * Worker-side cache in front of the router for allowlisted public responses only. A cache read
 * or write failure never fails the request: the origin is authoritative. Entries are kept past
 * their freshness only so they can be served when the origin errors (stale-if-error).
 */
export async function edgeCached(request: Request, options: EdgeCacheOptions, origin: (request: Request) => Promise<Response>): Promise<Response> {
  const decision = cacheDecision(request, options.keyVersion);
  if (decision.kind !== "shared" || !options.store) return origin(request);
  const { rule, key } = decision;
  const store = options.store;
  const now = options.now ?? Date.now;
  const keyRequest = new Request(key, { method: "GET" });
  const record = (outcome: CacheOutcome) => {
    if (outcome === "error" || Math.random() < (options.sampleRate ?? 1)) metric("cache.lookup", 1, { layer: "worker", rule: rule.id, outcome });
  };

  let stale: Captured | null = null;
  let staleAge = 0;
  try {
    const hit = await store.match(keyRequest);
    if (hit) {
      const storedAt = Number(hit.headers.get(STORED_AT) ?? 0);
      const age = (now() - storedAt) / 1000;
      const captured = await capture(hit);
      if (storedAt && age <= rule.edgeTtlSeconds) {
        record("hit");
        return toResponse(captured, "hit", request, age);
      }
      if (storedAt && age <= rule.edgeTtlSeconds + rule.staleIfErrorSeconds) {
        stale = captured;
        staleAge = age;
      }
    }
  } catch (error) {
    record("error");
    logEvent("warn", "cache_read_failed", { rule: rule.id, ...errorFields(error, false) });
  }

  let pending = inflight.get(key);
  const leader = !pending;
  if (!pending) {
    // The origin is asked unconditionally so a 304 for one client never becomes the shared entry.
    const unconditional = new Request(request.url, { method: "GET", headers: request.headers });
    unconditional.headers.delete("if-none-match");
    unconditional.headers.delete("if-modified-since");
    pending = origin(unconditional).then(capture);
    inflight.set(key, pending);
    pending.finally(() => inflight.delete(key)).catch(() => undefined);
  }

  let fresh: Captured;
  try {
    fresh = await pending;
  } catch (error) {
    if (stale) {
      record("stale-if-error");
      return toResponse(stale, "stale-if-error", request, staleAge);
    }
    throw error;
  }
  if (fresh.status >= 500 && stale) {
    record("stale-if-error");
    return toResponse(stale, "stale-if-error", request, staleAge);
  }
  record("miss");
  if (leader && cacheable(fresh)) {
    const headers = new Headers(fresh.headers);
    headers.set(STORED_AT, String(now()));
    headers.set(BROWSER_POLICY, headers.get("cache-control") ?? "");
    headers.set("cache-control", `public, s-maxage=${rule.edgeTtlSeconds + rule.staleIfErrorSeconds}`);
    options.waitUntil(
      store.put(keyRequest, new Response(fresh.body.slice(0), { status: 200, headers })).catch((error: unknown) => {
        metric("cache.lookup", 1, { layer: "worker", rule: rule.id, outcome: "error" });
        logEvent("warn", "cache_write_failed", { rule: rule.id, ...errorFields(error, false) });
      }),
    );
  }
  return toResponse(fresh, "miss", request);
}

/** Removes one entry from this data center's cache; other locations expire by TTL or key version. */
export async function invalidateLocal(store: CacheStore | null, request: Request, keyVersion: string): Promise<boolean> {
  const decision = cacheDecision(request, keyVersion);
  if (decision.kind !== "shared" || !store?.delete) return false;
  metric("cache.invalidate", 1, { layer: "worker", rule: decision.rule.id });
  return store.delete(new Request(decision.key, { method: "GET" }));
}

export type { CacheRule };
