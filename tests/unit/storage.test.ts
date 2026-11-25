import { beforeEach, describe, expect, it } from "vitest";
import { resetBreakers } from "@medveris/platform";
import { DependencyError } from "../../apps/api/src/lib/errors.js";
import { R2Storage, UnconfiguredStorage } from "../../apps/api/src/lib/storage.js";

interface FakeR2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

class FakeR2 {
  objects = new Map<string, Uint8Array>();
  putCalls: Array<{ key: string; value: Uint8Array }> = [];

  async put(key: string, value: Uint8Array): Promise<void> {
    this.putCalls.push({ key, value });
    this.objects.set(key, value);
  }

  async get(key: string): Promise<FakeR2Object | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    const copy = new ArrayBuffer(value.byteLength);
    new Uint8Array(copy).set(value);
    return { arrayBuffer: async (): Promise<ArrayBuffer> => copy };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe("object storage adapter", () => {
  beforeEach(() => {
    resetBreakers();
  });

  it("stores and reads back objects within the reviewed size limit", async () => {
    const bucket = new FakeR2();
    const storage = new R2Storage(bucket, 1024);
    await storage.put("clinical/scan-1", new Uint8Array([1, 2, 3]));
    const stored = await storage.get("clinical/scan-1");
    expect(stored).toBeDefined();
    expect(Array.from(stored!)).toEqual([1, 2, 3]);
    await storage.delete("clinical/scan-1");
    await expect(storage.get("clinical/scan-1")).rejects.toBeInstanceOf(DependencyError);
  });

  it("rejects uploads that exceed the reviewed maximum object size", async () => {
    const bucket = new FakeR2();
    const storage = new R2Storage(bucket, 10);
    await expect(storage.put("clinical/scan-2", new Uint8Array(11))).rejects.toBeInstanceOf(DependencyError);
    expect(bucket.putCalls).toHaveLength(0);
  });

  it("rejects writes and reads when no storage backend is configured", async () => {
    const storage = new UnconfiguredStorage();
    await expect(storage.put("clinical/scan-3", new Uint8Array([1]))).rejects.toBeInstanceOf(DependencyError);
    await expect(storage.get("clinical/scan-3")).rejects.toBeInstanceOf(DependencyError);
  });
});
