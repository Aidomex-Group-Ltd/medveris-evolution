import type { Sql } from "@medveris/db";
import { logEvent, metric } from "@medveris/platform";
import { loadAuthContext, SESSION_COOKIE } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import type { DurableObjectNamespaceLike } from "../lib/rate-limit.js";
import { CONTEXT_HEADER } from "../durable/realtime-hub.js";
import { hubName, ticketFromProtocols, verifyTicket } from "./tickets.js";

export const REALTIME_CONNECT_PATH = "/api/v1/realtime/connect";

export function isRealtimeUpgrade(request: Request): boolean {
  return new URL(request.url).pathname === REALTIME_CONNECT_PATH && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function refuse(status: number, reason: string): Response {
  metric("realtime.connect", 1, { outcome: "refused", reason });
  return new Response(JSON.stringify({ error: { code: "realtime_refused", message: "Live updates connection refused" } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store, private" },
  });
}

function sessionToken(request: Request): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Authenticates a WebSocket upgrade before anything is accepted: the Origin must be allowlisted
 * (browsers always send it on WebSocket handshakes, so this stops cross-site hijacking), the
 * session cookie must be valid with MFA for staff, and the ticket must match that session,
 * user and facility. The hub receives only a context built here; any client copy of the
 * context header is discarded.
 */
export async function handleRealtimeUpgrade(request: Request, input: { sql: Sql; config: AppConfig; hubs: DurableObjectNamespaceLike | null }): Promise<Response> {
  const { config } = input;
  if (!config.realtime.enabled || !input.hubs) return refuse(503, "disabled");
  const origin = request.headers.get("origin");
  if (!origin || !config.realtime.allowedOrigins.includes(origin)) return refuse(403, "origin");
  const token = sessionToken(request);
  if (!token) return refuse(401, "no-session");
  const auth = await loadAuthContext(input.sql, token).catch(() => null);
  if (!auth) return refuse(401, "session");
  if (auth.activeTenant && !auth.mfaVerified) return refuse(403, "mfa");
  const verified = await verifyTicket(config.sessionSecret, ticketFromProtocols(request.headers.get("sec-websocket-protocol")), {
    userId: auth.user.id,
    sessionId: auth.session.id,
    tenantId: auth.activeTenant?.id ?? null,
  });
  if (!verified.ok) return refuse(403, `ticket-${verified.reason}`);
  const claims = verified.claims;
  const expiresAt = Math.min(auth.session.expiresAt.getTime(), Date.now() + config.realtime.maxConnectionSeconds * 1000);
  const headers = new Headers({ upgrade: "websocket", connection: "Upgrade" });
  headers.set(CONTEXT_HEADER, JSON.stringify({ uid: claims.uid, tid: claims.tid, channels: claims.channels, nonce: claims.nonce, expiresAt }));
  const stub = input.hubs.get(input.hubs.idFromName(hubName(claims)));
  const response = await stub.fetch(new Request("https://realtime.internal/connect", { method: "GET", headers }));
  metric("realtime.connect", 1, { outcome: response.status === 101 ? "accepted" : "hub-refused", status: response.status });
  if (response.status !== 101) logEvent("warn", "realtime_hub_refused", { status: response.status });
  return response;
}
