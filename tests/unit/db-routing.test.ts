import { describe, expect, it } from "vitest";
import {
  advanceMove,
  assertServableTopology,
  classifyProbe,
  DatabaseRouter,
  directoryStateFor,
  parseShardTopology,
  ReplicaHealthMonitor,
  ShardRouter,
  ShardRoutingError,
  SINGLE_SHARD_TOPOLOGY,
  topologyProblems,
  type ReplicaProbe,
  type Sql,
  type TenantMove,
} from "@medveris/db";

const primary = { name: "primary" } as unknown as Sql;
const replica = { name: "replica" } as unknown as Sql;
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function router(probe: () => Promise<ReplicaProbe>, overrides: { maxLagMs?: number; now?: () => number; ttl?: number } = {}) {
  const options = { maxLagMs: overrides.maxLagMs ?? 5000, healthTtlMs: overrides.ttl ?? 5000, healthTimeoutMs: 50, now: overrides.now };
  let probes = 0;
  const monitor = new ReplicaHealthMonitor(options, async () => {
    probes += 1;
    return probe();
  });
  return { router: new DatabaseRouter(primary, replica, monitor, options), probes: () => probes };
}

describe("replica health classification", () => {
  it("never treats a server that is not in recovery as a replica", () => {
    expect(classifyProbe({ inRecovery: false, lagMs: 0 }, 5000, 0).state).toBe("unhealthy");
  });
  it("treats unmeasurable lag as unknown and excess lag as lagging", () => {
    expect(classifyProbe({ inRecovery: true, lagMs: null }, 5000, 0).state).toBe("unknown");
    expect(classifyProbe({ inRecovery: true, lagMs: 9000 }, 5000, 0).state).toBe("lagging");
    expect(classifyProbe({ inRecovery: true, lagMs: 200 }, 5000, 0).state).toBe("healthy");
  });
});

describe("read routing", () => {
  it("routes every consistency-required read to the primary without probing", async () => {
    const r = router(async () => ({ inRecovery: true, lagMs: 0 }));
    const route = await r.router.forRead({ consistency: "primary" });
    expect(route.target).toBe("primary");
    expect(r.probes()).toBe(0);
  });

  it("uses a healthy replica only for bounded-staleness reads within the caller's bound", async () => {
    const r = router(async () => ({ inRecovery: true, lagMs: 800 }));
    expect((await r.router.forRead({ consistency: "bounded-staleness" })).target).toBe("replica");
    expect((await r.router.forRead({ consistency: "bounded-staleness", maxStalenessMs: 500 })).target).toBe("primary");
  });

  it("falls back to the primary when the replica lags, is unknown, times out, fails or was promoted", async () => {
    const cases: Array<[string, () => Promise<ReplicaProbe>]> = [
      ["replica-lagging", async () => ({ inRecovery: true, lagMs: 60_000 })],
      ["replica-unknown", async () => ({ inRecovery: true, lagMs: null })],
      ["replica-unknown", () => new Promise<ReplicaProbe>((resolve) => setTimeout(() => resolve({ inRecovery: true, lagMs: 0 }), 500))],
      ["replica-unhealthy", async () => { throw new Error("connection refused"); }],
      ["replica-unhealthy", async () => ({ inRecovery: false, lagMs: 0 })],
    ];
    for (const [reason, probe] of cases) {
      const route = await router(probe).router.forRead({ consistency: "bounded-staleness" });
      expect(route.target, reason).toBe("primary");
      expect(route.reason).toBe(reason);
    }
  });

  it("keeps a session on the primary during its read-your-writes window", async () => {
    let now = 1_000;
    const r = router(async () => ({ inRecovery: true, lagMs: 0 }), { now: () => now });
    expect((await r.router.forRead({ consistency: "bounded-staleness", readYourWritesUntil: 5_000 })).reason).toBe("read-your-writes");
    now = 6_000;
    expect((await r.router.forRead({ consistency: "bounded-staleness", readYourWritesUntil: 5_000 })).target).toBe("replica");
  });

  it("probes at most once per TTL and stops using a replica marked failed", async () => {
    const r = router(async () => ({ inRecovery: true, lagMs: 0 }));
    await Promise.all(Array.from({ length: 10 }, () => r.router.forRead({ consistency: "bounded-staleness" })));
    expect(r.probes()).toBe(1);
    r.router.markReplicaFailed("query-failed");
    expect((await r.router.forRead({ consistency: "bounded-staleness" })).target).toBe("primary");
  });

  it("works unchanged with no replica", async () => {
    const only = DatabaseRouter.primaryOnly(primary);
    expect((await only.forRead({ consistency: "bounded-staleness" })).reason).toBe("no-replica");
    expect(only.replicaStatus().state).toBe("absent");
  });
});

