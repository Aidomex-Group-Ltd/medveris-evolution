import { randomUUID } from "node:crypto";
import type { Sql } from "@medveris/db";

export interface OutboxEvent {
  id: string;
  tenantId: string | null;
  eventType: string;
  aggregateId: string | null;
  aggregateVersion: number | null;
  payload: Record<string, unknown>;
  attemptCount: number;
  status?: string;
}

export interface DispatchResult {
  handled: boolean;
  detail: string;
}

export const MAX_ATTEMPTS = 6;

function toEvent(row: Record<string, unknown>): OutboxEvent {
  return {
    id: String(row.id),
    tenantId: row.tenantId ? String(row.tenantId) : null,
    eventType: String(row.eventType),
    aggregateId: row.aggregateId ? String(row.aggregateId) : null,
    aggregateVersion: row.aggregateVersion == null ? null : Number(row.aggregateVersion),
    payload: (row.payload as Record<string, unknown>) ?? {},
    attemptCount: Number(row.attemptCount),
    status: row.status == null ? undefined : String(row.status),
  };
}

export async function claimOutboxEvent(sql: Sql): Promise<OutboxEvent | null> {
  const rows = await sql`
    update outbox_events
       set status = 'processing', attempt_count = attempt_count + 1, claimed_at = now()
     where id = (
       select id from outbox_events
        where status = 'pending' and next_attempt_at <= now()
        order by occurred_at
        for update skip locked
        limit 1
     )
    returning id, tenant_id, event_type, aggregate_id, aggregate_version, payload, attempt_count
  `;
  const row = rows[0];
  return row ? toEvent(row) : null;
}

/**
 * Claims up to `limit` due events, at most `perTenant` from any one tenant, oldest first. A
 * tenant with a large backlog therefore cannot delay every other tenant's events.
 */
export async function claimOutboxBatch(sql: Sql, options: { limit: number; perTenant: number }): Promise<OutboxEvent[]> {
  const rows = await sql`
    with candidates as (
      select id, tenant_id, occurred_at from outbox_events
       where status = 'pending' and next_attempt_at <= now()
       order by occurred_at
       limit ${options.limit * 10}
       for update skip locked
    ), ranked as (
      select id, occurred_at, row_number() over (partition by tenant_id order by occurred_at) as tenant_rank
        from candidates
    ), chosen as (
      select id from ranked where tenant_rank <= ${options.perTenant} order by occurred_at limit ${options.limit}
    )
    update outbox_events o
       set status = 'processing', attempt_count = attempt_count + 1, claimed_at = now()
      from chosen
     where o.id = chosen.id
    returning o.id, o.tenant_id, o.event_type, o.aggregate_id, o.aggregate_version, o.payload, o.attempt_count, o.occurred_at
  `;
  return rows
    .sort((a, b) => new Date(a.occurredAt as string).getTime() - new Date(b.occurredAt as string).getTime())
    .map(toEvent);
}

/** Published to the queue: delivery is now the queue's job; the row records that it was handed over. */
export async function markQueued(sql: Sql, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await sql`
    update outbox_events set status = 'queued', queued_at = now(), publish_count = publish_count + 1
     where id = any(${ids}::uuid[]) and status = 'processing'
  `;
}

/** A failed publish returns the claim with backoff; the attempt still counts towards dead-lettering. */
export async function releaseClaims(sql: Sql, events: OutboxEvent[], error: string): Promise<void> {
  for (const event of events) await failOutboxEvent(sql, event, error);
}

export interface ReclaimResult {
  processing: number;
  queued: number;
}

/**
 * Rows left `processing` by a crashed run, and rows `queued` whose message was never
 * consumed, become due again. Consumers deduplicate by event ID, so a redelivery after a
 * message that was in fact processed is harmless.
 */
export async function reclaimStaleOutbox(sql: Sql, options: { processingLeaseSeconds: number; queuedRedeliverSeconds: number }): Promise<ReclaimResult> {
  const processing = await sql`
    update outbox_events set status = 'pending', last_error = 'reclaimed-after-lease-expiry'
     where status = 'processing' and claimed_at is not null
       and claimed_at < now() - (${options.processingLeaseSeconds} * interval '1 second')
    returning id
  `;
  const queued = await sql`
    update outbox_events set status = 'pending', last_error = 'redelivery-after-queue-timeout'
     where status = 'queued' and queued_at < now() - (${options.queuedRedeliverSeconds} * interval '1 second')
    returning id
  `;
  return { processing: processing.length, queued: queued.length };
}

