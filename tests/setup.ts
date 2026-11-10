import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envTest = resolve(process.cwd(), ".env.test");
const envFile = resolve(process.cwd(), ".env");
if (existsSync(envTest)) process.loadEnvFile(envTest);
else if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.APP_ENV = "test";
process.env.DEV_SHOW_TOTP_SECRETS = "true";

function assertTestDatabase(urlName: string): void {
  const url = process.env[urlName];
  if (!url) throw new Error(`${urlName} is required for tests`);
  const parsed = new URL(url);
  const host = parsed.hostname;
  const db = parsed.pathname.replace(/^\//, "");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!local || !db.endsWith("_test")) {
    throw new Error(`Refusing to run tests: ${urlName} must target a local *_test database`);
  }
}
assertTestDatabase("DATABASE_URL");

// Structured telemetry is asserted through explicit sinks in tests; keep the console readable.
const { setLogSink } = await import("@medveris/platform");
if (process.env.MEDVERIS_TEST_TELEMETRY !== "1") setLogSink(() => undefined);
