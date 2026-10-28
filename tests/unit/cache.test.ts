import { afterEach, describe, expect, it } from "vitest";
import { setLogSink } from "@medveris/platform";
import { CACHE_RULES, cacheDecision, etagMatches, hasCredentials, matchCacheRule } from "../../apps/api/src/lib/cache-policy.js";
import { CACHE_STATUS_HEADER, edgeCached, invalidateLocal, type CacheStore } from "../../apps/api/src/lib/edge-cache.js";

const ORIGIN = "https://medveris.example";
const KAMPALA = "11111111-1111-4111-8111-111111111111";
const GULU = "22222222-2222-4222-8222-222222222222";

class MemoryStore implements CacheStore {
  readonly entries = new Map<string, Response>();
  failReads = false;
  failWrites = false;
  async match(request: Request): Promise<Response | undefined> {
    if (this.failReads) throw new Error("cache read failed");
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    if (this.failWrites) throw new Error("cache write failed");
    this.entries.set(request.url, response.clone());
  }
  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

function publicResponse(body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60", etag: '"v1"', ...extra },
  });
}

afterEach(() => setLogSink(() => undefined));

describe("cache allowlist and keys", () => {
  it("allows only public reference and directory routes, never tenant, patient or clinical routes", () => {
    for (const path of ["/api/v1/public/config", "/api/v1/public/directory/facilities", "/api/v1/public/directory/facilities/pub-123"]) {
      expect(matchCacheRule("GET", path), path).not.toBeNull();
    }
    for (const path of ["/api/v1/me", "/api/v1/reception/patients", "/api/v1/reports/clinic-activity", "/fhir/Patient/123", "/api/v1/directory/facilities", "/api/v1/content"]) {
      expect(matchCacheRule("GET", path), path).toBeNull();
    }
    expect(matchCacheRule("POST", "/api/v1/public/config")).toBeNull();
    expect(CACHE_RULES.every((rule) => rule.path.source.startsWith("^\\/api\\/v1\\/public\\/"))).toBe(true);
  });

  it("builds the same key regardless of parameter order and separates different representations", () => {
    const a = cacheDecision(new Request(`${ORIGIN}/api/v1/public/directory/facilities?region=North&q=clinic`), "v1");
    const b = cacheDecision(new Request(`${ORIGIN}/api/v1/public/directory/facilities?q=clinic&region=North`), "v1");
    const c = cacheDecision(new Request(`${ORIGIN}/api/v1/public/directory/facilities?q=clinic&region=West`), "v1");
    const d = cacheDecision(new Request(`${ORIGIN}/api/v1/public/directory/facilities?q=clinic&region=North`), "v2");
    expect(a.kind).toBe("shared");
    if (a.kind !== "shared" || b.kind !== "shared" || c.kind !== "shared" || d.kind !== "shared") throw new Error("expected shared keys");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.key).not.toBe(d.key);
  });

  it("never gives a shared key to requests with credentials, personal location, unknown or repeated parameters", () => {
    const cases: Array<[Request, string]> = [
      [new Request(`${ORIGIN}/api/v1/public/config`, { headers: { cookie: "mv_session=abc" } }), "credentials"],
      [new Request(`${ORIGIN}/api/v1/public/config`, { headers: { authorization: "Bearer x" } }), "credentials"],
      [new Request(`${ORIGIN}/api/v1/public/directory/facilities?lat=0.3&lng=32.5`), "private-param"],
      [new Request(`${ORIGIN}/api/v1/public/config?tenantId=${KAMPALA}`), "unknown-param"],
      [new Request(`${ORIGIN}/api/v1/public/directory/facilities?q=a&q=b`), "ambiguous-param"],
      [new Request(`${ORIGIN}/api/v1/public/directory/facilities?q=${"x".repeat(500)}`), "oversized-key"],
    ];
    for (const [request, reason] of cases) {
      const decision = cacheDecision(request, "v1");
      expect(decision.kind, reason).toBe("private");
      if (decision.kind === "private") expect(decision.reason).toBe(reason);
    }
    expect(hasCredentials(new Headers({ cookie: "mv_ryw=1" }))).toBe(false);
  });

  it("compares ETags weakly, including lists and wildcards", () => {
    expect(etagMatches('"a", W/"b"', '"b"')).toBe(true);
    expect(etagMatches("*", '"x"')).toBe(true);
    expect(etagMatches('"a"', '"b"')).toBe(false);
    expect(etagMatches(null, '"b"')).toBe(false);
  });
});

