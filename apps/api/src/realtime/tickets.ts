import { b64url, fromB64url, hmacHex, randomToken, sha256Hex } from "@medveris/auth";
import type { Role } from "@medveris/authz";

/**
 * Real-time connection tickets. A ticket is issued by an authenticated, CSRF-protected POST and
 * presented once in the Sec-WebSocket-Protocol header (never in a URL). It binds the user, the
 * session, the active facility and the channels that user may subscribe to, and expires within
 * seconds. The session cookie is still verified at the upgrade; the ticket proves the upgrade
 * was started by this application's own script, and its nonce is accepted only once.
 */
export const REALTIME_PROTOCOL = "medveris.realtime.v1";
const TICKET_PREFIX = "ticket.";

export interface TicketClaims {
  v: 1;
  uid: string;
  /** SHA-256 of the session ID, so a ticket cannot be used with another session of the same user. */
  sid: string;
  tid: string | null;
  channels: string[];
  exp: number;
  nonce: string;
}

const OPERATIONS_ROLES: readonly Role[] = ["facility_admin", "department_lead", "auditor"];

/** Channels are decided on the server from roles; a client can only narrow, never widen, them. */
export function authorizedChannels(input: { userId: string; tenantId: string | null; roles: readonly Role[] }): string[] {
  const channels = [`user:${input.userId}`];
  if (input.tenantId) {
    channels.push("tenant");
    if (input.roles.some((role) => OPERATIONS_ROLES.includes(role))) channels.push("operations");
  }
  return channels;
}

/** Durable Object instance that holds a connection: one per facility for staff, one per user otherwise. */
export function hubName(claims: Pick<TicketClaims, "uid" | "tid">): string {
  return claims.tid ? `tenant:${claims.tid}` : `user:${claims.uid}`;
}

function signingSecret(sessionSecret: string): string {
  return `realtime-ticket-v1:${sessionSecret}`;
}

export async function issueTicket(
  sessionSecret: string,
  input: { userId: string; sessionId: string; tenantId: string | null; channels: string[]; ttlSeconds: number },
  now = Date.now(),
): Promise<{ ticket: string; claims: TicketClaims }> {
  const claims: TicketClaims = {
    v: 1,
    uid: input.userId,
    sid: await sha256Hex(`realtime-session:${input.sessionId}`),
    tid: input.tenantId,
    channels: input.channels,
    exp: now + input.ttlSeconds * 1000,
    nonce: randomToken(16),
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await hmacHex(signingSecret(sessionSecret), body);
  return { ticket: `${body}.${signature}`, claims };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type TicketFailure = "missing" | "malformed" | "bad-signature" | "expired" | "wrong-user" | "wrong-session" | "wrong-facility";

/** Reads the ticket from the offered subprotocols; requires the application protocol alongside it. */
export function ticketFromProtocols(header: string | null): string | null {
  const offered = (header ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!offered.includes(REALTIME_PROTOCOL)) return null;
  const ticket = offered.find((value) => value.startsWith(TICKET_PREFIX));
  return ticket ? ticket.slice(TICKET_PREFIX.length) : null;
}

export async function verifyTicket(
  sessionSecret: string,
  ticket: string | null,
  expected: { userId: string; sessionId: string; tenantId: string | null },
  now = Date.now(),
): Promise<{ ok: true; claims: TicketClaims } | { ok: false; reason: TicketFailure }> {
  if (!ticket) return { ok: false, reason: "missing" };
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra !== undefined || ticket.length > 2048) return { ok: false, reason: "malformed" };
  const expectedSignature = await hmacHex(signingSecret(sessionSecret), body);
  if (!constantTimeEqual(signature, expectedSignature)) return { ok: false, reason: "bad-signature" };
  let claims: TicketClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TicketClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims.v !== 1 || !Array.isArray(claims.channels) || typeof claims.nonce !== "string") return { ok: false, reason: "malformed" };
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (claims.uid !== expected.userId) return { ok: false, reason: "wrong-user" };
  if (claims.sid !== (await sha256Hex(`realtime-session:${expected.sessionId}`))) return { ok: false, reason: "wrong-session" };
  if (claims.tid !== expected.tenantId) return { ok: false, reason: "wrong-facility" };
  return { ok: true, claims };
}
