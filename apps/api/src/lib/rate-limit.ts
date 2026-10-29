import type { Context } from "hono";
import { sha256Hex } from "@medveris/auth";
import { errorFields, logEvent, metric, withTimeout } from "@medveris/platform";
import { AppError } from "./errors.js";
import type { AppEnv } from "../types.js";
import type { RateLimitOverride } from "../config.js";
import { annotate } from "./observability.js";

/**
 * Server-side rate limiting. Policies marked `distributed` are counted in a Durable Object per
 * (policy, identity), so every Worker instance shares one counter. When that coordination
 * fails, `failureMode` decides: `local-strict` keeps limiting in this isolate at a quarter of
 * the quota, `closed` refuses the request. Nothing falls back to "unlimited".
 */
export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
  distributed: boolean;
  failureMode: "local-strict" | "closed" | "local";
  /** Authentication abuse: each violation blocks for cooldown * 2^(strikes-1), capped. */
  progressive?: { cooldownSeconds: number; maxCooldownSeconds: number };
}

export const RATE_LIMIT_POLICIES = {
  "auth.login": { limit: 12, windowSeconds: 60, distributed: true, failureMode: "local-strict", progressive: { cooldownSeconds: 60, maxCooldownSeconds: 900 } },
  /** Keyed on a hash of the submitted address: protects an account against distributed guessing. */
  "auth.login.account": { limit: 10, windowSeconds: 900, distributed: true, failureMode: "local-strict", progressive: { cooldownSeconds: 300, maxCooldownSeconds: 3600 } },
  "auth.mfa": { limit: 15, windowSeconds: 60, distributed: true, failureMode: "local-strict", progressive: { cooldownSeconds: 60, maxCooldownSeconds: 900 } },
  "auth.mfa-email": { limit: 6, windowSeconds: 900, distributed: true, failureMode: "local-strict" },
  "auth.register": { limit: 10, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "auth.facility-register": { limit: 8, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "auth.organization-lookup": { limit: 20, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "payments.callback": { limit: 120, windowSeconds: 60, distributed: true, failureMode: "local" },
  "payments.mobile-money": { limit: 20, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "auth.verify-resend": { limit: 3, windowSeconds: 900, distributed: true, failureMode: "local-strict" },
  "auth.recovery": { limit: 6, windowSeconds: 900, distributed: true, failureMode: "local-strict" },
  "auth.reset": { limit: 8, windowSeconds: 900, distributed: true, failureMode: "local-strict", progressive: { cooldownSeconds: 300, maxCooldownSeconds: 3600 } },
  "invitation.status": { limit: 60, windowSeconds: 60, distributed: true, failureMode: "local" },
  "invitation.register": { limit: 20, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "invitation.register.token": { limit: 5, windowSeconds: 900, distributed: true, failureMode: "local-strict" },
  "invitation.accept": { limit: 20, windowSeconds: 60, distributed: true, failureMode: "local" },
  "invitation.decline": { limit: 20, windowSeconds: 60, distributed: true, failureMode: "local" },
  "patient.resolve": { limit: 30, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "patient.search": { limit: 60, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "reports.run": { limit: 30, windowSeconds: 60, distributed: true, failureMode: "local" },
  "jobs.submit": { limit: 20, windowSeconds: 600, distributed: true, failureMode: "local-strict" },
  "upload": { limit: 20, windowSeconds: 3600, distributed: true, failureMode: "local-strict" },
  "device.ingest": { limit: 120, windowSeconds: 60, distributed: true, failureMode: "local" },
  "integration.token": { limit: 20, windowSeconds: 60, distributed: true, failureMode: "local-strict", progressive: { cooldownSeconds: 60, maxCooldownSeconds: 900 } },
  "integration.request": { limit: 120, windowSeconds: 60, distributed: true, failureMode: "local" },
  "realtime.connect": { limit: 10, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  "pacs.search": { limit: 60, windowSeconds: 60, distributed: true, failureMode: "local-strict" },
  /** Scrolling a CT series requests one rendered frame per slice; counted instead of api.authenticated. */
  "pacs.frame": { limit: 3000, windowSeconds: 60, distributed: false, failureMode: "local" },
  /** Coarse per-isolate guards; edge WAF rules are the global control for raw request volume. */
  "api.authenticated": { limit: 600, windowSeconds: 60, distributed: false, failureMode: "local" },
  "api.public": { limit: 300, windowSeconds: 60, distributed: false, failureMode: "local" },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

export interface RateLimitState {
  windowStart: number;
  current: number;
  previous: number;
  blockedUntil: number;
  strikes: number;
  lastViolation: number;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  source: "distributed" | "local" | "fallback";
}

export interface RateCheck {
  limit: number;
  windowSeconds: number;
  cost: number;
  progressive?: { cooldownSeconds: number; maxCooldownSeconds: number };
}

export function emptyState(now: number): RateLimitState {
  return { windowStart: now, current: 0, previous: 0, blockedUntil: 0, strikes: 0, lastViolation: 0 };
}

/**
 * Sliding-window counter: the previous window's count is weighted by how much of it still
 * overlaps the sliding window. Pure, so the Durable Object, the local limiter and tests share it.
 */
export function applyRateCheck(state: RateLimitState, check: RateCheck, now: number): { state: RateLimitState; decision: Omit<RateDecision, "source"> } {
  const windowMs = check.windowSeconds * 1000;
  const next = { ...state };
  const elapsedWindows = Math.floor((now - next.windowStart) / windowMs);
  if (elapsedWindows >= 1) {
    next.previous = elapsedWindows === 1 ? next.current : 0;
    next.current = 0;
    next.windowStart += elapsedWindows * windowMs;
  }
  if (check.progressive && next.strikes && now - next.lastViolation > check.progressive.maxCooldownSeconds * 2000) {
    next.strikes = 0;
  }
  if (next.blockedUntil > now) {
    return { state: next, decision: { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((next.blockedUntil - now) / 1000) } };
  }
  const overlap = 1 - (now - next.windowStart) / windowMs;
  const weighted = next.previous * Math.max(0, overlap) + next.current;
  // cost 0 is a peek: refused once the quota is used up, without recording a violation.
  if (check.cost === 0) {
    const exhausted = weighted >= check.limit;
    return {
      state: next,
      decision: {
        allowed: !exhausted,
        remaining: Math.max(0, Math.floor(check.limit - weighted)),
        retryAfterSeconds: exhausted ? Math.max(1, Math.ceil((next.windowStart + windowMs - now) / 1000)) : 0,
      },
    };
  }
  if (weighted + check.cost > check.limit) {
    let retryAfterSeconds = Math.max(1, Math.ceil((next.windowStart + windowMs - now) / 1000));
    if (check.progressive) {
      next.strikes += 1;
      next.lastViolation = now;
      const cooldown = Math.min(check.progressive.maxCooldownSeconds, check.progressive.cooldownSeconds * 2 ** (next.strikes - 1));
      next.blockedUntil = now + cooldown * 1000;
      retryAfterSeconds = cooldown;
    }
    return { state: next, decision: { allowed: false, remaining: 0, retryAfterSeconds } };
  }
  next.current += check.cost;
  return { state: next, decision: { allowed: true, remaining: Math.max(0, Math.floor(check.limit - weighted - check.cost)), retryAfterSeconds: 0 } };
}

/** How long a state must be kept: the sliding window plus any active block or strike memory. */
export function stateExpiry(state: RateLimitState, check: RateCheck): number {
  const windowEnd = state.windowStart + 2 * check.windowSeconds * 1000;
  const strikeMemory = check.progressive && state.strikes ? state.lastViolation + check.progressive.maxCooldownSeconds * 2000 : 0;
  return Math.max(windowEnd, state.blockedUntil, strikeMemory);
}

const LOCAL_CAPACITY = 20_000;

/** Per-isolate limiter: the Node server's limiter and the fallback when coordination fails. */
export class LocalRateLimiter {
  private readonly states = new Map<string, { state: RateLimitState; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  check(key: string, check: RateCheck): Omit<RateDecision, "source"> {
    const now = this.now();
    const existing = this.states.get(key);
    const current = existing && existing.expiresAt > now ? existing.state : emptyState(now);
    const { state, decision } = applyRateCheck(current, check, now);
    if (!existing && this.states.size >= LOCAL_CAPACITY) this.evict(now);
    this.states.set(key, { state, expiresAt: stateExpiry(state, check) });
    return decision;
  }

  /** Bounded memory: expired entries go first, then the oldest, so attacker-chosen keys cannot grow the map. */
  private evict(now: number): void {
    for (const [key, entry] of this.states) if (entry.expiresAt <= now) this.states.delete(key);
    // Evicting a tenth at once keeps inserts amortised O(1) under a flood of new keys.
    while (this.states.size >= LOCAL_CAPACITY * 0.9) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
  }

  size(): number {
    return this.states.size;
  }
}

/** Minimal Durable Object namespace surface used by the limiter and the real-time hub. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

export interface RateLimiter {
  check(policy: RateLimitPolicyName, identity: string, cost?: number): Promise<RateDecision>;
}

/**
 * Every new identity reaches a Durable Object that does not exist yet; creating it in production
 * has been measured above 750 ms. The bound must cover that cold start, or first requests for a
 * key (for example each invitation token) always fall back.
 */
export const COORDINATION_TIMEOUT_MS = 3_000;

export class CoordinatedRateLimiter implements RateLimiter {
  private readonly overrides: Map<string, RateLimitOverride>;

  constructor(
    private readonly namespace: DurableObjectNamespaceLike | null,
    private readonly local: LocalRateLimiter,
    overrides: RateLimitOverride[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.overrides = new Map(overrides.map((override) => [override.policy, override]));
  }

  private effective(policy: RateLimitPolicyName): RateCheck & { policy: RateLimitPolicy } {
    const base: RateLimitPolicy = RATE_LIMIT_POLICIES[policy];
    const override = this.overrides.get(policy);
    const factor = override && Date.parse(override.expiresAt) > this.now() ? override.factor : 1;
    return { limit: Math.max(1, Math.round(base.limit * factor)), windowSeconds: base.windowSeconds, cost: 1, progressive: base.progressive, policy: base };
  }

  async check(policy: RateLimitPolicyName, identity: string, cost = 1): Promise<RateDecision> {
    const effective = { ...this.effective(policy), cost };
    const key = `${policy}:${await sha256Hex(`${policy}|${identity}`)}`;
    if (!effective.policy.distributed || !this.namespace) {
      return { ...this.local.check(key, effective), source: "local" };
    }
    try {
      const stub = this.namespace.get(this.namespace.idFromName(key));
      const response = await withTimeout("rate-limit", COORDINATION_TIMEOUT_MS, (signal) => stub.fetch("https://rate-limiter.internal/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: effective.limit, windowSeconds: effective.windowSeconds, cost, progressive: effective.progressive ?? null }),
        signal,
      }));
      if (!response.ok) throw new Error(`rate limiter answered ${response.status}`);
      const decision = (await response.json()) as Omit<RateDecision, "source">;
      return { ...decision, source: "distributed" };
    } catch (error) {
      metric("ratelimit.coordination_failure", 1, { policy, failureMode: effective.policy.failureMode });
      logEvent("warn", "rate_limit_fallback", { policy, failureMode: effective.policy.failureMode, ...errorFields(error, false) });
      if (effective.policy.failureMode === "closed") {
        return { allowed: false, remaining: 0, retryAfterSeconds: 30, source: "fallback" };
      }
      const limit = effective.policy.failureMode === "local-strict" ? Math.max(1, Math.ceil(effective.limit / 4)) : effective.limit;
      return { ...this.local.check(`fallback:${key}`, { ...effective, limit }), source: "fallback" };
    }
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many requests. Try again later.");
  }
}

/**
 * Client address for rate limiting. On Cloudflare only CF-Connecting-IP is trustworthy; a
 * client can put anything in X-Forwarded-For, so it is read only when the deployment says a
 * proxy it controls sets it (local development and tests behind the Vite proxy).
 */
export function clientAddress(headers: Headers, trustForwardedFor: boolean): string {
  const connecting = headers.get("cf-connecting-ip")?.trim();
  if (connecting) return connecting;
  if (trustForwardedFor) {
    const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return "unknown";
}

/** Kept for callers that only need a bounded string key. */
export function clientKey(headers: Headers, suffix: string, trustForwardedFor = true): string {
  const address = clientAddress(headers, trustForwardedFor);
  return `${address === "unknown" ? "local" : address}:${suffix}`;
}

const fallbackLimiter = new CoordinatedRateLimiter(null, new LocalRateLimiter());

/**
 * Enforces `policy` for the identity parts given, e.g. the client address and the signed-in
 * user. Identity parts must come from the server (session, connecting IP, hashed values),
 * never from fields a client may choose freely to escape its own limit.
 */
export async function enforceRateLimit(c: Context<AppEnv>, policy: RateLimitPolicyName, ...identity: string[]): Promise<void> {
  await enforce(c, policy, identity, 1);
}

/** Refuses when the identity has used its quota, without counting this request. */
export async function peekRateLimit(c: Context<AppEnv>, policy: RateLimitPolicyName, ...identity: string[]): Promise<void> {
  await enforce(c, policy, identity, 0);
}

/** Counts one event (for example a failed sign-in) without refusing the current request. */
export async function recordRateLimitHit(c: Context<AppEnv>, policy: RateLimitPolicyName, ...identity: string[]): Promise<void> {
  const limiter = c.get("deps").rateLimiter ?? fallbackLimiter;
  await limiter.check(policy, identity.join("|"), 1);
}

async function enforce(c: Context<AppEnv>, policy: RateLimitPolicyName, identity: string[], cost: number): Promise<void> {
  const limiter = c.get("deps").rateLimiter ?? fallbackLimiter;
  const decision = await limiter.check(policy, identity.join("|"), cost);
  if (!decision.allowed) {
    metric("ratelimit.rejected", 1, { policy, source: decision.source });
    annotate(c, { rateLimited: policy, rateLimitSource: decision.source });
    throw new RateLimitedError(decision.retryAfterSeconds);
  }
}

export function requestAddress(c: Context<AppEnv>): string {
  return clientAddress(c.req.raw.headers, c.get("deps").config.rateLimit.trustForwardedFor);
}
