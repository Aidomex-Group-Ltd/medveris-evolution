/**
 * Privacy-safe structured telemetry. Every log line is one JSON object on stdout/stderr, which
 * Workers Logs indexes. Fields pass through `safeFields`, which keeps only primitive values,
 * drops keys that name credentials or personal/clinical content, and truncates strings.
 */

export type FieldValue = string | number | boolean | null;
export type Fields = Record<string, unknown>;

const FORBIDDEN_FIELD = /(password|passcode|secret|token|authorization|cookie|credential|api[-_]?key|payload|body|email|phone|address|narrative|clinical|diagnos|given[-_]?name|family[-_]?name|display[-_]?name|birth|mrn|totp|otp|ticket)/i;
const MAX_STRING = 300;
const MAX_FIELDS = 40;

export function safeFields(fields: Fields): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (count >= MAX_FIELDS) break;
    if (FORBIDDEN_FIELD.test(key)) continue;
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === "string") {
      out[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    } else if (typeof value === "number") {
      out[key] = Number.isFinite(value) ? value : null;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      continue;
    }
    count += 1;
  }
  return out;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogSink {
  (level: LogLevel, line: string): void;
}

const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

let sink: LogSink = consoleSink;

/** Test hook: capture log lines instead of writing them to the console. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink;
}

export function logEvent(level: LogLevel, event: string, fields: Fields = {}): void {
  sink(level, JSON.stringify({ event, level, ...safeFields(fields) }));
}

/**
 * Counters are emitted as `metric` log lines so Workers Logs queries can aggregate them.
 * Use bounded tag values (route ids, outcomes), never identifiers of people.
 */
export function metric(name: string, value = 1, tags: Fields = {}): void {
  sink("info", JSON.stringify({ event: "metric", metric: name, value, ...safeFields(tags) }));
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/** Accepts a caller-supplied correlation ID only when it cannot inject log structure. */
export function correlationIdFrom(raw: string | null | undefined): string {
  return raw && CORRELATION_ID.test(raw) ? raw : crypto.randomUUID();
}

/** Errors are summarised by class and code; messages are truncated and may be omitted. */
export function errorFields(error: unknown, includeMessage = true): Fields {
  if (!(error instanceof Error)) return { errorClass: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    errorClass: error.name,
    errorCode: typeof code === "string" || typeof code === "number" ? String(code) : null,
    ...(includeMessage ? { message: error.message } : {}),
  };
}

/** Latency samples for one isolate; percentiles are approximate and reset by `drain`. */
export class LatencyRecorder {
  private samples: number[] = [];
  constructor(private readonly capacity = 2048) {}

  record(ms: number): void {
    if (this.samples.length >= this.capacity) this.samples.shift();
    this.samples.push(ms);
  }

  percentiles(): { count: number; p50: number | null; p95: number | null; p99: number | null } {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null);
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  }
}
