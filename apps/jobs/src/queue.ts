import type { Sql } from "@medveris/db";
import { backoffDelay, errorFields, logEvent, metric } from "@medveris/platform";
import { JOB_SCHEMA_VERSION, kindForEvent, parseJobMessage, type JobMessage } from "./contracts.js";
import {
  claimOutboxBatch,
  completeOutboxEvent,
  deadLetterOutboxEvent,
  dispatchLocalEvent,
  loadOutboxEvent,
  markQueued,
  MAX_ATTEMPTS,
  noteQueuedFailure,
  releaseClaims,
  stableProcessor,
  type DispatchResult,
  type OutboxEvent,
} from "./outbox.js";

/** Cloudflare Queues producer binding surface. */
export interface QueueProducer {
  sendBatch(messages: Iterable<{ body: unknown; contentType?: "json"; delaySeconds?: number }>): Promise<void>;
  send(body: unknown, options?: { contentType?: "json"; delaySeconds?: number }): Promise<void>;
}

/** Cloudflare Queues consumer message surface. */
export interface QueueMessage {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatch {
  queue: string;
  messages: readonly QueueMessage[];
}

/**
 * Best-effort real-time fan-out. Losing a notification is acceptable because clients recover
 * state through the API; a failed publish therefore never fails or retries a job.
 */
export interface RealtimeSink {
  publish(tenantId: string, event: { type: string; ref: string | null }): Promise<void>;
}

export interface ConsumerDeps {
  sql: Sql;
  dlq: QueueProducer | null;
  realtime: RealtimeSink | null;
  realtimeEventTypes: readonly string[];
  maxAttempts?: number;
  /** Handler for an authoritative outbox row; defaults to the local recorder. */
  dispatch?: (event: OutboxEvent) => DispatchResult | Promise<DispatchResult>;
}

const SEND_BATCH_LIMIT = 100;

export function toJobMessage(event: OutboxEvent, correlationId: string | null = null, now = new Date()): JobMessage {
  return {
    v: JOB_SCHEMA_VERSION,
    jobId: event.id,
    kind: kindForEvent(event.eventType),
    eventType: event.eventType,
    tenantId: event.tenantId,
    aggregateId: event.aggregateId,
    claim: Math.max(1, event.attemptCount),
    correlationId,
    enqueuedAt: now.toISOString(),
  };
}

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Transactional-outbox relay. Rows were committed with the business change; this moves them
 * to the queue. A publish that fails leaves the rows due again with backoff, so a database
 * write is never assumed to have produced a message.
 */
export async function relayOutbox(sql: Sql, producer: QueueProducer, options: { batchSize: number; perTenant: number; maxBatches?: number }): Promise<RelayResult> {
  const result: RelayResult = { claimed: 0, published: 0, failed: 0 };
  const maxBatches = options.maxBatches ?? 5;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const events = await claimOutboxBatch(sql, { limit: Math.min(options.batchSize, SEND_BATCH_LIMIT), perTenant: options.perTenant });
    if (!events.length) break;
    result.claimed += events.length;
    try {
      await producer.sendBatch(events.map((event) => ({ body: toJobMessage(event), contentType: "json" as const })));
      await markQueued(sql, events.map((event) => event.id));
      result.published += events.length;
    } catch (error) {
      result.failed += events.length;
      logEvent("error", "outbox_publish_failed", { events: events.length, ...errorFields(error, false) });
      await releaseClaims(sql, events, "queue-publish-failed");
      break;
    }
    if (events.length < options.batchSize) break;
  }
  metric("jobs.relay", result.published, { outcome: "published" });
  if (result.failed) metric("jobs.relay", result.failed, { outcome: "failed" });
  return result;
}

async function fanOut(deps: ConsumerDeps, event: OutboxEvent): Promise<void> {
  if (!deps.realtime || !event.tenantId || !deps.realtimeEventTypes.includes(event.eventType)) return;
  try {
    await deps.realtime.publish(event.tenantId, { type: event.eventType, ref: event.aggregateId });
  } catch (error) {
    metric("realtime.publish_failed", 1, { eventType: event.eventType });
    logEvent("warn", "realtime_publish_failed", { jobId: event.id, ...errorFields(error, false) });
  }
}

/** Runs the handler for one authoritative outbox row; shared by the queue consumer and the local drain. */
export async function handleEvent(deps: ConsumerDeps, event: OutboxEvent): Promise<"processed" | "deduplicated"> {
  const result = await (deps.dispatch ?? dispatchLocalEvent)(event);
  const outcome = await completeOutboxEvent(deps.sql, event, stableProcessor(event), result.detail);
  if (outcome === "processed") await fanOut(deps, event);
  return outcome;
}

