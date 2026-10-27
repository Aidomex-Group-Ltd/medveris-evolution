import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PBKDF2_ITERATIONS, hashPassword, verifyPassword } from "@medveris/auth";

const WORKERS_PBKDF2_MAX_ITERATIONS = 100_000;

describe("password hashing on Cloudflare Workers", () => {
  it("never requests more PBKDF2 iterations than Workers allows", async () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(WORKERS_PBKDF2_MAX_ITERATIONS);
    const stored = await hashPassword("Synthetic-Password-1");
    expect(Number(stored.split("$")[2])).toBeLessThanOrEqual(WORKERS_PBKDF2_MAX_ITERATIONS);
    expect(await verifyPassword("Synthetic-Password-1", stored)).toBe(true);
    expect(await verifyPassword("Synthetic-Password-2", stored)).toBe(false);
  });

  it("still verifies existing hashes that recorded a higher iteration count", async () => {
    const salt = new Uint8Array(16).fill(7);
    const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode("legacy"), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 210_000 }, key, 256));
    const legacy = `pbkdf2$sha256$210000$${Buffer.from(salt).toString("base64")}$${Buffer.from(bits).toString("base64url")}`;
    expect(await verifyPassword("legacy", legacy)).toBe(true);
  });
});
