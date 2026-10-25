import { createSql } from "@medveris/db";
import { claimOutboxEvent, completeOutboxEvent, dispatchLocalEvent, failOutboxEvent, stableProcessor } from "./outbox.js";
import { checkpointAllTenants } from "./integrity.js";

try {
  process.loadEnvFile(`${process.cwd()}/.env`);
} catch {
  /* environment may be supplied externally */
}

const databaseUrl = process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("JOBS_DATABASE_URL or DATABASE_URL is required");
const signingKey = process.env.AUDIT_SIGNING_KEY;
const keyId = process.env.AUDIT_SIGNING_KEY_ID ?? "local-dev-key-1";
if (!signingKey || signingKey.length < 24) throw new Error("AUDIT_SIGNING_KEY must be at least 24 characters");

const once = process.argv.includes("--once");
const sql = createSql(databaseUrl, { max: 4 });

let stopping = false;

async function drain(): Promise<number> {
  let processed = 0;
  for (;;) {
    const event = await claimOutboxEvent(sql);
    if (!event) break;
    try {
      const result = dispatchLocalEvent(event);
      await completeOutboxEvent(sql, event, stableProcessor(event), result.detail);
      processed += 1;
    } catch (error) {
      await failOutboxEvent(sql, event, (error as Error).message);
    }
  }
  return processed;
}

async function cycle(): Promise<void> {
  const processed = await drain();
  try {
    const checkpoints = await checkpointAllTenants(sql, signingKey!, keyId);
    if (processed || checkpoints.length) {
      console.log(JSON.stringify({
        event: "jobs_cycle",
        processed,
        checkpoints: checkpoints.map((checkpoint) => ({ tenant: checkpoint.tenantId, batch: checkpoint.batchNumber, count: checkpoint.eventCount })),
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "checkpoint_failed", message: (error as Error).message }));
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "jobs_shutdown", signal }));
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (once) {
  await cycle();
  await sql.end({ timeout: 5 });
} else {
  let lastCheckpoint = Date.now();
  for (;;) {
    if (stopping) break;
    await cycle();
    if (Date.now() - lastCheckpoint > 5 * 60_000) {
      lastCheckpoint = Date.now();
      try {
        const checkpoints = await checkpointAllTenants(sql, signingKey!, keyId);
        if (checkpoints.length) console.log(JSON.stringify({ event: "checkpoint_cycle", batches: checkpoints.length }));
      } catch (error) {
        console.error(JSON.stringify({ event: "checkpoint_failed", message: (error as Error).message }));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
