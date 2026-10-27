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

/** Returns true when seeding the isolated synthetic staging database. */
export function assertSyntheticEnvironment(): boolean {
  const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
  if (env === "production") throw new Error("Synthetic seed/reset is disabled in production");
  const urls = [process.env.MIGRATION_DATABASE_URL, process.env.DATABASE_URL].filter((value): value is string => Boolean(value));
  if (!urls.length) throw new Error("DATABASE_URL is required");
  const names = new Set(urls.map(databaseName));
  if (names.size !== 1) throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL target different databases");
  const [name] = [...names];
  if (name === "medveris_staging") {
    if (env !== "staging") throw new Error("Seeding medveris_staging requires APP_ENV=staging");
    return true;
  }
  if (!/^medveris_(dev|test)$/.test(name!) || env === "staging") {
    throw new Error("Synthetic seed requires medveris_dev/medveris_test, or medveris_staging with APP_ENV=staging");
  }
  return false;
}

export function databaseName(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/^\//, "");
}

const ROLE_PASSWORD_VARS = ["MIGRATOR_PASSWORD", "RUNTIME_PASSWORD", "JOBS_PASSWORD"] as const;
const DEV_ROLE_PASSWORDS = new Set(["medveris_migrator_dev", "medveris_runtime_dev", "medveris_jobs_dev"]);

/**
 * Hosted databases (anything but medveris_dev/medveris_test) must not receive the published
 * development role passwords or be provisioned through a different server's admin connection.
 */
export function assertRoleProvisioningInputs(env: Record<string, string | undefined>): void {
  const migrationUrl = env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");
  const target = databaseName(migrationUrl);
  if (/^medveris_(dev|test)$/.test(target)) return;
  if (!env.PGADMIN_URL) throw new Error(`PGADMIN_URL is required to provision ${target}`);
  if (new URL(env.PGADMIN_URL).host !== new URL(migrationUrl).host) {
    throw new Error("PGADMIN_URL and MIGRATION_DATABASE_URL must point at the same database server");
  }
  const values = ROLE_PASSWORD_VARS.map((name) => {
    const value = env[name] ?? "";
    if (value.length < 20 || DEV_ROLE_PASSWORDS.has(value)) {
      throw new Error(`${name} must be a unique value of at least 20 characters to provision ${target}`);
    }
    return value;
  });
  if (new Set(values).size !== values.length) throw new Error("Role passwords must be distinct");
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
