import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

try {
  process.loadEnvFile(`${process.cwd()}/.env`);
} catch {
  /* environment may be supplied externally */
}

const url = process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL;
const tenantId = process.env.SMOKE_TENANT_ID ?? "11111111-1111-4111-8111-111111111111";
if (!url) throw new Error("JOBS_DATABASE_URL or DATABASE_URL is required");
if (!process.env.AUDIT_SIGNING_KEY) throw new Error("AUDIT_SIGNING_KEY is required");

const client = new Client({ connectionString: url });
await client.connect();
const eventId = randomUUID();
const idempotencyKey = `workers-smoke:${eventId}`;

try {
  await client.query(
    `insert into outbox_events (id, tenant_id, event_type, aggregate_id, aggregate_version, payload, idempotency_key)
     values ($1, $2, 'clinical.entry.signed', $3, 1, $4::jsonb, $5)`,
    [eventId, tenantId, randomUUID(), JSON.stringify({ synthetic: true, source: "workers-smoke" }), idempotencyKey],
  );
} catch (error) {
  await client.end();
  throw error;
}

const run = spawnSync("npx", ["tsx", "apps/jobs/src/index.ts", "--once"], {
  stdio: "inherit",
  env: process.env,
});
if (run.status !== 0) {
  await client.end();
  throw new Error(`worker drain failed with exit code ${run.status}`);
}

const processed = await client.query(
  "select status, attempt_count, processed_at, last_error from outbox_events where id = $1",
  [eventId],
);
const dedup = await client.query("select processor from processed_outbox_events where event_id = $1", [eventId]);
const checkpoint = await client.query(
  `select batch_number, event_count, merkle_root, signature, signature_key_id, ledger_state
     from integrity_checkpoints
    where tenant_id = $1
    order by batch_number desc
    limit 1`,
  [tenantId],
);
await client.end();

const event = processed.rows[0];
if (!event) throw new Error("smoke event disappeared");
if (event.status !== "processed") throw new Error(`smoke event is ${event.status}: ${event.last_error ?? ""}`);
if (dedup.rows.length !== 1) throw new Error("processed_outbox_events dedup record missing");
if (!checkpoint.rows.length) throw new Error("integrity checkpoint missing");
const proof = checkpoint.rows[0];
if (!proof.merkle_root || !proof.signature || proof.signature.length < 32) throw new Error("checkpoint proof is incomplete");
if (proof.ledger_state !== "not-requested") throw new Error(`unexpected ledger state ${proof.ledger_state}`);

console.log(JSON.stringify({
  ok: true,
  eventId,
  status: event.status,
  attempts: event.attempt_count,
  processedAt: event.processed_at,
  processor: dedup.rows[0].processor,
  checkpoint: {
    batchNumber: proof.batch_number,
    eventCount: proof.event_count,
    merkleRoot: proof.merkle_root,
    signatureKeyId: proof.signature_key_id,
    ledgerState: proof.ledger_state,
  },
}, null, 2));
