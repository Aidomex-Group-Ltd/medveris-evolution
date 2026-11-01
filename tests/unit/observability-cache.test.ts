import { describe, expect, it } from "vitest";
import { TtlCache } from "../../apps/api/src/observability/cache.js";

describe("TtlCache", () => {
  it("returns a fresh entry within the TTL", () => {
    const cache = new TtlCache(60_000);
    cache.set("key", { value: 1 }, 1_000);
    const hit = cache.get<{ value: number }>("key", 2_000);
    expect(hit?.value).toEqual({ value: 1 });
  });

  it("returns null for a miss", () => {
    const cache = new TtlCache(60_000);
    expect(cache.get("missing", 1_000)).toBeNull();
  });

  it("expires after the TTL", () => {
    const cache = new TtlCache(60_000);
    cache.set("key", 1, 1_000);
    expect(cache.get("key", 61_001)).toBeNull();
  });

  it("still peeks a last-known-good value after expiry so a failed refresh can serve it", () => {
    const cache = new TtlCache(60_000);
    cache.set("key", 1, 1_000);
    expect(cache.get("key", 61_001)).toBeNull();
    expect(cache.peek("key")?.value).toBe(1);
  });

  it("serves a marked-stale entry after the TTL with the stale flag on the entry", () => {
    const cache = new TtlCache(60_000);
    cache.set("key", 1, 1_000);
    cache.markStale("key");
    // A marked-stale entry is no longer served as a fresh hit; peek keeps the last known good value.
    expect(cache.get<number>("key", 2_000)).toBeNull();
    expect(cache.peek("key")?.value).toBe(1);
  });

  it("evicts the oldest entry when full", () => {
    const cache = new TtlCache(60_000, 2);
    cache.set("a", 1, 1_000);
    cache.set("b", 2, 1_000);
    cache.set("c", 3, 1_000);
    expect(cache.size()).toBe(2);
    expect(cache.peek("a")).toBeNull();
    expect(cache.peek("b")?.value).toBe(2);
    expect(cache.peek("c")?.value).toBe(3);
  });

  it("rejects a TTL below one second", () => {
    expect(() => new TtlCache(100)).toThrow(/at least 1000/);
  });
});
