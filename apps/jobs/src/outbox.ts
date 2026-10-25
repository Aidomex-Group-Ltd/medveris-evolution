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
}

export interface DispatchResult {
  handled: boolean;
  detail: string;
}

const MAX_ATTEMPTS = 6;

export async function claimOutboxEvent(sql: Sql): Promise<OutboxEvent | null> {
  const rows = await sql`
    update outbox_events
       set status = 'processing', attempt_count = attempt_count + 1
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
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: row.tenantId ? String(row.tenantId) : null,
    eventType: String(row.eventType),
    aggregateId: row.aggregateId ? String(row.aggregateId) : null,
    aggregateVersion: row.aggregateVersion == null ? null : Number(row.aggregateVersion),
    payload: (row.payload as Record<string, unknown>) ?? {},
    attemptCount: Number(row.attemptCount),
  };
}

export async function completeOutboxEvent(sql: Sql, event: OutboxEvent, processor: string, detail: string): Promise<void> {
  await sql.begin(async (tx) => {
    const inserted = await tx`
      insert into processed_outbox_events (event_id, processor)
      values (${event.id}, ${processor})
      on conflict (event_id) do nothing
      returning event_id
    `;
    if (!inserted.length) {
      await tx`update outbox_events set status = 'processed', processed_at = now(), last_error = 'deduplicated' where id = ${event.id}`;
      return;
    }
    await tx`
      update outbox_events set status = 'processed', processed_at = now(), last_error = ${detail.slice(0, 1000)}
       where id = ${event.id}
    `;
  });
}

export async function failOutboxEvent(sql: Sql, event: OutboxEvent, error: string): Promise<void> {
  const dead = event.attemptCount >= MAX_ATTEMPTS;
  const backoffSeconds = Math.min(3600, 2 ** event.attemptCount * 5);
  await sql`
    update outbox_events
       set status = ${dead ? "dead-letter" : "pending"},
           last_error = ${error.slice(0, 1000)},
           next_attempt_at = now() + (${backoffSeconds} * interval '1 second')
     where id = ${event.id}
  `;
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
