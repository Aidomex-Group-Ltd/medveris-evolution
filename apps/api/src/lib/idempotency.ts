import type { Context } from "hono";
import { ValidationError } from "./errors.js";
import type { AppEnv } from "../types.js";

/** Optional Idempotency-Key header; when present it must be 8–200 characters. */
export function idempotencyKey(c: Context<AppEnv>): string | null {
  const key = c.req.header("idempotency-key");
  if (!key) return null;
  if (key.length < 8 || key.length > 200) throw new ValidationError("Idempotency-Key must be 8 to 200 characters");
  return key;
}

/** Name of the unique constraint a PostgreSQL error violated, or null for any other error. */
export function uniqueViolation(error: unknown): string | null {
  if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "23505") return null;
  return String((error as { constraint_name?: unknown }).constraint_name ?? "");
}
