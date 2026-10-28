import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkScalingConfig, parseWranglerConfig, pendingMigrationTag, requiredQueues } from "../../scripts/staging-gate.mjs";
import { checkProductionConfig } from "../../scripts/production-gate.mjs";

const config = parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));

describe("scaling bindings in wrangler.jsonc", () => {
  it("declares Durable Objects, SQLite migrations and environment-scoped queues for staging and production", () => {
    expect(checkScalingConfig(config.env.staging, "medveris-staging")).toEqual([]);
    expect(checkScalingConfig(config.env.production, "medveris-production")).toEqual([]);
    expect(requiredQueues(config.env.staging)).toEqual(["medveris-staging-jobs", "medveris-staging-jobs-dlq"]);
  });

  it("rejects a staging config that consumes production jobs, lacks a dead-letter queue or uses unbounded consumers", () => {
    const staging = structuredClone(config.env.staging);
    staging.queues.consumers[0].queue = "medveris-production-jobs";
    delete staging.queues.consumers[0].dead_letter_queue;
    delete staging.queues.consumers[0].max_concurrency;
    const problems = checkScalingConfig(staging, "medveris-staging");
    expect(problems).toEqual(expect.arrayContaining([
      "this Worker must consume medveris-staging-jobs",
      "queue medveris-production-jobs must belong to medveris-staging",
    ]));
  });

  it("rejects missing or non-SQLite Durable Object classes", () => {
    const staging = structuredClone(config.env.staging);
    staging.durable_objects.bindings = staging.durable_objects.bindings.filter((binding: { name: string }) => binding.name !== "REALTIME");
    staging.migrations = [{ tag: "v1", new_classes: ["RateLimiterObject"] }];
    expect(checkScalingConfig(staging, "medveris-staging")).toEqual(expect.arrayContaining([
      "durable_objects must bind REALTIME to RealtimeHub",
      "migrations must create RealtimeHub",
      "Durable Object classes must be SQLite-backed (new_sqlite_classes), which the Free plan supports",
    ]));
  });

  it("detects a Durable Object migration that a gradual release cannot apply", () => {
    expect(pendingMigrationTag(config.env.staging, null)).toBe("v1-scaling");
    expect(pendingMigrationTag(config.env.staging, "v1-scaling")).toBeNull();
    expect(pendingMigrationTag({}, null)).toBeNull();
  });

  it("keeps live updates and replica reads off in production until verified", () => {
    const enabled = structuredClone(config);
    enabled.env.production.vars.REALTIME_ENABLED = "true";
    enabled.env.production.vars.DB_REPLICA_ENABLED = "true";
    expect(checkProductionConfig(enabled)).toEqual(expect.arrayContaining([
      expect.stringContaining("REALTIME_ENABLED must stay false"),
      expect.stringContaining("DB_REPLICA_ENABLED must stay false"),
    ]));
  });
});
