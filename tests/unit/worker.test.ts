import { describe, expect, it, vi } from "vitest";
import worker, { VERSION_HEADER, withVersionHeader } from "../../apps/api/src/worker.js";

const stagingEnv = {
  APP_ENV: "staging",
  APP_ORIGIN: "https://medveris-staging.example.workers.dev",
  EXPECTED_DATABASE_NAME: "medveris_staging",
  AUDIT_SIGNING_KEY_ID: "staging-key-1",
  SESSION_SECRET: "s".repeat(20) + "-staging-session-value",
  AUDIT_SIGNING_KEY: "a".repeat(20) + "-staging-audit-value",
  MFA_ENCRYPTION_KEY: "m".repeat(20) + "-staging-mfa-value",
};

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };

describe("Worker entry point fails closed", () => {
  it("refuses a placeholder signing key in the scheduled jobs cycle before connecting", async () => {
    const env = {
      ...stagingEnv,
      AUDIT_SIGNING_KEY: "replace-with-at-least-32-random-characters",
      HYPERDRIVE_JOBS: { connectionString: "postgres://medveris_jobs:unused@127.0.0.1:1/medveris_staging" },
    };
    await expect(worker.scheduled({}, env, ctx)).rejects.toThrow("AUDIT_SIGNING_KEY is a placeholder");
  });

  it("requires the jobs Hyperdrive binding for scheduled runs", async () => {
    await expect(worker.scheduled({}, { ...stagingEnv }, ctx)).rejects.toThrow("HYPERDRIVE_JOBS binding is required");
  });

  it("returns a generic 503 without configuration details when the runtime binding is missing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(new Request("https://medveris-staging.example.workers.dev/api/v1/health/live"), { ...stagingEnv }, ctx);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("The service is not configured correctly");
      for (const value of Object.values(stagingEnv)) {
        if (value.length > 20) expect(body).not.toContain(value);
      }
    } finally {
      errors.mockRestore();
    }
  });
});

describe("Worker version header", () => {
  it("tags responses with the running version so blue-green probes can tell versions apart", async () => {
    const env = { ...stagingEnv, CF_VERSION_METADATA: { id: "0e3daf50-7a54-4107-9e7b-44794cf475b7" } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(new Request("https://medveris-staging.example.workers.dev/api/v1/health/live"), env, ctx);
      expect(response.headers.get(VERSION_HEADER)).toBe("0e3daf50-7a54-4107-9e7b-44794cf475b7");
    } finally {
      errors.mockRestore();
    }
  });

  it("leaves responses untouched without version metadata", () => {
    const response = withVersionHeader(new Response("ok", { status: 201, headers: { "cache-control": "no-store" } }), { ...stagingEnv });
    expect(response.status).toBe(201);
    expect(response.headers.get(VERSION_HEADER)).toBeNull();
  });
});
