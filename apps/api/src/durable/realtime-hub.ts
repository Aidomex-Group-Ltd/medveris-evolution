import { z } from "zod";
import type { DurableStateLike, HibernatableSocket } from "./types.js";

/**
 * Real-time hub: one instance per facility (staff) or per user (patients). It is a delivery
 * optimisation, not a record: events carry a type and an opaque reference only, and clients
 * fetch the actual data through the authenticated API, which re-applies authorization. Lost or
 * expired events are signalled with `resync` so the client reloads state.
 *
 * Connections use the WebSocket Hibernation API, so idle sockets cost nothing and survive the
 * object being evicted; per-connection state lives in the socket attachment.
 */

export const CONTEXT_HEADER = "x-medveris-realtime-context";
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_CONNECTIONS_PER_USER = 5;
export const MAX_CONNECTIONS_PER_HUB = 2000;
export const REPLAY_LIMIT = 200;
export const REPLAY_WINDOW_MS = 15 * 60_000;
const CLIENT_MESSAGES_PER_WINDOW = 20;
const CLIENT_WINDOW_MS = 10_000;
const STALE_AFTER_MS = 90_000;
const SWEEP_INTERVAL_MS = 60_000;

export interface ConnectionContext {
  uid: string;
  tid: string | null;
  channels: string[];
  nonce: string;
  /** The connection is closed at this time and must re-authenticate with a new ticket. */
  expiresAt: number;
}

interface Attachment extends ConnectionContext {
  subscribed: string[];
  windowStart: number;
  messages: number;
  connectedAt: number;
}

export interface RealtimeEvent {
  channel: string;
  seq: number;
  type: string;
  ref: string | null;
  at: number;
}

const channelName = z.string().regex(/^(tenant|operations|user:[0-9a-f-]{36})$/i);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribe"), channel: channelName, afterSeq: z.number().int().min(0).optional() }),
  z.strictObject({ type: z.literal("unsubscribe"), channel: channelName }),
  z.strictObject({ type: z.literal("ping") }),
]);

const publishSchema = z.strictObject({
  channel: channelName,
  type: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9_-]+)+$/).max(100),
  ref: z.string().regex(/^[0-9a-f-]{36}$/i).nullable(),
  /** Restricts a tenant-channel event to one user's sockets, e.g. a personal notification. */
  userId: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
});

const contextSchema = z.strictObject({
  uid: z.string().regex(/^[0-9a-f-]{36}$/i),
  tid: z.string().regex(/^[0-9a-f-]{36}$/i).nullable(),
  channels: z.array(channelName).min(1).max(10),
  nonce: z.string().min(16).max(64),
  expiresAt: z.number().int().positive(),
});

export interface SocketPairFactory {
  (): { client: unknown; server: HibernatableSocket };
}

export interface HubEnvironment {
  now?: () => number;
  createPair?: SocketPairFactory;
  /** Builds the 101 response; Workers needs `webSocket` in the init. */
  upgradeResponse?: (client: unknown, protocol: string) => Response;
}

function defaultPair(): { client: unknown; server: HibernatableSocket } {
  const Pair = (globalThis as unknown as { WebSocketPair?: new () => Record<0 | 1, unknown> }).WebSocketPair;
  if (!Pair) throw new Error("WebSocketPair is only available on Cloudflare Workers");
  const pair = new Pair();
  return { client: pair[0], server: pair[1] as HibernatableSocket };
}

function defaultUpgrade(client: unknown, protocol: string): Response {
  return new Response(null, { status: 101, headers: { "sec-websocket-protocol": protocol }, webSocket: client } as ResponseInit);
}

