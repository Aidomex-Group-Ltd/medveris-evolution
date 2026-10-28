import { describe, expect, it } from "vitest";
import {
  applyRateCheck,
  clientAddress,
  clientKey,
  CoordinatedRateLimiter,
  emptyState,
  LocalRateLimiter,
  RATE_LIMIT_POLICIES,
  type DurableObjectNamespaceLike,
} from "../../apps/api/src/lib/rate-limit.js";
import { RateLimiterObject } from "../../apps/api/src/durable/rate-limiter.js";
import { parseRateLimitOverrides } from "../../apps/api/src/config.js";
import type { DurableStateLike } from "../../apps/api/src/durable/types.js";

function fakeState(): DurableStateLike & { alarm: number | null; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const state = {
    data,
    alarm: null as number | null,
    storage: {
      get: async <T>(key: string) => data.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => { data.set(key, structuredClone(value)); },
      delete: async (key: string) => data.delete(key),
      deleteAll: async () => { data.clear(); },
      setAlarm: async (time: number) => { state.alarm = time; },
      getAlarm: async () => state.alarm,
      list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  };
  return state;
}

/**
 * Durable Objects run one request at a time per object. This namespace models that with a
 * per-object promise chain, so many "Worker instances" calling concurrently see one counter.
 */
function fakeNamespace(now: () => number, options: { fail?: () => boolean } = {}) {
  const objects = new Map<string, { object: RateLimiterObject; state: ReturnType<typeof fakeState>; queue: Promise<unknown> }>();
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        if (options.fail?.()) throw new Error("coordination unavailable");
        const name = String(id);
        let entry = objects.get(name);
        if (!entry) {
          const state = fakeState();
          entry = { object: new RateLimiterObject(state, undefined, now), state, queue: Promise.resolve() };
          objects.set(name, entry);
        }
        const request = typeof input === "string" ? new Request(input, init) : input;
        const run = entry.queue.then(() => entry!.object.fetch(request));
        entry.queue = run.catch(() => undefined);
        return run;
      },
    }),
  };
  return { namespace, objects };
}

