import type { MiddlewareHandler } from "hono";
import { correlationIdFrom, LatencyRecorder, logEvent } from "@medveris/platform";
import type { AppEnv } from "../types.js";

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collapses identifiers out of a path so request logs carry a bounded route shape, never a
 * patient, encounter or token identifier.
 */
export function routeShape(pathname: string): string {
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/fhir/") && !pathname.startsWith("/terminology/")) return "static";
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (UUID_SEGMENT.test(segment)) return ":id";
      if (/^\d+$/.test(segment)) return ":n";
      if (segment.length > 32 || /[^A-Za-z0-9._$-]/.test(segment)) return ":value";
      if (/\d/.test(segment) && /[A-Za-z]/.test(segment) && segment.length > 12) return ":value";
      return segment;
    })
    .slice(0, 8)
    .join("/");
}

export interface RequestAnnotations {
  [key: string]: string | number | boolean | null;
}

const latency = new LatencyRecorder();

export function requestLatency(): ReturnType<LatencyRecorder["percentiles"]> {
  return latency.percentiles();
}

/**
 * First middleware: binds a validated correlation ID, times the request and writes one
 * `http_request` line. Successful fast requests are sampled; errors, 429s and slow requests
 * are always logged. Annotations added through `annotate` (cache, db route, rate limit) are
 * bounded values only.
 */
export function requestTelemetry(options: { sampleRate: number; slowMs?: number }): MiddlewareHandler<AppEnv> {
  const slowMs = options.slowMs ?? 1000;
  return async (c, next) => {
    const started = Date.now();
    const id = correlationIdFrom(c.req.header("x-correlation-id"));
    c.set("correlationId", id);
    c.set("annotations", {});
    let failed = false;
    try {
      await next();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const ms = Date.now() - started;
      latency.record(ms);
      const status = failed ? 500 : c.res.status;
      const sampled = status >= 500 || status === 429 || ms >= slowMs || Math.random() < options.sampleRate;
      if (sampled) {
        logEvent(status >= 500 ? "error" : "info", "http_request", {
          correlationId: id,
          method: c.req.method,
          route: routeShape(c.req.path),
          status,
          ms,
          ...(c.get("annotations") ?? {}),
        });
      }
    }
    c.header("x-correlation-id", id);
  };
}

export function annotate(c: { get(key: "annotations"): RequestAnnotations | undefined }, values: RequestAnnotations): void {
  const current = c.get("annotations");
  if (current) Object.assign(current, values);
}