function send(socket: HibernatableSocket, message: Record<string, unknown>): boolean {
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export class RealtimeHub {
  private readonly now: () => number;
  private readonly createPair: SocketPairFactory;
  private readonly upgrade: (client: unknown, protocol: string) => Response;

  constructor(private readonly ctx: DurableStateLike, env?: unknown) {
    const hubEnv = (env ?? {}) as HubEnvironment;
    this.now = hubEnv.now ?? Date.now;
    this.createPair = hubEnv.createPair ?? defaultPair;
    this.upgrade = hubEnv.upgradeResponse ?? defaultUpgrade;
    const Pair = (globalThis as unknown as { WebSocketRequestResponsePair?: new (request: string, response: string) => unknown }).WebSocketRequestResponsePair;
    // Heartbeats are answered by the runtime without waking the object.
    if (Pair && ctx.setWebSocketAutoResponse) ctx.setWebSocketAutoResponse(new Pair('{"type":"ping"}', '{"type":"pong"}'));
  }

  private sockets(tag?: string): HibernatableSocket[] {
    return this.ctx.getWebSockets?.(tag) ?? [];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.connect(request);
    if (url.pathname === "/publish" && request.method === "POST") return this.publish(request);
    if (url.pathname === "/revoke" && request.method === "POST") return this.revoke(request);
    if (url.pathname === "/stats") return Response.json({ connections: this.sockets().length });
    return new Response("not found", { status: 404 });
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
    let context: ConnectionContext;
    try {
      context = contextSchema.parse(JSON.parse(request.headers.get(CONTEXT_HEADER) ?? "null"));
    } catch {
      return new Response("forbidden", { status: 403 });
    }
    const now = this.now();
    if (context.expiresAt <= now) return new Response("expired", { status: 403 });
    const nonceKey = `nonce:${context.nonce}`;
    if (await this.ctx.storage.get(nonceKey)) return new Response("ticket already used", { status: 403 });
    await this.ctx.storage.put(nonceKey, now + REPLAY_WINDOW_MS);
    if (this.sockets().length >= MAX_CONNECTIONS_PER_HUB) return new Response("hub at capacity", { status: 503 });
    if (this.sockets(`user:${context.uid}`).length >= MAX_CONNECTIONS_PER_USER) return new Response("too many connections", { status: 429 });

    const { client, server } = this.createPair();
    this.ctx.acceptWebSocket?.(server, [`user:${context.uid}`]);
    const attachment: Attachment = { ...context, subscribed: [], windowStart: now, messages: 0, connectedAt: now };
    server.serializeAttachment(attachment);
    send(server, { type: "ready", channels: context.channels, expiresAt: context.expiresAt });
    await this.ensureSweep();
    return this.upgrade(client, "medveris.realtime.v1");
  }

  private async ensureSweep(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(this.now() + SWEEP_INTERVAL_MS);
  }

  private async nextSeq(channel: string): Promise<number> {
    const key = `seq:${channel}`;
    const seq = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
    await this.ctx.storage.put(key, seq);
    return seq;
  }

  private async log(channel: string): Promise<RealtimeEvent[]> {
    return (await this.ctx.storage.get<RealtimeEvent[]>(`log:${channel}`)) ?? [];
  }

  private async publish(request: Request): Promise<Response> {
    const parsed = publishSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("invalid event", { status: 400 });
    const { channel, type, ref, userId } = parsed.data;
    const now = this.now();
    // Personal events are not retained in the shared replay log; they are re-read from the API.
    const event: RealtimeEvent = { channel, seq: userId ? 0 : await this.nextSeq(channel), type, ref, at: now };
    if (!userId) {
      const retained = (await this.log(channel)).filter((item) => now - item.at <= REPLAY_WINDOW_MS);
      retained.push(event);
      await this.ctx.storage.put(`log:${channel}`, retained.slice(-REPLAY_LIMIT));
    }
    let delivered = 0;
    let failed = 0;
    for (const socket of this.sockets(userId ? `user:${userId}` : undefined)) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.expiresAt <= now || !attachment.subscribed.includes(channel)) continue;
      if (send(socket, { type: "event", channel, seq: event.seq, event: type, ref, at: now })) delivered += 1;
      else failed += 1;
    }
    return Response.json({ seq: event.seq, delivered, failed });
  }

  private async revoke(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { userId?: unknown } | null;
    if (typeof body?.userId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.userId)) return new Response("invalid", { status: 400 });
    let closed = 0;
    for (const socket of this.sockets(`user:${body.userId}`)) {
      socket.close(4001, "session ended");
      closed += 1;
    }
    return Response.json({ closed });
  }

  async webSocketMessage(socket: HibernatableSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    const now = this.now();
    if (!attachment) {
      socket.close(1008, "unknown connection");
      return;
    }
    if (attachment.expiresAt <= now) {
      send(socket, { type: "reauthenticate" });
      socket.close(4001, "re-authentication required");
      return;
    }
    const size = typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (typeof raw !== "string" || size > MAX_MESSAGE_BYTES) {
      socket.close(1009, "message too large or not text");
      return;
    }
    if (now - attachment.windowStart >= CLIENT_WINDOW_MS) {
      attachment.windowStart = now;
      attachment.messages = 0;
    }
    attachment.messages += 1;
    if (attachment.messages > CLIENT_MESSAGES_PER_WINDOW) {
      socket.close(1008, "message rate exceeded");
      return;
    }
    let message: z.infer<typeof clientMessageSchema>;
    try {
      message = clientMessageSchema.parse(JSON.parse(raw));
    } catch {
      socket.serializeAttachment(attachment);
      send(socket, { type: "error", code: "invalid-message" });
      return;
    }
    if (message.type === "ping") {
      socket.serializeAttachment(attachment);
      send(socket, { type: "pong" });
      return;
    }
    if (!attachment.channels.includes(message.channel)) {
      socket.serializeAttachment(attachment);
      send(socket, { type: "error", code: "forbidden-channel", channel: message.channel });
      return;
    }
    if (message.type === "unsubscribe") {
      attachment.subscribed = attachment.subscribed.filter((channel) => channel !== message.channel);
      socket.serializeAttachment(attachment);
      send(socket, { type: "unsubscribed", channel: message.channel });
      return;
    }
    if (!attachment.subscribed.includes(message.channel)) attachment.subscribed.push(message.channel);
    socket.serializeAttachment(attachment);
    const latest = (await this.ctx.storage.get<number>(`seq:${message.channel}`)) ?? 0;
    send(socket, { type: "subscribed", channel: message.channel, seq: latest });
    if (message.afterSeq === undefined || message.afterSeq >= latest) return;
    const retained = (await this.log(message.channel)).filter((event) => now - event.at <= REPLAY_WINDOW_MS);
    const oldest = retained[0]?.seq ?? latest + 1;
    if (message.afterSeq + 1 < oldest) {
      send(socket, { type: "resync", channel: message.channel, seq: latest });
      return;
    }
    for (const event of retained) {
      if (event.seq > message.afterSeq) send(socket, { type: "event", channel: event.channel, seq: event.seq, event: event.type, ref: event.ref, at: event.at, replayed: true });
    }
  }

  async webSocketClose(socket: HibernatableSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(socket: HibernatableSocket): Promise<void> {
    try {
      socket.close(1011, "error");
    } catch {
      /* already closed */
    }
  }

  /** Closes expired and silent connections, forgets used ticket nonces, and keeps sweeping while sockets remain. */
  async alarm(): Promise<void> {
    const now = this.now();
    for (const socket of this.sockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp?.(socket)?.getTime() ?? attachment?.connectedAt ?? 0;
      if (!attachment || attachment.expiresAt <= now) {
        send(socket, { type: "reauthenticate" });
        socket.close(4001, "re-authentication required");
      } else if (now - Math.max(lastPing, attachment.connectedAt) > STALE_AFTER_MS && now - attachment.windowStart > STALE_AFTER_MS) {
        socket.close(1001, "heartbeat missed");
      }
    }
    const nonces = await this.ctx.storage.list<number>({ prefix: "nonce:" });
    for (const [key, expires] of nonces) if (expires <= now) await this.ctx.storage.delete(key);
    if (this.sockets().length || nonces.size) await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
  }
}
