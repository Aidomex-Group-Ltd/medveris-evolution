import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StorageAdapter } from "./storage.js";

export class LocalStorage implements StorageAdapter {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    if (key.includes("..") || key.startsWith("/")) throw new Error("invalid object key");
    return join(resolve(process.cwd(), this.directory), key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch {
      /* idempotent delete */
    }
  }
}
