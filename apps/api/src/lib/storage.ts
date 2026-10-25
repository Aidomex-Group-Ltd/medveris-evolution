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

export class R2Storage implements StorageAdapter {
  constructor(private readonly bucket: R2Like | undefined) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!this.bucket) throw new DependencyError("Private object storage is not configured");
    await this.bucket.put(key, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    if (!this.bucket) throw new DependencyError("Private object storage is not configured");
    const object = await this.bucket.get(key);
    if (!object) throw new DependencyError("Protected object is unavailable");
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    if (this.bucket) await this.bucket.delete(key);
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
