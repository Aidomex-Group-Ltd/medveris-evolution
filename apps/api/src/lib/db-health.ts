import { breakerFor, type CircuitBreaker } from "@medveris/platform";

/** Network-level driver errors from postgres.js and Node sockets. */
const CONNECTION_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED",
]);

/**
 * SQLSTATEs meaning the server cannot serve this connection now: connection exceptions (08xxx),
 * shutdown/recovery (57P01-57P03), too many connections (53300), and a write rejected as
 * read-only (25006), which is what a demoted primary answers during a provider failover.
 */
const UNAVAILABLE_SQLSTATES = /^(08\d{3}|57P0[1-3]|53300|25006)$/;

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  if (CONNECTION_CODES.has(code) || UNAVAILABLE_SQLSTATES.test(code)) return true;
  const errno = String((error as { errno?: unknown }).errno ?? "");
  return CONNECTION_CODES.has(errno);
}

/**
 * Per-isolate breaker on the primary. After repeated connection failures the Worker answers
 * 503 with Retry-After for a few seconds instead of opening new connections, so a recovering
 * database is not met by a connection storm; one trial request then probes it.
 */
export function primaryDatabaseBreaker(): CircuitBreaker {
  return breakerFor("database.primary", {
    failureThreshold: 5,
    resetTimeoutMs: 5_000,
    isFailure: (error) => error instanceof DatabaseUnavailableSignal || isDatabaseUnavailable(error),
  });
}

/** Carries the 503 the router already produced, so the breaker counts it without losing the response. */
export class DatabaseUnavailableSignal extends Error {
  constructor(readonly response: Response) {
    super("database unavailable");
  }
}

/** Paths answered without a database query; they neither trip nor close the breaker. */
const DATABASE_FREE = new Set(["/api/v1/health/live", "/api/v1/public/config", "/api/v1/public/directory/map-config"]);

export function needsDatabase(pathname: string): boolean {
  if (DATABASE_FREE.has(pathname)) return false;
  return pathname.startsWith("/api/") || pathname.startsWith("/fhir/") || pathname.startsWith("/terminology/");
}

export const DATABASE_RETRY_AFTER_SECONDS = 5;