export async function loadOutboxEvent(sql: Sql, id: string): Promise<OutboxEvent | null> {
  const rows = await sql`
    select id, tenant_id, event_type, aggregate_id, aggregate_version, payload, attempt_count, status
      from outbox_events where id = ${id}
  `;
  return rows[0] ? toEvent(rows[0]) : null;
}

export async function completeOutboxEvent(sql: Sql, event: OutboxEvent, processor: string, detail: string): Promise<"processed" | "deduplicated"> {
  return sql.begin(async (tx) => {
    const inserted = await tx`
      insert into processed_outbox_events (event_id, processor)
      values (${event.id}, ${processor})
      on conflict (event_id) do nothing
      returning event_id
    `;
    if (!inserted.length) {
      await tx`update outbox_events set status = 'processed', processed_at = coalesce(processed_at, now()), last_error = 'deduplicated' where id = ${event.id}`;
      return "deduplicated" as const;
    }
    await tx`
      update outbox_events set status = 'processed', processed_at = now(), last_error = ${detail.slice(0, 1000)}
       where id = ${event.id}
    `;
    return "processed" as const;
  }) as Promise<"processed" | "deduplicated">;
}

export async function failOutboxEvent(sql: Sql, event: OutboxEvent, error: string): Promise<"pending" | "dead-letter"> {
  const dead = event.attemptCount >= MAX_ATTEMPTS;
  const backoffSeconds = Math.min(3600, 2 ** event.attemptCount * 5);
  await sql`
    update outbox_events
       set status = ${dead ? "dead-letter" : "pending"},
           last_error = ${error.slice(0, 1000)},
           next_attempt_at = now() + (${backoffSeconds} * interval '1 second')
     where id = ${event.id} and status <> 'processed'
  `;
  return dead ? "dead-letter" : "pending";
}

export async function deadLetterOutboxEvent(sql: Sql, id: string, reason: string): Promise<void> {
  await sql`
    update outbox_events set status = 'dead-letter', last_error = ${reason.slice(0, 1000)}
     where id = ${id} and status <> 'processed'
  `;
}

/** Records a consumer failure on a queued row without changing who owns redelivery (the queue). */
export async function noteQueuedFailure(sql: Sql, id: string, error: string): Promise<void> {
  await sql`update outbox_events set last_error = ${error.slice(0, 1000)} where id = ${id} and status = 'queued'`;
}

export interface OutboxMetrics {
  status: string;
  events: number;
  oldestSeconds: number;
  maxAttempts: number;
}

export async function outboxMetrics(sql: Sql): Promise<OutboxMetrics[]> {
  const rows = await sql`
    select status, count(*)::int as events,
           coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as oldest_seconds,
           coalesce(max(attempt_count), 0)::int as max_attempts
      from outbox_events where status <> 'processed'
     group by status
  `;
  return rows.map((row) => ({ status: String(row.status), events: Number(row.events), oldestSeconds: Number(row.oldestSeconds), maxAttempts: Number(row.maxAttempts) }));
}

export function dispatchLocalEvent(event: OutboxEvent): DispatchResult {
  switch (event.eventType) {
    case "clinical.entry.signed":
    case "clinical.entry.amended":
      return { handled: true, detail: "clinical-event-recorded-no-external-delivery" };
    case "consent.grant.created":
    case "consent.grant.revoked":
      return { handled: true, detail: "consent-event-recorded" };
    case "credential.submitted":
    case "credential.decision":
      return { handled: true, detail: "credential-event-recorded" };
    case "encounter.created":
    case "encounter.triaged":
    case "encounter.state.changed":
      return { handled: true, detail: "encounter-event-recorded" };
    case "emergency.override.created":
      return { handled: true, detail: "override-review-task-recorded" };
    default:
      return { handled: true, detail: "recorded-unhandled-event-type" };
  }
}

export function stableProcessor(event: OutboxEvent): string {
  return `${event.eventType}:${event.aggregateId ?? randomUUID()}`;
}
