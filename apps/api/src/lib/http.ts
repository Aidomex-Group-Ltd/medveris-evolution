import type { Context } from "hono";
import type { z } from "zod";
import { canonicalJson } from "@medveris/domain";
import { sha256Hex } from "@medveris/auth";
import { ConflictError, ValidationError, correlationId } from "./errors.js";
import type { AppEnv } from "../types.js";

export async function parseJson<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError("Request validation failed", result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })));
  }
  return result.data;
}

export function requestMeta(c: Context<AppEnv>) {
  return {
    ip: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

export function auditMeta(c: Context<AppEnv>) {
  return {
    correlationId: correlationId(c),
    ipAddress: c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}

export async function requireIdempotency(c: Context<AppEnv>, route: string, payload: unknown): Promise<string> {
  const key = c.req.header("idempotency-key");
  if (!key || key.length < 8 || key.length > 200) {
    throw new ValidationError("A valid Idempotency-Key header is required for this command");
  }
  return `${route}:${key}:${await sha256Hex(canonicalJson(payload))}`;
}

export function ensureMatch(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new ConflictError("The record changed since you loaded it. Reload and compare before saving.", {
      expectedVersion: expected,
      currentVersion: actual,
    });
  }
}

export function parseIntParam(c: Context<AppEnv>, name: string, fallback: number, max: number): number {
  const raw = c.req.query(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}
