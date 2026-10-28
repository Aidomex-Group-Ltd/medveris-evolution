import { useEffect, useRef } from "react";
import { api, ApiError } from "./api";
import { nextBackoffMs, SequenceTracker, type RealtimeEventMessage } from "./realtime-protocol";

interface TicketResponse {
  ticket: string;
  protocol: string;
  path: string;
  channels: string[];
}

export type RealtimeStatus = "connecting" | "live" | "reconnecting" | "unavailable" | "closed";

export interface RealtimeHandlers {
  onEvent(event: RealtimeEventMessage): void;
  /** Events were missed; reload the affected view from the API. */
  onResync(channel: string): void;
  onStatus?(status: RealtimeStatus): void;
}

const HEARTBEAT_MS = 25_000;

/**
 * Live-update connection. It is an optimisation: when it is unavailable the page keeps working
 * from API requests. Each (re)connection asks the API for a fresh single-use ticket, so an
 * expired or revoked session cannot reconnect. Missed events are replayed from the last seen
 * sequence number, or a resync is requested.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly tracker = new SequenceTracker();
  private readonly abort = new AbortController();

  constructor(private readonly channels: string[], private readonly handlers: RealtimeHandlers) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    this.socket?.close(1000, "page closed");
    this.handlers.onStatus?.("closed");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onStatus?.(this.attempt ? "reconnecting" : "connecting");
    let ticket: TicketResponse;
    try {
      ticket = await api<TicketResponse>("/realtime/tickets", { method: "POST", body: {}, signal: this.abort.signal });
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof ApiError && [401, 403, 503].includes(error.status)) {
        this.handlers.onStatus?.("unavailable");
        return;
      }
      this.scheduleReconnect();
      return;
    }
    const url = new URL(ticket.path, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, [ticket.protocol, `ticket.${ticket.ticket}`]);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus?.("live");
      for (const channel of this.channels.filter((name) => ticket.channels.includes(name))) {
        const afterSeq = this.tracker.last(channel);
        socket.send(JSON.stringify(afterSeq === undefined ? { type: "subscribe", channel } : { type: "subscribe", channel, afterSeq }));
      }
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('{"type":"ping"}'), HEARTBEAT_MS);
    };
    socket.onmessage = (message) => this.receive(message.data);
    socket.onclose = (event) => {
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      // 4001: the server wants a fresh ticket (expiry or revocation); reconnect promptly once.
      if (event.code === 4001) this.attempt = Math.min(this.attempt, 1);
      this.scheduleReconnect();
    };
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    let message: { type?: string; channel?: string; seq?: number };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === "event" && typeof message.channel === "string" && typeof message.seq === "number") {
      const verdict = this.tracker.accept(message.channel, message.seq);
      if (verdict === "duplicate") return;
      if (verdict === "gap") this.handlers.onResync(message.channel);
      this.handlers.onEvent(message as RealtimeEventMessage);
    } else if (message.type === "resync" && typeof message.channel === "string") {
      if (typeof message.seq === "number") this.tracker.reset(message.channel, message.seq);
      this.handlers.onResync(message.channel);
    } else if (message.type === "subscribed" && typeof message.channel === "string" && typeof message.seq === "number") {
      if (this.tracker.last(message.channel) === undefined) this.tracker.reset(message.channel, message.seq);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.handlers.onStatus?.("reconnecting");
    const delay = nextBackoffMs(this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}

/** Subscribes a component to live events; the handlers may change between renders. */
export function useRealtime(channels: string[], handlers: RealtimeHandlers, enabled = true): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const key = channels.join(",");
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return undefined;
    const client = new RealtimeClient(key.split(",").filter(Boolean), {
      onEvent: (event) => latest.current.onEvent(event),
      onResync: (channel) => latest.current.onResync(channel),
      onStatus: (status) => latest.current.onStatus?.(status),
    });
    client.start();
    return () => client.stop();
  }, [key, enabled]);
}
