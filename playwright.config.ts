import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertTestDatabase } from "./tests/assert-test-database.js";

const testEnv = resolve(process.cwd(), ".env.test");
if (!existsSync(testEnv)) throw new Error(".env.test is required for E2E tests");
process.loadEnvFile(testEnv);
process.env.APP_ENV = "test";
process.env.DEV_SHOW_TOTP_SECRETS = "true";
const e2eApiPort = "18787";
process.env.API_PORT = e2eApiPort;
assertTestDatabase();

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, PORT: e2eApiPort, API_PORT: e2eApiPort, PLAYWRIGHT_TEST: "1" },
  },
});
