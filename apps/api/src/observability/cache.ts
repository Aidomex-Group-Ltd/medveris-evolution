/**
 * In-memory TTL cache for Cloudflare observability responses. One isolate serves one Worker
 * instance, so this is a per-instance cache; a deploy or isolate recycle clears it. An expired
 * entry is no longer a fresh hit, but it is kept for `peek` so a failed refresh can serve the
 * last known good snapshot with `stale: true`.
 */
export interface Cached<T> {
  value: T;
  fetchedAt: number;
}

export interface CacheEntry<T> extends Cached<T> {
  /** True when a refresh failed and this is the last successful response. */
  stale: boolean;
}

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly ttlMs: number = 60_000, private readonly maxEntries: number = 64) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new Error("ttlMs must be at least 1000");
  }

  /** Fresh hit only: within the TTL and not marked stale. Expired entries stay for `peek`. */
  get<T>(key: string, now = Date.now()): Cached<T> | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.fetchedAt > this.ttlMs || entry.stale) return null;
    return { value: entry.value as T, fetchedAt: entry.fetchedAt };
  }

  /** Last known good value regardless of age, or null. */
  peek<T>(key: string): Cached<T> | null {
    const entry = this.entries.get(key);
    return entry ? { value: entry.value as T, fetchedAt: entry.fetchedAt } : null;
  }

  set<T>(key: string, value: T, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, fetchedAt: now, stale: false });
  }

  /** Mark the current entry so `get` stops serving it while `peek` still can. */
  markStale(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.stale = true;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
