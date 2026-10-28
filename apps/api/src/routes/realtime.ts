import { Hono } from "hono";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { DependencyError } from "../lib/errors.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { authorizedChannels, issueTicket, REALTIME_PROTOCOL } from "../realtime/tickets.js";
import type { AppEnv } from "../types.js";

export const realtimeRoutes = new Hono<AppEnv>();

/**
 * Issues a single-use connection ticket. Requires the session cookie and the CSRF header
 * (enforced by the auth middleware for POST), staff MFA when a facility is active, and is
 * rate limited per user. Clients that get 503 here fall back to refreshing through the API.
 */
realtimeRoutes.post("/realtime/tickets", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.realtime.enabled || !deps.realtime) throw new DependencyError("Live updates are not available");
  const auth = requireAuth(c);
  if (auth.activeTenant) requireStaff(c);
  await enforceRateLimit(c, "realtime.connect", auth.user.id);
  const channels = authorizedChannels({ userId: auth.user.id, tenantId: auth.activeTenant?.id ?? null, roles: auth.activeTenant?.roles ?? [] });
  const { ticket, claims } = await issueTicket(deps.config.sessionSecret, {
    userId: auth.user.id,
    sessionId: auth.session.id,
    tenantId: auth.activeTenant?.id ?? null,
    channels,
    ttlSeconds: deps.config.realtime.ticketTtlSeconds,
  });
  return c.json({
    ticket,
    protocol: REALTIME_PROTOCOL,
    path: "/api/v1/realtime/connect",
    channels,
    ticketExpiresAt: new Date(claims.exp).toISOString(),
    maxConnectionSeconds: deps.config.realtime.maxConnectionSeconds,
  });
});

/** WebSocket upgrades are handled by the Worker before routing; anything reaching here is not an upgrade. */
realtimeRoutes.get("/realtime/connect", (c) => c.json({ error: { code: "upgrade_required", message: "Connect with a WebSocket client", correlationId: c.get("correlationId") } }, 426));
