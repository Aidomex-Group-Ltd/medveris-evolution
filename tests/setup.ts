import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.APP_ENV = "test";
process.env.DEV_SHOW_TOTP_SECRETS = "true";
