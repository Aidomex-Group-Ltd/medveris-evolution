import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertTestDatabase } from "./assert-test-database.js";
import { assertNoOtherTestSessions, refreshSyntheticOperatorGrant } from "./test-db.js";

const envTest = resolve(process.cwd(), ".env.test");
const envFile = resolve(process.cwd(), ".env");
if (existsSync(envTest)) process.loadEnvFile(envTest);
else if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.APP_ENV = "test";
process.env.DEV_SHOW_TOTP_SECRETS = "true";

assertTestDatabase("DATABASE_URL");
assertTestDatabase("MIGRATION_DATABASE_URL");
await assertNoOtherTestSessions();
await refreshSyntheticOperatorGrant();

// Structured telemetry is asserted through explicit sinks in tests; keep the console readable.
const { setLogSink } = await import("@medveris/platform");
if (process.env.MEDVERIS_TEST_TELEMETRY !== "1") setLogSink(() => undefined);
