import { breakerFor, CircuitOpenError, TimeoutError, withTimeout } from "@medveris/platform";
import { DependencyError } from "./errors.js";

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

interface R2Like {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

const PUT_TIMEOUT_MS = 30_000;
const GET_TIMEOUT_MS = 15_000;

/**
 * R2 calls are not retried here: an upload that timed out may still have been stored, so the
 * caller reports failure and the user retries with a new random key; orphans are harmless.
 */
export class R2Storage implements StorageAdapter {
  constructor(private readonly bucket: R2Like | undefined) {}

  private async guarded<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const breaker = breakerFor("object-storage", { failureThreshold: 5, resetTimeoutMs: 30_000, isFailure: (error) => !(error instanceof DependencyError) });
    try {
      return await breaker.execute(() => withTimeout(label, timeoutMs, fn));
    } catch (error) {
      if (error instanceof DependencyError) throw error;
      if (error instanceof CircuitOpenError || error instanceof TimeoutError) throw new DependencyError("Private object storage is temporarily unavailable");
      throw new DependencyError("Private object storage request failed");
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const bucket = this.bucket;
    if (!bucket) throw new DependencyError("Private object storage is not configured");
    await this.guarded("object-storage.put", PUT_TIMEOUT_MS, async () => {
      await bucket.put(key, bytes);
    });
  }

  async get(key: string): Promise<Uint8Array> {
    const bucket = this.bucket;
    if (!bucket) throw new DependencyError("Private object storage is not configured");
    return this.guarded("object-storage.get", GET_TIMEOUT_MS, async () => {
      const object = await bucket.get(key);
      if (!object) throw new DependencyError("Protected object is unavailable");
      return new Uint8Array(await object.arrayBuffer());
    });
  }

  async delete(key: string): Promise<void> {
    const bucket = this.bucket;
    if (bucket) await this.guarded("object-storage.delete", GET_TIMEOUT_MS, () => bucket.delete(key));
  }
}

export class UnconfiguredStorage implements StorageAdapter {
  async put(): Promise<void> {
    throw new DependencyError("Private object storage is not configured");
  }
  async get(): Promise<Uint8Array> {
    throw new DependencyError("Private object storage is not configured");
  }
  async delete(): Promise<void> {
    /* no-op */
  }
}
