/**
 * Tenant-aware shard routing. The input is always a tenant UUID taken from the server-validated
 * session (never a request field); the output is the shard that owns that tenant's data and
 * whether writes are currently allowed. Shard selection is not authorization: RLS and the
 * application policy checks still apply on whichever shard serves the request.
 *
 * Only single-shard topologies are served today. A directory topology with several shards is
 * validated and routed in tests, but `assertServableTopology` refuses to start a Worker with
 * one until the data-access layer, backups and tenant-move tooling exist for it.
 */

export type ShardState = "active" | "frozen" | "migrating";

export interface ShardAssignment {
  tenantId: string;
  shardId: string;
  state: ShardState;
  routingVersion: number;
}

export interface ShardDefinition {
  /** Worker binding (Hyperdrive) that reaches this shard's primary. */
  binding: string;
}

export interface ShardTopology {
  version: number;
  mode: "single" | "directory";
  defaultShard: string;
  shards: Record<string, ShardDefinition>;
}

export interface ShardDecision {
  shardId: string;
  binding: string;
  writable: boolean;
  routingVersion: number;
  reason: "default-shard" | "assigned" | "tenant-frozen" | "tenant-migrating";
}

export class ShardRoutingError extends Error {
  override readonly name = "ShardRoutingError";
  constructor(readonly reason: "unknown-tenant" | "unknown-shard" | "invalid-tenant-id" | "stale-routing-version", message: string) {
    super(message);
  }
}

export const SINGLE_SHARD_TOPOLOGY: ShardTopology = Object.freeze({
  version: 1,
  mode: "single",
  defaultShard: "primary",
  shards: Object.freeze({ primary: Object.freeze({ binding: "HYPERDRIVE" }) }),
}) as ShardTopology;

const SHARD_ID = /^[a-z][a-z0-9-]{0,30}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,62}$/;
const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses SHARD_TOPOLOGY; absent means the single-shard default. Every problem is reported. */
export function parseShardTopology(raw: string | undefined | null): ShardTopology {
  if (!raw || !raw.trim()) return SINGLE_SHARD_TOPOLOGY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SHARD_TOPOLOGY must be valid JSON");
  }
  const problems = topologyProblems(parsed);
  if (problems.length) throw new Error(`SHARD_TOPOLOGY is invalid: ${problems.join("; ")}`);
  return parsed as ShardTopology;
}

export function topologyProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object") return ["topology must be an object"];
  const topology = value as Partial<ShardTopology>;
  if (!Number.isInteger(topology.version) || (topology.version ?? 0) < 1) problems.push("version must be a positive integer");
  if (topology.mode !== "single" && topology.mode !== "directory") problems.push("mode must be single or directory");
  const shards = topology.shards && typeof topology.shards === "object" ? topology.shards : null;
  if (!shards || !Object.keys(shards).length) problems.push("at least one shard is required");
  const bindings = new Set<string>();
  for (const [id, shard] of Object.entries(shards ?? {})) {
    if (!SHARD_ID.test(id)) problems.push(`shard id ${JSON.stringify(id)} is invalid`);
    const binding = (shard as Partial<ShardDefinition> | null)?.binding;
    if (!binding || !BINDING.test(binding)) problems.push(`shard ${id} needs a binding name`);
    else if (bindings.has(binding)) problems.push(`binding ${binding} is used by more than one shard`);
    else bindings.add(binding);
  }
  if (!topology.defaultShard || !shards || !(topology.defaultShard in shards)) problems.push("defaultShard must name a declared shard");
  if (topology.mode === "single" && shards && Object.keys(shards).length !== 1) problems.push("single mode declares exactly one shard");
  return problems;
}

/** The Worker serves single-shard topologies only; anything else would silently mis-route tenant data. */
export function assertServableTopology(topology: ShardTopology, availableBindings: ReadonlySet<string>): void {
  if (topology.mode !== "single" || Object.keys(topology.shards).length !== 1) {
    throw new Error("Multi-shard topologies are not servable yet: tenant data access is single-database");
  }
  for (const [id, shard] of Object.entries(topology.shards)) {
    if (!availableBindings.has(shard.binding)) throw new Error(`Shard ${id} binding ${shard.binding} is not configured`);
  }
}

