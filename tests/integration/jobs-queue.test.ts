import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, type Sql } from "@medveris/db";
import { jobMessageSchema, kindForEvent, parseJobMessage } from "../../apps/jobs/src/contracts.js";
import { claimOutboxBatch, reclaimStaleOutbox } from "../../apps/jobs/src/outbox.js";
import { consumeDeadLetters, consumeJobBatch, relayOutbox, type QueueMessage, type QueueProducer } from "../../apps/jobs/src/queue.js";
import { listDeadLetters, replayDeadLetters } from "../../apps/jobs/src/replay.js";

const KAMPALA = "11111111-1111-4111-8111-111111111111";
const GULU = "22222222-2222-4222-8222-222222222222";
const TYPE = "maintenance.scaling-test";
let sql: Sql;

/** Synthetic events dated in 2000 so these tests claim them ahead of anything else pending locally. */
async function insertEvent(tenantId: string, occurredAt: string, payload: Record<string, unknown> = { synthetic: true }): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    insert into outbox_events (id, tenant_id, event_type, aggregate_id, payload, occurred_at, next_attempt_at)
    values (${id}, ${tenantId}, ${TYPE}, ${crypto.randomUUID()}, ${sql.json(payload as never)}, ${occurredAt}, '2000-01-01')
  `;
  return id;
}

async function status(id: string) {
  const [row] = await sql`select status, attempt_count, last_error, publish_count from outbox_events where id = ${id}`;
  return row!;
}

/** Leaves every claimed event that this file did not create exactly as it was found. */
async function release(claimedIds: string[], ours: Set<string>): Promise<void> {
  const others = claimedIds.filter((id) => !ours.has(id));
  if (others.length) await sql`update outbox_events set status = 'pending', attempt_count = greatest(attempt_count - 1, 0), claimed_at = null where id = any(${others}::uuid[])`;
}

class CapturingProducer implements QueueProducer {
  batches: unknown[][] = [];
  sent: unknown[] = [];
  fail = false;
  async sendBatch(messages: Iterable<{ body: unknown }>): Promise<void> {
    if (this.fail) throw new Error("queue unavailable");
    this.batches.push([...messages].map((message) => message.body));
  }
  async send(body: unknown): Promise<void> {
    this.sent.push(body);
  }
}

function message(body: unknown, attempts = 1) {
  const result = { acked: false, retried: null as null | { delaySeconds?: number } };
  const msg: QueueMessage = {
    id: crypto.randomUUID(),
    body,
    attempts,
    ack: () => { result.acked = true; },
    retry: (options) => { result.retried = options ?? {}; },
  };
  return { msg, result };
}

beforeAll(async () => {
  sql = createSql(process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL!, { max: 2 });
  await sql`update outbox_events set status = 'dead-letter', last_error = 'stale scaling test event' where event_type = ${TYPE} and status in ('pending', 'processing', 'queued')`;
});

afterAll(async () => {
  await sql`update outbox_events set status = 'dead-letter', last_error = 'scaling test cleanup' where event_type = ${TYPE} and status in ('pending', 'processing', 'queued')`;
  await sql.end({ timeout: 5 });
});

describe("job contract", () => {
  it("carries identifiers only and rejects unexpected fields", () => {
    expect(Object.keys(jobMessageSchema.shape).sort()).toEqual(["aggregateId", "claim", "correlationId", "enqueuedAt", "eventType", "jobId", "kind", "tenantId", "v"]);
    const valid = { v: 1, jobId: crypto.randomUUID(), kind: "record", eventType: "encounter.created", tenantId: KAMPALA, aggregateId: null, claim: 1, correlationId: null, enqueuedAt: new Date().toISOString() };
    expect(parseJobMessage(valid).ok).toBe(true);
    const withPayload = parseJobMessage({ ...valid, payload: { patientId: "x" } });
    expect(withPayload).toMatchObject({ ok: false, jobId: valid.jobId });
    expect(parseJobMessage({ ...valid, v: 2 }).ok).toBe(false);
  });

  it("maps event families to job kinds", () => {
    expect(kindForEvent("lab.result.released")).toBe("interoperability");
    expect(kindForEvent("content.published")).toBe("search-index");
    expect(kindForEvent("consent.grant.revoked")).toBe("audit");
    expect(kindForEvent("encounter.created")).toBe("record");
  });
});

describe("outbox relay and queue consumer", () => {
  it("publishes committed events as identifier-only messages and marks them queued", async () => {
    const id = await insertEvent(KAMPALA, "2000-01-01T00:00:00Z", { patientId: "synthetic-patient", note: "never in a message" });
    const producer = new CapturingProducer();
    const result = await relayOutbox(sql, producer, { batchSize: 5, perTenant: 5, maxBatches: 1 });
    const bodies = producer.batches.flat() as Array<Record<string, unknown>>;
    const ours = bodies.find((body) => body.jobId === id)!;
    expect(ours).toMatchObject({ v: 1, jobId: id, tenantId: KAMPALA, eventType: TYPE, kind: "maintenance" });
    expect(JSON.stringify(bodies)).not.toMatch(/synthetic-patient|never in a message|payload/);
    expect(result.published).toBe(bodies.length);
    expect(await status(id)).toMatchObject({ status: "queued", publishCount: 1 });
    await sql`update outbox_events set status = 'pending' where id = any(${bodies.map((body) => body.jobId as string).filter((jobId) => jobId !== id)}::uuid[]) and status = 'queued'`;

    const first = message(ours);
    const counts = await consumeJobBatch({ queue: "medveris-jobs", messages: [first.msg] }, { sql, dlq: null, realtime: null, realtimeEventTypes: [] });
    expect(counts.processed).toBe(1);
    expect(first.result.acked).toBe(true);
    expect((await status(id)).status).toBe("processed");

    const duplicate = message(ours, 2);
    const again = await consumeJobBatch({ queue: "medveris-jobs", messages: [duplicate.msg] }, { sql, dlq: null, realtime: null, realtimeEventTypes: [] });
    expect(again.deduplicated).toBe(1);
    expect(duplicate.result.acked).toBe(true);
    const [dedup] = await sql`select count(*)::int as n from processed_outbox_events where event_id = ${id}`;
    expect(dedup!.n).toBe(1);
  });

  it("leaves events due again when the queue rejects a publish", async () => {
    const id = await insertEvent(KAMPALA, "2000-01-01T00:00:01Z");
    const producer = new CapturingProducer();
    producer.fail = true;
    const result = await relayOutbox(sql, producer, { batchSize: 1, perTenant: 1, maxBatches: 1 });
    expect(result.failed).toBe(1);
    const row = await status(id);
    expect(row.status).toBe("pending");
    expect(row.lastError).toBe("queue-publish-failed");
    await sql`update outbox_events set next_attempt_at = '2000-01-01' where id = ${id}`;
  });

  it("isolates poison messages and messages that do not match their outbox row", async () => {
    const dlq = new CapturingProducer();
    const garbage = message({ hello: "world" });
    const id = await insertEvent(KAMPALA, "2000-01-01T00:00:02Z");
    const forged = message({ v: 1, jobId: id, kind: "record", eventType: TYPE, tenantId: GULU, aggregateId: null, claim: 1, correlationId: null, enqueuedAt: new Date().toISOString() });
    const counts = await consumeJobBatch({ queue: "medveris-jobs", messages: [garbage.msg, forged.msg] }, { sql, dlq, realtime: null, realtimeEventTypes: [] });
    expect(counts.poison).toBe(2);
    expect(garbage.result.acked && forged.result.acked).toBe(true);
    expect((await status(id)).status).toBe("dead-letter");
    expect(dlq.sent).toHaveLength(2);
    expect(JSON.stringify(dlq.sent)).not.toContain("world");
  });

  it("retries failures with backoff and dead-letters after the attempt limit; the DLQ consumer and replay recover it", async () => {
    const id = await insertEvent(KAMPALA, "2000-01-01T00:00:03Z");
    await sql`update outbox_events set status = 'queued', queued_at = now() where id = ${id}`;
    const body = { v: 1, jobId: id, kind: "maintenance", eventType: TYPE, tenantId: KAMPALA, aggregateId: null, claim: 1, correlationId: "corr-12345678", enqueuedAt: new Date().toISOString() };
    const failing = { sql, dlq: new CapturingProducer(), realtime: null, realtimeEventTypes: [], maxAttempts: 3, dispatch: () => { throw new Error("adapter down"); } };

    const early = message(body, 1);
    expect((await consumeJobBatch({ queue: "medveris-jobs", messages: [early.msg] }, failing)).retried).toBe(1);
    expect(early.result.retried?.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(early.result.acked).toBe(false);
    expect(await status(id)).toMatchObject({ status: "queued", lastError: "consumer-failed:Error" });

    const final = message(body, 3);
    expect((await consumeJobBatch({ queue: "medveris-jobs", messages: [final.msg] }, failing))["dead-lettered"]).toBe(1);
    expect(final.result.acked).toBe(true);
    expect((await status(id)).status).toBe("dead-letter");
    expect(failing.dlq.sent).toEqual([{ v: 1, poison: false, jobId: id, reason: "max-attempts" }]);

    const dlqMessage = message(failing.dlq.sent[0]);
    expect(await consumeDeadLetters({ queue: "medveris-jobs-dlq", messages: [dlqMessage.msg] }, sql)).toBe(1);
    expect((await listDeadLetters(sql, 1000)).some((row) => row.id === id)).toBe(true);

    await expect(replayDeadLetters(sql, [id], "o", "short")).rejects.toThrow();
    expect(await replayDeadLetters(sql, [id], "on-call engineer", "adapter restored after outage")).toEqual([id]);
    expect(await replayDeadLetters(sql, [id], "on-call engineer", "adapter restored after outage")).toEqual([]);
    expect(await status(id)).toMatchObject({ status: "pending", attemptCount: 0 });
    const [trail] = await sql`select operator, reason, previous_status from outbox_replays where event_id = ${id}`;
    expect(trail).toMatchObject({ operator: "on-call engineer", previousStatus: "dead-letter" });
    await sql`update outbox_events set status = 'dead-letter' where id = ${id}`;
  });

  it("reclaims events left processing by a crashed run and queued events that were never consumed", async () => {
    const stuck = await insertEvent(KAMPALA, "2000-01-01T00:00:04Z");
    const lost = await insertEvent(KAMPALA, "2000-01-01T00:00:05Z");
    await sql`update outbox_events set status = 'processing', claimed_at = now() - interval '2 hours' where id = ${stuck}`;
    await sql`update outbox_events set status = 'queued', queued_at = now() - interval '2 hours' where id = ${lost}`;
    const reclaimed = await reclaimStaleOutbox(sql, { processingLeaseSeconds: 600, queuedRedeliverSeconds: 1800 });
    expect(reclaimed.processing).toBeGreaterThanOrEqual(1);
    expect(reclaimed.queued).toBeGreaterThanOrEqual(1);
    expect((await status(stuck)).status).toBe("pending");
    expect((await status(lost)).status).toBe("pending");
    await sql`update outbox_events set status = 'dead-letter' where id = any(${[stuck, lost]}::uuid[])`;
  });

  it("claims fairly across tenants so one tenant's backlog cannot starve another", async () => {
    const kampala: string[] = [];
    for (let i = 0; i < 12; i += 1) kampala.push(await insertEvent(KAMPALA, `1999-01-01T00:00:${String(i).padStart(2, "0")}Z`));
    const gulu = [await insertEvent(GULU, "1999-06-01T00:00:00Z"), await insertEvent(GULU, "1999-06-01T00:00:01Z")];
    const ours = new Set([...kampala, ...gulu]);
    const claimed = await claimOutboxBatch(sql, { limit: 8, perTenant: 4 });
    const ids = claimed.map((event) => event.id);
    await release(ids, ours);
    expect(ids.filter((id) => kampala.includes(id))).toHaveLength(4);
    expect(gulu.every((id) => ids.includes(id))).toBe(true);
    await sql`update outbox_events set status = 'dead-letter' where id = any(${[...ours]}::uuid[])`;
  });
});
