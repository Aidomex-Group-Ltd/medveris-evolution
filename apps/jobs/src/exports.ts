import type { Sql, Tx } from "@medveris/db";
import { withContext } from "@medveris/db";
import { errorFields, logEvent, metric } from "@medveris/platform";

/**
 * Retention sweep for bulk export jobs.
 *
 * Export payloads are stored server-side so a copied job id is never a data disclosure; once the
 * download window has closed the payload is patient data with no legitimate reader left, so the
 * scheduled purge nulls it. The job row itself is retained as the audit record (dataset, scope,
 * requester, row counts, content digest). The sweep is idempotent and runs as the system actor.
 */

export interface ExportPurgeResult {
  purged: number;
  error: string | null;
}

/** Exports expire on a schedule measured in minutes, so a slow cadence is enough. */
const EXPORT_PURGE_INTERVAL_MS = 10 * 60_000;
let lastPurgeRun = 0;

export async function purgeExpiredExports(tx: Tx): Promise<number> {
  const purged = await tx`
    update data_exchange_jobs
       set content = null, download_token_hash = null
     where kind = 'export' and content is not null and expires_at is not null and expires_at <= now()
     returning id`;
  return purged.length;
}

export async function maybePurgeExpiredExports(sql: Sql, now = Date.now()): Promise<ExportPurgeResult> {
  if (now - lastPurgeRun < EXPORT_PURGE_INTERVAL_MS) return { purged: 0, error: null };
  lastPurgeRun = now;
  try {
    const purged = await withContext(sql, { actorKind: "system" }, (tx: Tx) => purgeExpiredExports(tx));
    if (purged) metric("jobs.export_purge", purged, {});
    return { purged, error: null };
  } catch (error) {
    logEvent("error", "export_purge_failed", errorFields(error, false));
    return { purged: 0, error: (error as Error).message };
  }
}
