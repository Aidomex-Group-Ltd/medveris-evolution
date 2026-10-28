import { withTimeout } from "@medveris/platform";
import type { DurableObjectNamespaceLike } from "../lib/rate-limit.js";

export interface RealtimePublisher {
  /** Tenant-wide event for authorised staff of that facility; the event carries a reference, never record content. */
  publish(tenantId: string, event: { type: string; ref: string | null }): Promise<void>;
  /** Closes the user's open connections in the given hubs, e.g. on sign-out. */
  revokeUser(userId: string, tenantIds: string[]): Promise<void>;
}

const PUBLISH_TIMEOUT_MS = 2_000;

export class DurableRealtimePublisher implements RealtimePublisher {
  constructor(private readonly namespace: DurableObjectNamespaceLike) {}

  private async post(hub: string, path: string, body: unknown): Promise<void> {
    const stub = this.namespace.get(this.namespace.idFromName(hub));
    const response = await withTimeout("realtime.publish", PUBLISH_TIMEOUT_MS, (signal) => stub.fetch(`https://realtime.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }));
    if (!response.ok) throw new Error(`realtime hub answered ${response.status}`);
  }

  async publish(tenantId: string, event: { type: string; ref: string | null }): Promise<void> {
    await this.post(`tenant:${tenantId}`, "/publish", { channel: "tenant", type: event.type, ref: event.ref });
  }

  async revokeUser(userId: string, tenantIds: string[]): Promise<void> {
    await Promise.allSettled([`user:${userId}`, ...tenantIds.map((id) => `tenant:${id}`)].map((hub) => this.post(hub, "/revoke", { userId })));
  }
}
