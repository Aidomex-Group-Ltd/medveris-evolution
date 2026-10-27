import type { Sql } from "@medveris/db";
import { claimOutboxEvent, completeOutboxEvent, dispatchLocalEvent, failOutboxEvent, stableProcessor } from "./outbox.js";
import { checkpointAllTenants, type CheckpointResult } from "./integrity.js";

export interface JobsCycleResult {
  processed: number;
  checkpoints: CheckpointResult[];
  checkpointError: string | null;
}

export async function drainOutbox(sql: Sql, maxEvents = Number.POSITIVE_INFINITY): Promise<number> {
  let processed = 0;
  for (let claimed = 0; claimed < maxEvents; claimed += 1) {
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

export async function runJobsCycle(
  sql: Sql,
  signingKey: string,
  keyId: string,
  options: { maxEvents?: number } = {},
): Promise<JobsCycleResult> {
  const processed = await drainOutbox(sql, options.maxEvents);
  try {
    const checkpoints = await checkpointAllTenants(sql, signingKey, keyId);
    return { processed, checkpoints, checkpointError: null };
  } catch (error) {
    return { processed, checkpoints: [], checkpointError: (error as Error).message };
  }
}