describe("sliding-window rate limit", () => {
  const check = { limit: 5, windowSeconds: 60, cost: 1 };

  it("allows the limit, refuses the next, and recovers as the window slides", () => {
    let state = emptyState(0);
    for (let i = 0; i < 5; i += 1) {
      const result = applyRateCheck(state, check, 1000);
      expect(result.decision.allowed).toBe(true);
      state = result.state;
    }
    const refused = applyRateCheck(state, check, 1000);
    expect(refused.decision.allowed).toBe(false);
    expect(refused.decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(applyRateCheck(refused.state, check, 61_000 + 30_000).decision.allowed).toBe(true);
    expect(applyRateCheck(refused.state, check, 200_000).decision.remaining).toBe(4);
  });

  it("applies progressive cooldowns that double per violation and are capped", () => {
    const progressive = { limit: 1, windowSeconds: 60, cost: 1, progressive: { cooldownSeconds: 60, maxCooldownSeconds: 300 } };
    let state = applyRateCheck(emptyState(0), progressive, 0).state;
    const cooldowns: number[] = [];
    let now = 0;
    for (let i = 0; i < 5; i += 1) {
      const result = applyRateCheck(state, progressive, now);
      expect(result.decision.allowed).toBe(false);
      cooldowns.push(result.decision.retryAfterSeconds);
      state = result.state;
      now = state.blockedUntil;
      state = { ...state, current: 1, windowStart: now };
    }
    expect(cooldowns).toEqual([60, 120, 240, 300, 300]);
  });

  it("peeks without counting, and refuses once the quota is used", () => {
    const quota = { limit: 2, windowSeconds: 60, cost: 0 };
    let state = emptyState(0);
    expect(applyRateCheck(state, quota, 0).decision.allowed).toBe(true);
    state = applyRateCheck(state, { ...quota, cost: 1 }, 0).state;
    state = applyRateCheck(state, { ...quota, cost: 1 }, 0).state;
    const peek = applyRateCheck(state, quota, 0);
    expect(peek.decision.allowed).toBe(false);
    expect(peek.state.strikes).toBe(0);
  });

  it("keeps local memory bounded however many keys are generated", () => {
    const local = new LocalRateLimiter();
    for (let i = 0; i < 25_000; i += 1) local.check(`attacker-${i}`, { limit: 1, windowSeconds: 60, cost: 1 });
    expect(local.size()).toBeLessThanOrEqual(20_000);
  });
});

describe("coordinated rate limiting across Worker instances", () => {
  it("admits exactly the limit when many instances race for one identity", async () => {
    const { namespace } = fakeNamespace(() => 1_000);
    const instances = Array.from({ length: 8 }, () => new CoordinatedRateLimiter(namespace, new LocalRateLimiter()));
    const decisions = await Promise.all(Array.from({ length: 64 }, (_, i) => instances[i % instances.length]!.check("auth.login", "203.0.113.7")));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(RATE_LIMIT_POLICIES["auth.login"].limit);
    expect(decisions.every((decision) => decision.source === "distributed")).toBe(true);
  });

  it("keeps identities and policies separate and stores a bounded record per key with an expiry alarm", async () => {
    const { namespace, objects } = fakeNamespace(() => 1_000);
    const limiter = new CoordinatedRateLimiter(namespace, new LocalRateLimiter());
    for (let i = 0; i < 12; i += 1) await limiter.check("auth.login", "203.0.113.7");
    expect((await limiter.check("auth.login", "203.0.113.8")).allowed).toBe(true);
    expect((await limiter.check("auth.register", "203.0.113.7")).allowed).toBe(true);
    expect(objects.size).toBe(3);
    for (const { state } of objects.values()) {
      expect([...state.data.keys()]).toEqual(["state"]);
      expect(state.alarm).toBeGreaterThan(1_000);
    }
    const [first] = objects.values();
    await first!.object.alarm();
    expect(first!.state.data.size).toBe(0);
  });

  it("falls back to a stricter per-instance limit for sensitive policies when coordination fails", async () => {
    const { namespace } = fakeNamespace(() => 1_000, { fail: () => true });
    const limiter = new CoordinatedRateLimiter(namespace, new LocalRateLimiter());
    const decisions = [];
    for (let i = 0; i < 12; i += 1) decisions.push(await limiter.check("auth.login", "203.0.113.9"));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(Math.ceil(RATE_LIMIT_POLICIES["auth.login"].limit / 4));
    expect(decisions.every((decision) => decision.source === "fallback")).toBe(true);
  });

  it("fails closed for policies that must not degrade", async () => {
    const { namespace } = fakeNamespace(() => 1_000, { fail: () => true });
    const limiter = new CoordinatedRateLimiter(namespace, new LocalRateLimiter());
    expect((await limiter.check("invitation.register.token", "token-hash")).allowed).toBe(false);
  });

  it("rejects malformed checks sent to the Durable Object", async () => {
    const object = new RateLimiterObject(fakeState());
    const bad = await object.fetch(new Request("https://x/check", { method: "POST", body: JSON.stringify({ limit: -1, windowSeconds: 60, cost: 1 }) }));
    expect(bad.status).toBe(400);
  });

  it("applies bounded, expiring, audited overrides", async () => {
    const overrides = parseRateLimitOverrides(JSON.stringify([{ policy: "auth.login", factor: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: "clinic-wide re-enrolment day" }]));
    const limiter = new CoordinatedRateLimiter(null, new LocalRateLimiter(), overrides);
    const allowed = [];
    for (let i = 0; i < 30; i += 1) allowed.push((await limiter.check("auth.login", "198.51.100.4")).allowed);
    expect(allowed.filter(Boolean)).toHaveLength(24);
    expect(() => parseRateLimitOverrides(JSON.stringify([{ policy: "auth.login", factor: 50, expiresAt: new Date(Date.now() + 1000).toISOString(), reason: "too large a factor" }]))).toThrow("between 0.1 and 10");
    expect(() => parseRateLimitOverrides(JSON.stringify([{ policy: "auth.login", factor: 2, expiresAt: "2020-01-01T00:00:00Z", reason: "already expired here" }]))).toThrow("future");
    expect(() => parseRateLimitOverrides(JSON.stringify([{ policy: "auth.login", factor: 2, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), reason: "far too long an override" }]))).toThrow("7 days");
    expect(() => parseRateLimitOverrides(JSON.stringify([{ policy: "auth.login", factor: 2, expiresAt: new Date(Date.now() + 1000).toISOString(), reason: "short" }]))).toThrow("reason");
  });
});

describe("rate-limit client address", () => {
  it("uses Cloudflare's connecting IP, which a client cannot set, over a client-supplied X-Forwarded-For", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 203.0.113.9" });
    expect(clientKey(headers, "login")).toBe("203.0.113.9:login");
    expect(clientAddress(headers, false)).toBe("203.0.113.9");
  });

  it("ignores a spoofed X-Forwarded-For unless the deployment trusts its proxy", () => {
    const spoofed = new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" });
    expect(clientAddress(spoofed, false)).toBe("unknown");
    expect(clientAddress(spoofed, true)).toBe("198.51.100.7");
    expect(clientKey(new Headers(), "login")).toBe("local:login");
  });
});
