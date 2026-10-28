import { randomUUID } from "node:crypto";
import type { Sql } from "@medveris/db";

export interface DeadLetter {
  id: string;
  tenantId: string | null;
  eventType: string;
  attemptCount: number;
  lastError: string | null;
  occurredAt: Date;
}

export async function listDeadLetters(sql: Sql, limit = 100): Promise<DeadLetter[]> {
  const rows = await sql`
    select id, tenant_id, event_type, attempt_count, last_error, occurred_at
      from outbox_events where status = 'dead-letter'
     order by occurred_at limit ${Math.min(limit, 1000)}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    tenantId: row.tenantId ? String(row.tenantId) : null,
    eventType: String(row.eventType),
    attemptCount: Number(row.attemptCount),
    lastError: row.lastError ? String(row.lastError) : null,
    occurredAt: row.occurredAt as Date,
  }));
}

/**
 * Operator replay: returns named dead-lettered events to `pending` with a fresh attempt budget
 * and records who did it and why. Rows that are not dead-lettered are left alone, so running
 * the same replay twice changes nothing the second time.
 */
export async function replayDeadLetters(sql: Sql, ids: string[], operator: string, reason: string): Promise<string[]> {
  if (!ids.length) return [];
  if (operator.trim().length < 2) throw new Error("operator is required");
  if (reason.trim().length < 5) throw new Error("a replay reason is required");
  return sql.begin(async (tx) => {
    const rows = await tx`
      select id, status, attempt_count, last_error from outbox_events
       where id = any(${ids}::uuid[]) and status = 'dead-letter'
       for update
    `;
    for (const row of rows) {
      await tx`
        insert into outbox_replays (id, event_id, operator, reason, previous_status, previous_attempts, previous_error)
        values (${randomUUID()}, ${row.id}, ${operator.trim().slice(0, 120)}, ${reason.trim().slice(0, 500)}, ${row.status}, ${row.attemptCount}, ${row.lastError})
      `;
      await tx`
        update outbox_events set status = 'pending', attempt_count = 0, next_attempt_at = now(), claimed_at = null,
               last_error = 'replayed-by-operator'
         where id = ${row.id}
      `;
    }
    return rows.map((row) => String(row.id));
  }) as Promise<string[]>;
}
