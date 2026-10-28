import { createSql } from "@medveris/db";
import { checkpointAllTenants } from "./integrity.js";
import { runJobsCycle } from "./cycle.js";
import { syncContentFeeds } from "./feeds/sync.js";

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
const contentFeedsEnabled = process.env.CONTENT_FEEDS_ENABLED === "true";
const sql = createSql(databaseUrl, { max: 4 });

let stopping = false;
let lastFeedSync = 0;

async function feedCycle(): Promise<void> {
  if (!contentFeedsEnabled || Date.now() - lastFeedSync < 60_000) return;
  lastFeedSync = Date.now();
  try {
    const sources = await syncContentFeeds(sql);
    if (sources.length) console.log(JSON.stringify({ event: "content_feeds", sources }));
  } catch (error) {
    console.error(JSON.stringify({ event: "content_feeds_failed", message: (error as Error).message }));
  }
}

async function cycle(): Promise<void> {
  await feedCycle();
  const { processed, checkpoints, checkpointError } = await runJobsCycle(sql, signingKey!, keyId);
  if (checkpointError) {
    console.error(JSON.stringify({ event: "checkpoint_failed", message: checkpointError }));
  } else if (processed || checkpoints.length) {
    console.log(JSON.stringify({
      event: "jobs_cycle",
      processed,
      checkpoints: checkpoints.map((checkpoint) => ({ tenant: checkpoint.tenantId, batch: checkpoint.batchNumber, count: checkpoint.eventCount })),
    }));
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