describe("shard routing", () => {
  it("defaults to one shard and routes every tenant there, even without a directory row", () => {
    const shards = new ShardRouter(parseShardTopology(undefined));
    expect(shards.resolve(TENANT, null)).toMatchObject({ shardId: "primary", binding: "HYPERDRIVE", writable: true, reason: "default-shard" });
    expect(shards.resolve(TENANT, { tenantId: TENANT, shardId: "primary", state: "active", routingVersion: 3 })).toMatchObject({ writable: true, routingVersion: 3 });
  });

  it("is deterministic for the same tenant and directory entry", () => {
    const shards = new ShardRouter(SINGLE_SHARD_TOPOLOGY);
    const assignment = { tenantId: TENANT, shardId: "primary", state: "active" as const, routingVersion: 1 };
    expect(shards.resolve(TENANT, assignment)).toEqual(shards.resolve(TENANT, assignment));
  });

  it("refuses unknown tenants and shards in directory mode instead of guessing", () => {
    const topology = parseShardTopology(JSON.stringify({ version: 2, mode: "directory", defaultShard: "east", shards: { east: { binding: "HYPERDRIVE" }, west: { binding: "HYPERDRIVE_WEST" } } }));
    const shards = new ShardRouter(topology);
    expect(() => shards.resolve(TENANT, null)).toThrow(ShardRoutingError);
    expect(() => shards.resolve(TENANT, { tenantId: TENANT, shardId: "north", state: "active", routingVersion: 1 })).toThrow(ShardRoutingError);
    expect(shards.resolve(TENANT, { tenantId: TENANT, shardId: "west", state: "active", routingVersion: 4 })).toMatchObject({ binding: "HYPERDRIVE_WEST" });
  });

  it("refuses an assignment for another tenant and malformed tenant identifiers", () => {
    const shards = new ShardRouter(SINGLE_SHARD_TOPOLOGY);
    expect(() => shards.resolve(TENANT, { tenantId: OTHER, shardId: "primary", state: "active", routingVersion: 1 })).toThrow(ShardRoutingError);
    expect(() => shards.resolve("../../etc", null)).toThrow(ShardRoutingError);
  });

  it("makes frozen and migrating tenants read-only", () => {
    const shards = new ShardRouter(SINGLE_SHARD_TOPOLOGY);
    expect(shards.resolve(TENANT, { tenantId: TENANT, shardId: "primary", state: "frozen", routingVersion: 2 }).writable).toBe(false);
    expect(shards.resolve(TENANT, { tenantId: TENANT, shardId: "primary", state: "migrating", routingVersion: 2 }).writable).toBe(false);
  });

  it("validates topology configuration and refuses to serve multi-shard topologies yet", () => {
    expect(topologyProblems({ version: 1, mode: "single", defaultShard: "a", shards: { a: { binding: "HYPERDRIVE" }, b: { binding: "HYPERDRIVE" } } }))
      .toEqual(expect.arrayContaining(["binding HYPERDRIVE is used by more than one shard", "single mode declares exactly one shard"]));
    expect(() => parseShardTopology("{not json")).toThrow("valid JSON");
    expect(() => parseShardTopology(JSON.stringify({ version: 1, mode: "single", defaultShard: "x", shards: { primary: { binding: "HYPERDRIVE" } } }))).toThrow("defaultShard");
    expect(() => assertServableTopology(SINGLE_SHARD_TOPOLOGY, new Set(["HYPERDRIVE"]))).not.toThrow();
    expect(() => assertServableTopology(SINGLE_SHARD_TOPOLOGY, new Set())).toThrow("not configured");
    const multi = parseShardTopology(JSON.stringify({ version: 2, mode: "directory", defaultShard: "east", shards: { east: { binding: "HYPERDRIVE" }, west: { binding: "HYPERDRIVE_WEST" } } }));
    expect(() => assertServableTopology(multi, new Set(["HYPERDRIVE", "HYPERDRIVE_WEST"]))).toThrow("not servable");
  });
});

describe("tenant move state machine", () => {
  const move: TenantMove = { tenantId: TENANT, fromShard: "east", toShard: "west", step: "planned", sourceFingerprint: null, targetFingerprint: null };

  it("walks plan, freeze, copy, verify, cut-over and completion with matching fingerprints", () => {
    let current = advanceMove(move, "frozen");
    expect(directoryStateFor(current)).toEqual({ shardId: "east", state: "frozen" });
    current = advanceMove(current, "copied");
    current = advanceMove(current, "verified", { sourceFingerprint: "abc", targetFingerprint: "abc" });
    current = advanceMove(current, "cut-over");
    expect(directoryStateFor(current)).toEqual({ shardId: "west", state: "migrating" });
    current = advanceMove(current, "completed");
    expect(directoryStateFor(current)).toEqual({ shardId: "west", state: "active" });
  });

  it("is idempotent per step and refuses skipped steps, mismatched data and moves to the same shard", () => {
    const frozen = advanceMove(move, "frozen");
    expect(advanceMove(frozen, "frozen")).toBe(frozen);
    expect(() => advanceMove(move, "cut-over")).toThrow("cannot go from planned to cut-over");
    const copied = advanceMove(frozen, "copied");
    expect(() => advanceMove(copied, "verified", { sourceFingerprint: "abc", targetFingerprint: "abd" })).toThrow("differ");
    expect(() => advanceMove(copied, "verified")).toThrow("fingerprints");
    expect(() => advanceMove({ ...move, toShard: "east" }, "frozen")).toThrow("different source and target");
  });

  it("can roll back before cut-over and leaves the tenant active on its original shard", () => {
    const rolledBack = advanceMove(advanceMove(advanceMove(move, "frozen"), "copied"), "rolled-back");
    expect(directoryStateFor(rolledBack)).toEqual({ shardId: "east", state: "active" });
    expect(() => advanceMove(advanceMove(advanceMove(advanceMove(advanceMove(move, "frozen"), "copied"), "verified", { sourceFingerprint: "a", targetFingerprint: "a" }), "cut-over"), "rolled-back")).toThrow();
  });
});
