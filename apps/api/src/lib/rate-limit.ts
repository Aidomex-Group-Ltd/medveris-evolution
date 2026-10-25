import { AppError } from "./errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new AppError(429, "rate_limited", "Too many requests. Try again later.");
  }
  if (buckets.size > 10_000) {
    for (const [candidate, value] of buckets) if (value.resetAt <= now) buckets.delete(candidate);
  }
}

export function clientKey(headers: Headers, suffix: string): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${forwarded ?? headers.get("cf-connecting-ip") ?? "local"}:${suffix}`;
}