export class ShardRouter {
  constructor(readonly topology: ShardTopology) {}

  /**
   * `assignment` comes from tenant_shard_assignments on the directory database. In single mode a
   * tenant without a row (for example one created before the directory existed) uses the only
   * shard; in directory mode it is refused, because guessing a shard could write a tenant's data
   * to the wrong database.
   */
  resolve(tenantId: string, assignment: ShardAssignment | null): ShardDecision {
    if (!TENANT_UUID.test(tenantId)) throw new ShardRoutingError("invalid-tenant-id", "Tenant identifier is not a UUID");
    if (assignment && assignment.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
      throw new ShardRoutingError("unknown-tenant", "Shard assignment belongs to a different tenant");
    }
    if (!assignment) {
      if (this.topology.mode !== "single") throw new ShardRoutingError("unknown-tenant", "Tenant has no shard assignment");
      const shard = this.topology.shards[this.topology.defaultShard]!;
      return { shardId: this.topology.defaultShard, binding: shard.binding, writable: true, routingVersion: 0, reason: "default-shard" };
    }
    const shard = this.topology.shards[assignment.shardId];
    if (!shard) throw new ShardRoutingError("unknown-shard", "Tenant is assigned to a shard this deployment does not know");
    if (assignment.state === "frozen") return { shardId: assignment.shardId, binding: shard.binding, writable: false, routingVersion: assignment.routingVersion, reason: "tenant-frozen" };
    if (assignment.state === "migrating") return { shardId: assignment.shardId, binding: shard.binding, writable: false, routingVersion: assignment.routingVersion, reason: "tenant-migrating" };
    return { shardId: assignment.shardId, binding: shard.binding, writable: true, routingVersion: assignment.routingVersion, reason: "assigned" };
  }
}

/**
 * Tenant move between shards, as an explicit, resumable state machine. Each step is idempotent:
 * re-running a completed step is a no-op, and writes stay refused from `frozen` until either
 * `cutover` (new shard) or `rollback` (old shard) makes the tenant active again.
 */
export type MoveStep = "planned" | "frozen" | "copied" | "verified" | "cut-over" | "completed" | "rolled-back";

export interface TenantMove {
  tenantId: string;
  fromShard: string;
  toShard: string;
  step: MoveStep;
  sourceFingerprint: string | null;
  targetFingerprint: string | null;
}

const NEXT: Record<MoveStep, readonly MoveStep[]> = {
  planned: ["frozen", "rolled-back"],
  frozen: ["copied", "rolled-back"],
  copied: ["verified", "rolled-back"],
  verified: ["cut-over", "rolled-back"],
  "cut-over": ["completed"],
  completed: [],
  "rolled-back": [],
};

export function advanceMove(move: TenantMove, to: MoveStep, evidence: { sourceFingerprint?: string; targetFingerprint?: string } = {}): TenantMove {
  if (move.step === to) return move;
  if (!NEXT[move.step].includes(to)) throw new Error(`Tenant move cannot go from ${move.step} to ${to}`);
  if (move.fromShard === move.toShard) throw new Error("A tenant move needs different source and target shards");
  const next: TenantMove = { ...move, step: to };
  if (to === "verified") {
    const source = evidence.sourceFingerprint ?? move.sourceFingerprint;
    const target = evidence.targetFingerprint ?? move.targetFingerprint;
    if (!source || !target) throw new Error("Verification needs source and target fingerprints");
    if (source !== target) throw new Error("Source and target data differ; the move cannot be verified");
    next.sourceFingerprint = source;
    next.targetFingerprint = target;
  }
  return next;
}

/** Shard state the directory must hold during each step; writes are refused unless active. */
export function directoryStateFor(move: TenantMove): { shardId: string; state: ShardState } {
  switch (move.step) {
    case "planned":
    case "rolled-back":
      return { shardId: move.fromShard, state: "active" };
    case "frozen":
    case "copied":
    case "verified":
      return { shardId: move.fromShard, state: "frozen" };
    case "cut-over":
      return { shardId: move.toShard, state: "migrating" };
    case "completed":
      return { shardId: move.toShard, state: "active" };
  }
}
