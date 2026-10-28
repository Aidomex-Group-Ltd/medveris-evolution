/**
 * The parts of the Durable Object runtime this code uses, declared locally so the classes can
 * be unit-tested in Node with fakes. See the Cloudflare Durable Objects and WebSocket
 * Hibernation API documentation for the full surface.
 */
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface HibernatableSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableStateLike {
  storage: DurableStorageLike;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  acceptWebSocket?(socket: unknown, tags?: string[]): void;
  getWebSockets?(tag?: string): HibernatableSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
  getWebSocketAutoResponseTimestamp?(socket: unknown): Date | null;
}
