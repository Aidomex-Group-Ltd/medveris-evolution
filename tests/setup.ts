import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.APP_ENV = "test";
process.env.DEV_SHOW_TOTP_SECRETS = "true";

// Structured telemetry is asserted through explicit sinks in tests; keep the console readable.
const { setLogSink } = await import("@medveris/platform");
if (process.env.MEDVERIS_TEST_TELEMETRY !== "1") setLogSink(() => undefined);