describe("Worker edge cache", () => {
  function options(store: CacheStore | null, now: () => number = Date.now) {
    const pending: Promise<unknown>[] = [];
    return { store, keyVersion: "v1", waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, now, pending };
  }

  it("serves a hit without calling the origin, and revalidates conditionally", async () => {
    const store = new MemoryStore();
    const opts = options(store);
    let calls = 0;
    const origin = async () => { calls += 1; return publicResponse({ facilities: [] }); };
    const first = await edgeCached(new Request(`${ORIGIN}/api/v1/public/facilities`), opts, origin);
    await Promise.all(opts.pending);
    expect(first.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    const second = await edgeCached(new Request(`${ORIGIN}/api/v1/public/facilities`), opts, origin);
    expect(second.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expect(second.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await second.json()).toEqual({ facilities: [] });
    const conditional = await edgeCached(new Request(`${ORIGIN}/api/v1/public/facilities`, { headers: { "if-none-match": '"v1"' } }), opts, origin);
    expect(conditional.status).toBe(304);
    expect(calls).toBe(1);
  });

  it("collapses a stampede of concurrent misses into one origin request", async () => {
    const store = new MemoryStore();
    const opts = options(store);
    let calls = 0;
    const origin = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return publicResponse({ n: calls });
    };
    const responses = await Promise.all(Array.from({ length: 25 }, () => edgeCached(new Request(`${ORIGIN}/api/v1/public/config`), opts, origin)));
    expect(calls).toBe(1);
    for (const response of responses) expect(await response.json()).toEqual({ n: 1 });
  });

  it("does not let one tenant's or user's authenticated request read or populate the shared cache", async () => {
    const store = new MemoryStore();
    const opts = options(store);
    const seen: string[] = [];
    const origin = async (request: Request) => {
      const tenant = request.headers.get("cookie")?.includes("kampala") ? KAMPALA : request.headers.get("cookie")?.includes("gulu") ? GULU : "anonymous";
      seen.push(tenant);
      return publicResponse({ tenant });
    };
    const url = `${ORIGIN}/api/v1/public/config`;
    const kampala = await edgeCached(new Request(url, { headers: { cookie: "mv_session=kampala" } }), opts, origin);
    const gulu = await edgeCached(new Request(url, { headers: { cookie: "mv_session=gulu" } }), opts, origin);
    await Promise.all(opts.pending);
    expect(await kampala.json()).toEqual({ tenant: KAMPALA });
    expect(await gulu.json()).toEqual({ tenant: GULU });
    expect(store.entries.size).toBe(0);
    const anonymous = await edgeCached(new Request(url), opts, origin);
    expect(await anonymous.json()).toEqual({ tenant: "anonymous" });
    expect(seen).toEqual([KAMPALA, GULU, "anonymous"]);
  });

  it("does not store private, cookie-setting or error responses even on allowlisted routes", async () => {
    const store = new MemoryStore();
    const opts = options(store);
    const url = `${ORIGIN}/api/v1/public/config`;
    await edgeCached(new Request(url), opts, async () => new Response("{}", { status: 200, headers: { "cache-control": "no-store, private" } }));
    await edgeCached(new Request(url), opts, async () => publicResponse({}, { "set-cookie": "a=b" }));
    await edgeCached(new Request(url), opts, async () => new Response("{}", { status: 503, headers: { "cache-control": "public, max-age=60" } }));
    await Promise.all(opts.pending);
    expect(store.entries.size).toBe(0);
  });

  it("bypasses non-allowlisted routes entirely", async () => {
    const store = new MemoryStore();
    const opts = options(store);
    const response = await edgeCached(new Request(`${ORIGIN}/api/v1/reception/patients`), opts, async () => publicResponse({ patients: ["synthetic"] }));
    await Promise.all(opts.pending);
    expect(response.headers.get(CACHE_STATUS_HEADER)).toBeNull();
    expect(store.entries.size).toBe(0);
  });

  it("expires entries by TTL and serves stale content only when the origin fails", async () => {
    const store = new MemoryStore();
    let now = 1_000_000;
    const opts = options(store, () => now);
    const url = `${ORIGIN}/api/v1/public/config`;
    await edgeCached(new Request(url), opts, async () => publicResponse({ version: 1 }));
    await Promise.all(opts.pending);
    now += 61_000;
    const refreshed = await edgeCached(new Request(url), opts, async () => publicResponse({ version: 2 }));
    expect(refreshed.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expect(await refreshed.json()).toEqual({ version: 2 });
    await Promise.all(opts.pending);
    now += 61_000;
    const stale = await edgeCached(new Request(url), opts, async () => new Response("down", { status: 503 }));
    expect(stale.headers.get(CACHE_STATUS_HEADER)).toBe("stale-if-error");
    expect(await stale.json()).toEqual({ version: 2 });
    now += 3_700_000;
    const gone = await edgeCached(new Request(url), opts, async () => new Response("down", { status: 503 }));
    expect(gone.status).toBe(503);
  });

  it("falls back to the origin when the cache itself fails", async () => {
    setLogSink(() => undefined);
    const store = new MemoryStore();
    store.failReads = true;
    store.failWrites = true;
    const opts = options(store);
    const response = await edgeCached(new Request(`${ORIGIN}/api/v1/public/config`), opts, async () => publicResponse({ ok: true }));
    await Promise.all(opts.pending);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("invalidates by key and by key version", async () => {
    const store = new MemoryStore();
    const opts = options(store);
    const url = `${ORIGIN}/api/v1/public/config`;
    await edgeCached(new Request(url), opts, async () => publicResponse({ version: 1 }));
    await Promise.all(opts.pending);
    expect(await invalidateLocal(store, new Request(url), "v1")).toBe(true);
    expect(store.entries.size).toBe(0);
    await edgeCached(new Request(url), opts, async () => publicResponse({ version: 1 }));
    await Promise.all(opts.pending);
    const bumped = await edgeCached(new Request(url), { ...opts, keyVersion: "v2" }, async () => publicResponse({ version: 2 }));
    expect(await bumped.json()).toEqual({ version: 2 });
  });
});
