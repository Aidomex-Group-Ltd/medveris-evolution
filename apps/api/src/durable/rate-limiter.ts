import { applyRateCheck, emptyState, stateExpiry, type RateCheck, type RateLimitState } from "../lib/rate-limit.js";
import type { DurableStateLike } from "./types.js";

const STATE_KEY = "state";

function validCheck(value: unknown): value is RateCheck {
  if (!value || typeof value !== "object") return false;
  const check = value as Partial<RateCheck> & { progressive?: unknown };
  const positive = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= max;
  const cost = check.cost;
  if (typeof cost !== "number" || !Number.isInteger(cost) || cost < 0 || cost > 1_000) return false;
  if (!positive(check.limit, 100_000) || !positive(check.windowSeconds, 86_400)) return false;
  if (check.progressive == null) return true;
  const progressive = check.progressive as { cooldownSeconds?: unknown; maxCooldownSeconds?: unknown };
  return positive(progressive.cooldownSeconds, 86_400) && positive(progressive.maxCooldownSeconds, 86_400);
}

/**
 * One instance per (policy, hashed identity). A Durable Object processes one request at a time,
 * so concurrent requests from every Worker instance see a single, exact counter. The state is
 * one small record; an alarm deletes it once it can no longer affect a decision, so storage
 * stays bounded however many keys an attacker generates.
 */
export class RateLimiterObject {
  private state: RateLimitState | null = null;

  constructor(private readonly ctx: DurableStateLike, _env?: unknown, private readonly now: () => number = Date.now) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const raw = body as Record<string, unknown>;
    const check = { ...raw, progressive: raw?.progressive ?? undefined };
    if (!validCheck(check)) return new Response("invalid check", { status: 400 });
    const now = this.now();
    if (!this.state) this.state = (await this.ctx.storage.get<RateLimitState>(STATE_KEY)) ?? emptyState(now);
    const before = JSON.stringify(this.state);
    const { state, decision } = applyRateCheck(this.state, check, now);
    this.state = state;
    if (JSON.stringify(state) !== before) await this.ctx.storage.put(STATE_KEY, state);
    const expiry = stateExpiry(state, check);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm < expiry) await this.ctx.storage.setAlarm(expiry);
    return Response.json(decision);
  }

  async alarm(): Promise<void> {
    this.state = null;
    await this.ctx.storage.deleteAll();
  }
}
