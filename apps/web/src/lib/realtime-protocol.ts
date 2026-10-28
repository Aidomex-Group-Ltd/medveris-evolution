/** Reconnect delay with "equal jitter": half fixed, half random, doubling to a 30-second cap. */
export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export type SequenceVerdict = "new" | "duplicate" | "gap";

/**
 * Tracks the last sequence number seen per channel. Sequence 0 marks personal events that the
 * server does not sequence; they are always new. A gap means events were missed and the
 * caller should reload state from the API.
 */
export class SequenceTracker {
  private readonly seen = new Map<string, number>();

  accept(channel: string, seq: number): SequenceVerdict {
    if (seq === 0) return "new";
    const last = this.seen.get(channel);
    if (last !== undefined && seq <= last) return "duplicate";
    this.seen.set(channel, seq);
    return last !== undefined && seq > last + 1 ? "gap" : "new";
  }

  last(channel: string): number | undefined {
    return this.seen.get(channel);
  }

  reset(channel: string, seq: number): void {
    this.seen.set(channel, seq);
  }
}

export interface RealtimeEventMessage {
  type: "event";
  channel: string;
  seq: number;
  event: string;
  ref: string | null;
  at: number;
  replayed?: boolean;
}
