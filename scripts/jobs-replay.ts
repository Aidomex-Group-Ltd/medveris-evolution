/**
 * Lists and replays dead-lettered outbox events with the jobs role. Listing prints identifiers,
 * types and error classes only, never payloads.
 *
 *   npx tsx scripts/jobs-replay.ts list
 *   npx tsx scripts/jobs-replay.ts replay --ids=<uuid,uuid> --operator="name" --reason="why"
 *
 * Replayed events are relayed again by the next jobs cycle; consumers deduplicate by event ID.
 */
import { createSql } from "@medveris/db";
import { listDeadLetters, replayDeadLetters } from "../apps/jobs/src/replay.js";
import { loadLocalEnv } from "./lib.js";

loadLocalEnv();

const command = process.argv[2];
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = process.env.JOBS_DATABASE_URL;
if (!url) throw new Error("JOBS_DATABASE_URL is required (the medveris_jobs role)");
const sql = createSql(url, { max: 1 });

try {
  if (command === "list") {
    const rows = await listDeadLetters(sql);
    console.log(JSON.stringify(rows.map((row) => ({ ...row, lastError: row.lastError?.slice(0, 120) ?? null })), null, 2));
  } else if (command === "replay") {
    const ids = (flag("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (!ids.length || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("--ids must list event UUIDs");
    const replayed = await replayDeadLetters(sql, ids, flag("operator") ?? "", flag("reason") ?? "");
    console.log(JSON.stringify({ replayed, skipped: ids.filter((id) => !replayed.includes(id)) }, null, 2));
  } else {
    console.error("usage: jobs-replay.ts <list|replay> [--ids=...] [--operator=...] [--reason=...]");
    process.exitCode = 2;
  }
} finally {
  await sql.end({ timeout: 5 });
}
