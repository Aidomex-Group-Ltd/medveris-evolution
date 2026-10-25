import { createSql, type Sql } from "@medveris/db";
import { loadConfig, type AppConfig } from "./config.js";
import { createApp } from "./app.js";
import { ResendEmailAdapter, UnconfiguredEmailAdapter } from "./lib/email.js";
import { R2Storage, UnconfiguredStorage } from "./lib/storage.js";
import type { EmailAdapter } from "./lib/email.js";
import type { StorageAdapter } from "./lib/storage.js";
import type { AppDeps, AppEnv } from "./types.js";
import type { Hono } from "hono";

export interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
  UPLOADS?: unknown;
  [key: string]: unknown;
}

interface Runtime {
  sql: Sql;
  config: AppConfig;
  email: EmailAdapter;
  storage: StorageAdapter;
  app: Hono<AppEnv>;
}

let runtime: Runtime | null = null;

function envString(env: WorkerEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function initialise(env: WorkerEnv): Runtime {
  const connectionString = env.HYPERDRIVE?.connectionString ?? envString(env, "DATABASE_URL");
  if (!connectionString) throw new Error("HYPERDRIVE binding or DATABASE_URL is required");
  const config = loadConfig(env as Record<string, string | undefined>);
  const sql = createSql(connectionString, { max: 5, prepare: false });
  const email: EmailAdapter =
    config.emailAdapter === "resend" ? new ResendEmailAdapter(config.resendApiKey, config.emailFrom) : new UnconfiguredEmailAdapter();
  const storage: StorageAdapter = env.UPLOADS ? new R2Storage(env.UPLOADS as never) : new UnconfiguredStorage();
  const deps: AppDeps = { sql, config, email, storage };
  return { sql, config, email, storage, app: createApp(deps) };
}

function getRuntime(env: WorkerEnv): Runtime {
  if (!runtime) runtime = initialise(env);
  return runtime;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await getRuntime(env).app.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: "worker_error", message: (error as Error).message }));
      return new Response(
        JSON.stringify({
          resourceType: "OperationOutcome",
          issue: [{ severity: "error", code: "exception", diagnostics: "The service is not configured correctly" }],
        }),
        { status: 503, headers: { "content-type": "application/fhir+json; charset=utf-8" } },
      );
    }
  },
};
