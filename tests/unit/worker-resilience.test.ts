import { describe, expect, it } from "vitest";
import { breakerSnapshots } from "@medveris/platform";
import worker from "../../apps/api/src/worker.js";
import { bindingProblems, type WorkerEnv } from "../../apps/api/src/worker-support.js";
import { loadConfig } from "../../apps/api/src/config.js";

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) };

const stagingVars = {
  APP_ENV: "staging",
  APP_ORIGIN: "https://medveris-staging.example.workers.dev",
  EXPECTED_DATABASE_NAME: "medveris_staging",
  SESSION_SECRET: "s".repeat(20) + "-staging-session-value",
  AUDIT_SIGNING_KEY: "a".repeat(20) + "-staging-audit-value",
  MFA_ENCRYPTION_KEY: "m".repeat(20) + "-staging-mfa-value",
};

function config(env: Record<string, unknown>) {
  return loadConfig(env as Record<string, string | undefined>);
}

describe("Worker binding preflight", () => {
  it("requires the distributed rate limiter outside local development instead of degrading silently", () => {
    const env: WorkerEnv = { ...stagingVars, HYPERDRIVE: { connectionString: "postgres://x" } };
    expect(bindingProblems(env, config(env))).toContain("RATE_LIMITER Durable Object binding is required outside local development");
    expect(bindingProblems({ ...env, RATE_LIMITER: namespace }, config(env))).toEqual([]);
  });

  it("refuses replica reads or live updates without their bindings, and multi-shard topologies", () => {
    const base: WorkerEnv = { ...stagingVars, HYPERDRIVE: { connectionString: "postgres://x" }, RATE_LIMITER: namespace };
    const replica = { ...base, DB_REPLICA_ENABLED: "true" };
    expect(bindingProblems(replica, config(replica))).toContain("DB_REPLICA_ENABLED requires the HYPERDRIVE_REPLICA binding");
    const realtime = { ...base, REALTIME_ENABLED: "true" };
    expect(bindingProblems(realtime, config(realtime))).toContain("REALTIME_ENABLED requires the REALTIME Durable Object binding");
    const sharded = { ...base, HYPERDRIVE_WEST: { connectionString: "postgres://y" }, SHARD_TOPOLOGY: JSON.stringify({ version: 2, mode: "directory", defaultShard: "east", shards: { east: { binding: "HYPERDRIVE" }, west: { binding: "HYPERDRIVE_WEST" } } }) };
    expect(bindingProblems(sharded, config(sharded)).join()).toMatch(/not servable/);
  });
});

describe("Worker database breaker", () => {
  it("answers 503 during an outage and stops opening connections once the breaker is open", async () => {
    const env: WorkerEnv = { APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DATABASE_URL: "postgres://medveris_runtime:unused@127.0.0.1:1/medveris_dev" };
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await worker.fetch(new Request("http://localhost/api/v1/public/facilities"), env, ctx);
      statuses.push(response.status);
      expect(response.headers.get("retry-after")).not.toBeNull();
    }
    expect(statuses.every((status) => status === 503)).toBe(true);
    const breaker = breakerSnapshots().find((snapshot) => snapshot.name === "database.primary")!;
    expect(breaker.state).toBe("open");
    expect(breaker.totalFailures).toBe(5);
    expect(breaker.totalRejected).toBe(3);
    const live = await worker.fetch(new Request("http://localhost/api/v1/health/live"), env, ctx);
    expect(live.status).toBe(200);
  });
});
