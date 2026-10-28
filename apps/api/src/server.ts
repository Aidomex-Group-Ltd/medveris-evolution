import { serve } from "@hono/node-server";
import { createSql, DatabaseRouter, ShardRouter } from "@medveris/db";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { LocalMailSink } from "./lib/local-email.js";
import { ResendEmailAdapter, UnconfiguredEmailAdapter } from "./lib/email.js";
import { LocalStorage } from "./lib/local-storage.js";
import { UnconfiguredStorage } from "./lib/storage.js";
import { CoordinatedRateLimiter, LocalRateLimiter } from "./lib/rate-limit.js";
import type { EmailAdapter } from "./lib/email.js";
import type { StorageAdapter } from "./lib/storage.js";
import type { AppDeps } from "./types.js";

function loadEnvFile(): void {
  const path = `${process.cwd()}/.env`;
  try {
    process.loadEnvFile(path);
  } catch {
    /* .env is optional; configuration may come from the process environment */
  }
}

loadEnvFile();

const config = loadConfig();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const sql = createSql(databaseUrl, { max: 10 });

const email: EmailAdapter =
  config.emailAdapter === "resend"
    ? new ResendEmailAdapter(config.resendApiKey, config.emailFrom)
    : config.emailAdapter === "local"
      ? new LocalMailSink(config.mailSinkDir)
      : new UnconfiguredEmailAdapter();

const storage: StorageAdapter =
  config.storageAdapter === "local" ? new LocalStorage(config.localUploadDir) : new UnconfiguredStorage();

// A single Node process is one "instance": rate limits are local to it, and there is no replica.
const deps: AppDeps = {
  sql,
  db: DatabaseRouter.primaryOnly(sql),
  shards: new ShardRouter(config.shardTopology),
  rateLimiter: new CoordinatedRateLimiter(null, new LocalRateLimiter(), config.rateLimit.overrides),
  config,
  email,
  storage,
};
const app = createApp(deps);

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ event: "api_listening", port: info.port, appEnv: config.appEnv, terminologyMode: config.terminologyMode }));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "api_shutdown", signal }));
  server.close();
  try {
    await sql.end({ timeout: 5 });
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
