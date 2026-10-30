import type { Sql } from "@medveris/db";
import { errorFields, logEvent, metric } from "@medveris/platform";
import { claimOutboxEvent, failOutboxEvent, outboxMetrics, reclaimStaleOutbox, type OutboxMetrics, type ReclaimResult } from "./outbox.js";
import { checkpointAllTenants, type CheckpointResult } from "./integrity.js";
import { handleEvent, relayOutbox, type QueueProducer, type RealtimeSink, type RelayResult } from "./queue.js";
import { runBillingCycle, type BillingCycleResult } from "./billing.js";

export interface JobsCycleResult {
  processed: number;
  relay: RelayResult | null;
  reclaimed: ReclaimResult;
  backlog: OutboxMetrics[];
  checkpoints: CheckpointResult[];
  checkpointError: string | null;
  billing: BillingCycleResult | null;
  billingError: string | null;
  notifications: number | null;
  notificationsError: string | null;
}

/** Subscription lifecycle work is daily or hourly in nature; running it every few minutes is enough. */
const BILLING_INTERVAL_MS = 10 * 60_000;
let lastBillingRun = 0;

/** Inventory thresholds change slowly; a scan every few minutes is plenty. */
const NOTIFICATION_INTERVAL_MS = 5 * 60_000;
let lastNotificationScan = 0;

async function maybeRunBilling(sql: Sql): Promise<{ billing: BillingCycleResult | null; billingError: string | null }> {
  if (Date.now() - lastBillingRun < BILLING_INTERVAL_MS) return { billing: null, billingError: null };
  lastBillingRun = Date.now();
  try {
    const billing = await runBillingCycle(sql);
    metric("jobs.billing_cycle", 1, billing as unknown as Record<string, unknown>);
    return { billing, billingError: null };
  } catch (error) {
    logEvent("error", "billing_cycle_failed", errorFields(error, false));
    return { billing: null, billingError: (error as Error).message };
  }
}

async function maybeScanNotifications(sql: Sql): Promise<{ notifications: number | null; notificationsError: string | null }> {
  if (Date.now() - lastNotificationScan < NOTIFICATION_INTERVAL_MS) return { notifications: null, notificationsError: null };
  lastNotificationScan = Date.now();
  try {
    const rows = await sql`select app.enqueue_inventory_notifications() as inserted`;
    const notifications = Number(rows[0]?.inserted ?? 0);
    if (notifications > 0) metric("jobs.notifications_enqueued", notifications, {});
    return { notifications, notificationsError: null };
  } catch (error) {
    logEvent("error", "notification_scan_failed", errorFields(error, false));
    return { notifications: null, notificationsError: (error as Error).message };
  }
}

export interface JobsCycleOptions {
  maxEvents?: number;
  /** With a queue, events are relayed to it; without one they are handled in-process. */
  producer?: QueueProducer | null;
  realtime?: RealtimeSink | null;
  realtimeEventTypes?: readonly string[];
  relayBatchSize?: number;
  perTenantBatchLimit?: number;
}

export async function drainOutbox(sql: Sql, maxEvents = Number.POSITIVE_INFINITY, options: Pick<JobsCycleOptions, "realtime" | "realtimeEventTypes"> = {}): Promise<number> {
  let processed = 0;
  const deps = { sql, dlq: null, realtime: options.realtime ?? null, realtimeEventTypes: options.realtimeEventTypes ?? [] };
  for (let claimed = 0; claimed < maxEvents; claimed += 1) {
    const event = await claimOutboxEvent(sql);
    if (!event) break;
    try {
      await handleEvent(deps, event);
      processed += 1;
    } catch (error) {
      await failOutboxEvent(sql, event, (error as Error).message);
    }
  }
  return processed;
}

const PROCESSING_LEASE_SECONDS = 600;
const QUEUED_REDELIVER_SECONDS = 1800;

export async function runJobsCycle(
  sql: Sql,
  signingKey: string,
  keyId: string,
  options: JobsCycleOptions = {},
): Promise<JobsCycleResult> {
  const reclaimed = await reclaimStaleOutbox(sql, { processingLeaseSeconds: PROCESSING_LEASE_SECONDS, queuedRedeliverSeconds: QUEUED_REDELIVER_SECONDS });
  if (reclaimed.processing || reclaimed.queued) metric("jobs.reclaimed", reclaimed.processing + reclaimed.queued, reclaimed as unknown as Record<string, unknown>);
  let processed = 0;
  let relay: RelayResult | null = null;
  if (options.producer) {
    relay = await relayOutbox(sql, options.producer, {
      batchSize: options.relayBatchSize ?? 100,
      perTenant: options.perTenantBatchLimit ?? 25,
      maxBatches: Math.max(1, Math.ceil((options.maxEvents ?? 500) / (options.relayBatchSize ?? 100))),
    });
  } else {
    processed = await drainOutbox(sql, options.maxEvents, options);
  }
  const backlog = await outboxMetrics(sql).catch((error: unknown) => {
    logEvent("warn", "outbox_metrics_failed", errorFields(error, false));
    return [] as OutboxMetrics[];
  });
  for (const row of backlog) {
    metric("jobs.backlog", row.events, { status: row.status, oldestSeconds: Math.round(row.oldestSeconds), maxAttempts: row.maxAttempts });
  }
  const billing = await maybeRunBilling(sql);
  const notifications = await maybeScanNotifications(sql);
  try {
    const checkpoints = await checkpointAllTenants(sql, signingKey, keyId);
    return { processed, relay, reclaimed, backlog, checkpoints, checkpointError: null, ...billing, ...notifications };
  } catch (error) {
    return { processed, relay, reclaimed, backlog, checkpoints: [], checkpointError: (error as Error).message, ...billing, ...notifications };
  }
}