async function poison(deps: ConsumerDeps, message: QueueMessage, reason: string, jobId: string | null): Promise<void> {
  metric("jobs.poison", 1, { reason: reason.split(":")[0] ?? "unknown" });
  logEvent("error", "job_poison_message", { messageId: message.id, jobId, reason });
  if (jobId) await deadLetterOutboxEvent(deps.sql, jobId, `poison-message:${reason}`).catch(() => undefined);
  await deps.dlq?.send({ v: JOB_SCHEMA_VERSION, poison: true, jobId, reason }, { contentType: "json" }).catch(() => undefined);
  message.ack();
}

export type MessageOutcome = "processed" | "deduplicated" | "skipped" | "retried" | "dead-lettered" | "poison";

/**
 * At-least-once consumer. Messages in a batch are processed one at a time (bounded concurrency
 * comes from the consumer's max_concurrency). Each message is acknowledged or retried
 * individually, so one failure does not redeliver the rest of the batch.
 */
export async function consumeJobBatch(batch: QueueBatch, deps: ConsumerDeps): Promise<Record<MessageOutcome, number>> {
  const counts: Record<MessageOutcome, number> = { processed: 0, deduplicated: 0, skipped: 0, retried: 0, "dead-lettered": 0, poison: 0 };
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
  for (const message of batch.messages) {
    const parsed = parseJobMessage(message.body);
    if (!parsed.ok) {
      await poison(deps, message, parsed.reason, parsed.jobId);
      counts.poison += 1;
      continue;
    }
    const job = parsed.message;
    try {
      const event = await loadOutboxEvent(deps.sql, job.jobId);
      if (!event) {
        logEvent("warn", "job_without_outbox_row", { jobId: job.jobId, kind: job.kind });
        message.ack();
        counts.skipped += 1;
        continue;
      }
      if (event.tenantId !== job.tenantId || event.eventType !== job.eventType) {
        await poison(deps, message, "message-does-not-match-outbox-row", job.jobId);
        counts.poison += 1;
        continue;
      }
      if (event.status === "processed" || event.status === "dead-letter") {
        message.ack();
        counts[event.status === "processed" ? "deduplicated" : "skipped"] += 1;
        continue;
      }
      const outcome = await handleEvent(deps, event);
      message.ack();
      counts[outcome] += 1;
      logEvent("info", "job_completed", { jobId: job.jobId, kind: job.kind, outcome, attempts: message.attempts, correlationId: job.correlationId });
    } catch (error) {
      const fields = errorFields(error, false);
      if (message.attempts >= maxAttempts) {
        await deadLetterOutboxEvent(deps.sql, job.jobId, `consumer-failed:${String(fields.errorClass)}`).catch(() => undefined);
        await deps.dlq?.send({ v: JOB_SCHEMA_VERSION, poison: false, jobId: job.jobId, reason: "max-attempts" }, { contentType: "json" }).catch(() => undefined);
        message.ack();
        counts["dead-lettered"] += 1;
        metric("jobs.dead_letter", 1, { kind: job.kind });
        logEvent("error", "job_dead_lettered", { jobId: job.jobId, kind: job.kind, attempts: message.attempts, ...fields });
      } else {
        await noteQueuedFailure(deps.sql, job.jobId, `consumer-failed:${String(fields.errorClass)}`).catch(() => undefined);
        const delaySeconds = Math.max(1, Math.round(backoffDelay(message.attempts, 10_000, 15 * 60_000) / 1000));
        message.retry({ delaySeconds });
        counts.retried += 1;
        metric("jobs.retry", 1, { kind: job.kind });
        logEvent("warn", "job_retry", { jobId: job.jobId, kind: job.kind, attempts: message.attempts, delaySeconds, ...fields });
      }
    }
  }
  return counts;
}

/**
 * Dead-letter queue consumer: makes sure the outbox row shows `dead-letter` so the replay tool
 * lists it, then acknowledges. It never re-runs the job; replay is an operator decision.
 */
export async function consumeDeadLetters(batch: QueueBatch, sql: Sql): Promise<number> {
  let recorded = 0;
  for (const message of batch.messages) {
    const body = message.body as { jobId?: unknown; reason?: unknown } | null;
    const parsed = parseJobMessage(message.body);
    const jobId = parsed.ok ? parsed.message.jobId : typeof body?.jobId === "string" && /^[0-9a-f-]{36}$/i.test(body.jobId) ? body.jobId : null;
    if (jobId) {
      await deadLetterOutboxEvent(sql, jobId, `dead-letter-queue:${typeof body?.reason === "string" ? body.reason.slice(0, 80) : "max-retries"}`);
      recorded += 1;
    }
    metric("jobs.dead_letter_received", 1, { identified: Boolean(jobId) });
    message.ack();
  }
  return recorded;
}
