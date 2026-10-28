import type { Sql } from "./index.js";

/**
 * Read/write routing between the primary and an optional read replica.
 *
 * Writes, transactions that write, authentication, authorization, consent and any clinical read
 * that needs read-after-write consistency always use `primary`. Only call sites that explicitly
 * ask for a bounded-staleness read can be sent to the replica, and only while the replica is
 * measured as a healthy standby within the configured lag. Unknown health means primary.
 */

export type ReplicaState = "absent" | "healthy" | "lagging" | "unhealthy" | "unknown";

export interface ReplicaStatus {
  state: ReplicaState;
  lagMs: number | null;
  checkedAt: number;
  reason: string;
}

export interface ReplicaProbe {
  inRecovery: boolean;
  /** Milliseconds since the last replayed transaction, or 0 when everything received is replayed. */
  lagMs: number | null;
}

export interface RoutingOptions {
  maxLagMs: number;
  healthTtlMs: number;
  healthTimeoutMs: number;
  now?: () => number;
}

export type ReadTarget = "primary" | "replica";

export interface ReadRoute {
  sql: Sql;
  target: ReadTarget;
  reason: string;
  /** Upper bound on how stale replica data may be; 0 for primary reads. */
  maxStalenessMs: number;
}

export interface ReadIntent {
  /** Data class the caller is reading; only "bounded-staleness" can use the replica. */
  consistency: "primary" | "bounded-staleness";
  /** Caller's own tolerance; the effective bound is the smaller of this and maxLagMs. */
  maxStalenessMs?: number;
  /** Epoch ms until which this session must read its own writes from the primary. */
  readYourWritesUntil?: number | null;
}

/**
 * Asks the standby itself: a server that is not in recovery is not a replica (it may be a
 * promoted former replica), so it is never used for replica reads. Lag is the age of the last
 * replayed transaction unless every received WAL record has already been replayed.
 */
export async function probeReplica(replica: Sql): Promise<ReplicaProbe> {
  const [row] = await replica<{ inRecovery: boolean; lagMs: string | number | null }[]>`
    select pg_is_in_recovery() as in_recovery,
           case
             when not pg_is_in_recovery() then null
             -- A standby whose WAL receiver is not streaming can look current while falling behind.
             when coalesce((select status from pg_stat_wal_receiver limit 1), '') <> 'streaming' then null
             when pg_last_wal_receive_lsn() is not distinct from pg_last_wal_replay_lsn() then 0
             else extract(epoch from (clock_timestamp() - pg_last_xact_replay_timestamp())) * 1000
           end as lag_ms
  `;
  return { inRecovery: Boolean(row?.inRecovery), lagMs: row?.lagMs == null ? null : Number(row.lagMs) };
}

export function classifyProbe(probe: ReplicaProbe, maxLagMs: number, now: number): ReplicaStatus {
  if (!probe.inRecovery) return { state: "unhealthy", lagMs: null, checkedAt: now, reason: "not-a-standby" };
  if (probe.lagMs == null || !Number.isFinite(probe.lagMs)) return { state: "unknown", lagMs: null, checkedAt: now, reason: "lag-unmeasurable" };
  if (probe.lagMs > maxLagMs) return { state: "lagging", lagMs: probe.lagMs, checkedAt: now, reason: "lag-exceeds-limit" };
  return { state: "healthy", lagMs: probe.lagMs, checkedAt: now, reason: "within-lag-limit" };
}

/** Per-isolate replica health, refreshed at most once per TTL and never waited on for longer than the timeout. */
export class ReplicaHealthMonitor {
  private status: ReplicaStatus | null = null;
  private refreshing: Promise<ReplicaStatus> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly options: RoutingOptions,
    private readonly probe: (replica: Sql) => Promise<ReplicaProbe> = probeReplica,
  ) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): ReplicaStatus | null {
    return this.status;
  }

  /** Marks the replica unusable after a connection or query failure, until the next probe. */
  markFailed(reason: string): void {
    this.status = { state: "unhealthy", lagMs: null, checkedAt: this.now(), reason };
  }

  async current(replica: Sql): Promise<ReplicaStatus> {
    if (this.status && this.now() - this.status.checkedAt < this.options.healthTtlMs) return this.status;
    if (!this.refreshing) {
      this.refreshing = this.measure(replica).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async measure(replica: Sql): Promise<ReplicaStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ReplicaStatus>((resolve) => {
      timer = setTimeout(() => resolve({ state: "unknown", lagMs: null, checkedAt: this.now(), reason: "probe-timeout" }), this.options.healthTimeoutMs);
    });
    try {
      const probed = this.probe(replica).then(
        (probe) => classifyProbe(probe, this.options.maxLagMs, this.now()),
        (): ReplicaStatus => ({ state: "unhealthy", lagMs: null, checkedAt: this.now(), reason: "probe-failed" }),
      );
      this.status = await Promise.race([probed, timeout]);
      return this.status;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class DatabaseRouter {
  private readonly now: () => number;

  constructor(
    readonly primary: Sql,
    private readonly replica: Sql | null,
    private readonly health: ReplicaHealthMonitor | null,
    private readonly options: RoutingOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  static primaryOnly(primary: Sql): DatabaseRouter {
    return new DatabaseRouter(primary, null, null, { maxLagMs: 0, healthTtlMs: 0, healthTimeoutMs: 0 });
  }

  hasReplica(): boolean {
    return this.replica !== null && this.health !== null;
  }

  replicaStatus(): ReplicaStatus {
    if (!this.hasReplica()) return { state: "absent", lagMs: null, checkedAt: this.now(), reason: "no-replica-configured" };
    return this.health!.snapshot() ?? { state: "unknown", lagMs: null, checkedAt: this.now(), reason: "not-yet-probed" };
  }

  async refreshReplicaStatus(): Promise<ReplicaStatus> {
    if (!this.replica || !this.health) return this.replicaStatus();
    return this.health.current(this.replica);
  }

  markReplicaFailed(reason: string): void {
    this.health?.markFailed(reason);
  }

  async forRead(intent: ReadIntent): Promise<ReadRoute> {
    const primary = (reason: string): ReadRoute => ({ sql: this.primary, target: "primary", reason, maxStalenessMs: 0 });
    if (intent.consistency !== "bounded-staleness") return primary("consistency-required");
    if (!this.replica || !this.health) return primary("no-replica");
    if (intent.readYourWritesUntil && intent.readYourWritesUntil > this.now()) return primary("read-your-writes");
    const bound = Math.min(intent.maxStalenessMs ?? this.options.maxLagMs, this.options.maxLagMs);
    const status = await this.health.current(this.replica);
    if (status.state !== "healthy" || status.lagMs == null) return primary(`replica-${status.state}`);
    if (status.lagMs > bound) return primary("replica-exceeds-caller-bound");
    return { sql: this.replica, target: "replica", reason: "replica-healthy", maxStalenessMs: bound };
  }
}

const monitors = new Map<string, ReplicaHealthMonitor>();

/** One monitor per replica binding per isolate, so probes are shared across requests. */
export function replicaMonitor(name: string, options: RoutingOptions): ReplicaHealthMonitor {
  let monitor = monitors.get(name);
  if (!monitor) {
    monitor = new ReplicaHealthMonitor(options);
    monitors.set(name, monitor);
  }
  return monitor;
}
