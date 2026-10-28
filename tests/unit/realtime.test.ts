import { describe, expect, it } from "vitest";
import { authorizedChannels, hubName, issueTicket, ticketFromProtocols, verifyTicket } from "../../apps/api/src/realtime/tickets.js";
import { CONTEXT_HEADER, MAX_CONNECTIONS_PER_USER, MAX_MESSAGE_BYTES, RealtimeHub, REPLAY_LIMIT } from "../../apps/api/src/durable/realtime-hub.js";
import type { DurableStateLike, HibernatableSocket } from "../../apps/api/src/durable/types.js";
import { nextBackoffMs, SequenceTracker } from "../../apps/web/src/lib/realtime-protocol.js";

const SECRET = "realtime-test-session-secret-value";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT = "11111111-1111-4111-8111-111111111111";
const SESSION = "session-1";

class FakeSocket implements HibernatableSocket {
  sent: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | null = null;
  private attachment: unknown = null;
  constructor(readonly tags: string[] = []) {}
  send(message: string): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(JSON.parse(message));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
  last(): Record<string, unknown> | undefined {
    return this.sent[this.sent.length - 1];
  }
}

function hubHarness(start = 1_000_000) {
  let now = start;
  const data = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  let alarm: number | null = null;
  const ctx: DurableStateLike = {
    storage: {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: async <T>(key: string, value: T) => { data.set(key, structuredClone(value)); },
      delete: async (key: string) => data.delete(key),
      deleteAll: async () => { data.clear(); },
      setAlarm: async (time: number) => { alarm = time; },
      getAlarm: async () => alarm,
      list: async <T>({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>,
    },
    blockConcurrencyWhile: (fn) => fn(),
    acceptWebSocket: (socket, tags) => {
      const fake = socket as FakeSocket;
      fake.tags.push(...(tags ?? []));
      sockets.push(fake);
    },
    getWebSockets: (tag) => sockets.filter((socket) => !socket.closed && (!tag || socket.tags.includes(tag))),
  };
  const hub = new RealtimeHub(ctx, {
    now: () => now,
    createPair: () => {
      const server = new FakeSocket();
      return { client: server, server };
    },
    upgradeResponse: (client: unknown) => {
      const response = new Response(null, { status: 200, headers: { "x-test-upgrade": "1" } });
      (response as unknown as { socket: unknown }).socket = client;
      return response;
    },
  });
  async function connect(context: Partial<{ uid: string; tid: string | null; channels: string[]; nonce: string; expiresAt: number }> = {}): Promise<{ response: Response; socket: FakeSocket | null }> {
    const headers = new Headers({ upgrade: "websocket" });
    headers.set(CONTEXT_HEADER, JSON.stringify({
      uid: USER, tid: TENANT, channels: ["tenant", `user:${USER}`], nonce: crypto.randomUUID().replaceAll("-", ""), expiresAt: now + 600_000, ...context,
    }));
    const response = await hub.fetch(new Request("https://realtime.internal/connect", { headers }));
    return { response, socket: (response as unknown as { socket?: FakeSocket }).socket ?? null };
  }
  async function publish(body: Record<string, unknown>) {
    return hub.fetch(new Request("https://realtime.internal/publish", { method: "POST", body: JSON.stringify(body) }));
  }
  return { hub, connect, publish, sockets, data, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("real-time tickets", () => {
  it("binds the ticket to user, session and facility and expires it", async () => {
    const now = Date.now();
    const { ticket } = await issueTicket(SECRET, { userId: USER, sessionId: SESSION, tenantId: TENANT, channels: ["tenant"], ttlSeconds: 30 }, now);
    const expected = { userId: USER, sessionId: SESSION, tenantId: TENANT };
    expect((await verifyTicket(SECRET, ticket, expected, now)).ok).toBe(true);
    expect(await verifyTicket(SECRET, ticket, { ...expected, userId: OTHER_USER }, now)).toEqual({ ok: false, reason: "wrong-user" });
    expect(await verifyTicket(SECRET, ticket, { ...expected, sessionId: "session-2" }, now)).toEqual({ ok: false, reason: "wrong-session" });
    expect(await verifyTicket(SECRET, ticket, { ...expected, tenantId: null }, now)).toEqual({ ok: false, reason: "wrong-facility" });
    expect(await verifyTicket(SECRET, ticket, expected, now + 31_000)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyTicket("another-secret-value-entirely", ticket, expected, now)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a ticket whose claims were altered, e.g. to add a channel", async () => {
    const { ticket } = await issueTicket(SECRET, { userId: USER, sessionId: SESSION, tenantId: TENANT, channels: ["tenant"], ttlSeconds: 30 });
    const [body, signature] = ticket.split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    claims.channels.push("operations");
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect((await verifyTicket(SECRET, forged, { userId: USER, sessionId: SESSION, tenantId: TENANT })).ok).toBe(false);
  });

  it("reads the ticket only from the subprotocol header alongside the application protocol", () => {
    expect(ticketFromProtocols("medveris.realtime.v1, ticket.abc.def")).toBe("abc.def");
    expect(ticketFromProtocols("ticket.abc.def")).toBeNull();
    expect(ticketFromProtocols(null)).toBeNull();
  });

  it("derives channels from server-side roles and places staff in their facility's hub", () => {
    expect(authorizedChannels({ userId: USER, tenantId: TENANT, roles: ["clinician"] })).toEqual([`user:${USER}`, "tenant"]);
    expect(authorizedChannels({ userId: USER, tenantId: TENANT, roles: ["facility_admin"] })).toContain("operations");
    expect(authorizedChannels({ userId: USER, tenantId: null, roles: [] })).toEqual([`user:${USER}`]);
    expect(hubName({ uid: USER, tid: TENANT })).toBe(`tenant:${TENANT}`);
    expect(hubName({ uid: USER, tid: null })).toBe(`user:${USER}`);
  });
});

describe("real-time hub", () => {
  it("accepts a connection once per ticket nonce and limits connections per user", async () => {
    const h = hubHarness();
    const first = await h.connect({ nonce: "nonce-aaaaaaaaaaaaaaaa" });
    expect(first.socket?.sent[0]).toMatchObject({ type: "ready" });
    expect((await h.connect({ nonce: "nonce-aaaaaaaaaaaaaaaa" })).response.status).toBe(403);
    for (let i = 1; i < MAX_CONNECTIONS_PER_USER; i += 1) expect((await h.connect()).socket).not.toBeNull();
    expect((await h.connect()).response.status).toBe(429);
  });

  it("refuses connections without a valid server-built context", async () => {
    const h = hubHarness();
    const missing = await h.hub.fetch(new Request("https://realtime.internal/connect", { headers: { upgrade: "websocket" } }));
    expect(missing.status).toBe(403);
    expect((await h.connect({ channels: ["everything"] })).response.status).toBe(403);
    expect((await h.connect({ expiresAt: h.now() - 1 })).response.status).toBe(403);
  });

  it("only lets a connection subscribe to channels it was authorised for", async () => {
    const h = hubHarness();
    const { socket } = await h.connect({ channels: [`user:${USER}`, "tenant"] });
    await h.hub.webSocketMessage(socket!, JSON.stringify({ type: "subscribe", channel: "operations" }));
    expect(socket!.last()).toEqual({ type: "error", code: "forbidden-channel", channel: "operations" });
    await h.hub.webSocketMessage(socket!, JSON.stringify({ type: "subscribe", channel: `user:${OTHER_USER}` }));
    expect(socket!.last()).toMatchObject({ code: "forbidden-channel" });
    await h.hub.webSocketMessage(socket!, JSON.stringify({ type: "subscribe", channel: "tenant" }));
    expect(socket!.last()).toMatchObject({ type: "subscribed", channel: "tenant" });
  });

  it("rejects unexpected fields, oversized and binary messages, and message floods", async () => {
    const h = hubHarness();
    const { socket } = await h.connect();
    await h.hub.webSocketMessage(socket!, JSON.stringify({ type: "subscribe", channel: "tenant", tenantId: TENANT }));
    expect(socket!.last()).toEqual({ type: "error", code: "invalid-message" });
    await h.hub.webSocketMessage(socket!, "x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(socket!.closed?.code).toBe(1009);

    const binary = (await h.connect()).socket!;
    await h.hub.webSocketMessage(binary, new ArrayBuffer(8));
    expect(binary.closed?.code).toBe(1009);

    const flood = (await h.connect()).socket!;
    for (let i = 0; i < 21; i += 1) await h.hub.webSocketMessage(flood, JSON.stringify({ type: "ping" }));
    expect(flood.closed?.code).toBe(1008);
  });

  it("delivers events with increasing sequence numbers only to subscribers, carrying a reference and no record content", async () => {
    const h = hubHarness();
    const subscriber = (await h.connect()).socket!;
    const bystander = (await h.connect()).socket!;
    await h.hub.webSocketMessage(subscriber, JSON.stringify({ type: "subscribe", channel: "tenant" }));
    const ref = "0e3daf50-7a54-4107-9e7b-44794cf475b7";
    await h.publish({ channel: "tenant", type: "encounter.state.changed", ref });
    await h.publish({ channel: "tenant", type: "encounter.state.changed", ref });
    const events = subscriber.sent.filter((message) => message.type === "event");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(Object.keys(events[0]!).sort()).toEqual(["at", "channel", "event", "ref", "seq", "type"]);
    expect(bystander.sent.filter((message) => message.type === "event")).toHaveLength(0);
    expect((await h.publish({ channel: "tenant", type: "encounter.state.changed", ref, patient: { name: "x" } })).status).toBe(400);
  });

  it("replays missed events after reconnecting and asks for a resync when the gap is too old", async () => {
    const h = hubHarness();
    for (let i = 0; i < 5; i += 1) await h.publish({ channel: "tenant", type: "content.published", ref: null });
    const resumed = (await h.connect()).socket!;
    await h.hub.webSocketMessage(resumed, JSON.stringify({ type: "subscribe", channel: "tenant", afterSeq: 3 }));
    expect(resumed.sent.filter((message) => message.type === "event").map((event) => event.seq)).toEqual([4, 5]);

    for (let i = 0; i < REPLAY_LIMIT + 10; i += 1) await h.publish({ channel: "tenant", type: "content.published", ref: null });
    const lagging = (await h.connect()).socket!;
    await h.hub.webSocketMessage(lagging, JSON.stringify({ type: "subscribe", channel: "tenant", afterSeq: 1 }));
    expect(lagging.last()).toMatchObject({ type: "resync", channel: "tenant" });
  });

  it("closes expired connections for re-authentication and on session revocation", async () => {
    const h = hubHarness();
    const { socket } = await h.connect({ expiresAt: h.now() + 1_000 });
    const other = (await h.connect({ uid: OTHER_USER, channels: ["tenant"] })).socket!;
    h.advance(2_000);
    await h.hub.webSocketMessage(socket!, JSON.stringify({ type: "ping" }));
    expect(socket!.closed?.code).toBe(4001);
    const revoke = await h.hub.fetch(new Request("https://realtime.internal/revoke", { method: "POST", body: JSON.stringify({ userId: OTHER_USER }) }));
    expect(await revoke.json()).toEqual({ closed: 1 });
    expect(other.closed?.code).toBe(4001);
  });

  it("sweeps expired and silent connections and forgets used nonces", async () => {
    const h = hubHarness();
    const expiring = (await h.connect({ expiresAt: h.now() + 1_000 })).socket!;
    const silent = (await h.connect()).socket!;
    h.advance(120_000);
    await h.hub.alarm();
    expect(expiring.closed?.code).toBe(4001);
    expect(silent.closed?.code).toBe(1001);
    h.advance(20 * 60_000);
    await h.hub.alarm();
    expect([...h.data.keys()].filter((key) => key.startsWith("nonce:"))).toHaveLength(0);
  });
});

describe("real-time client protocol", () => {
  it("backs off exponentially with jitter up to a cap", () => {
    expect(nextBackoffMs(0, () => 0.999)).toBeLessThan(1_000);
    expect(nextBackoffMs(10, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(nextBackoffMs(10, () => 0.999)).toBeGreaterThanOrEqual(15_000);
  });

  it("deduplicates repeated events and reports gaps", () => {
    const tracker = new SequenceTracker();
    expect(tracker.accept("tenant", 1)).toBe("new");
    expect(tracker.accept("tenant", 1)).toBe("duplicate");
    expect(tracker.accept("tenant", 3)).toBe("gap");
    expect(tracker.last("tenant")).toBe(3);
    expect(tracker.accept("tenant", 0)).toBe("new");
  });
});
