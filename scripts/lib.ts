import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (existsSync(path) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path);
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function assertSyntheticEnvironment(): void {
  const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
  if (env === "production") throw new Error("Synthetic seed/reset is disabled in production");
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!/medveris_(dev|test)/.test(url)) {
    throw new Error("Synthetic seed/reset requires a medveris_dev or medveris_test database");
  }
}

export function databaseName(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/^\//, "");
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
