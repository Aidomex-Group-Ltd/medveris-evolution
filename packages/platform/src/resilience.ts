/**
 * Timeouts, bounded retries, circuit breakers and bulkheads. State is per isolate (or per Node
 * process): a breaker protects this instance from hammering a failing dependency; it is not a
 * global switch. Retry only operations that are safe to repeat.
 */

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs} ms`);
  }
}

export class CircuitOpenError extends Error {
  override readonly name = "CircuitOpenError";
  constructor(readonly breaker: string, readonly retryAfterMs: number) {
    super(`${breaker} is temporarily unavailable`);
  }
}

export class BulkheadFullError extends Error {
  override readonly name = "BulkheadFullError";
  constructor(readonly bulkhead: string) {
    super(`${bulkhead} is at capacity`);
  }
}

/**
 * Runs `fn` with an AbortSignal that fires after `timeoutMs`. Operations that ignore the signal
 * (for example some bindings) are abandoned rather than cancelled; the caller still gets an error.
 */
export async function withTimeout<T>(label: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(label, timeoutMs));
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Full-jitter exponential backoff: a random delay in [0, min(maxMs, baseMs * 2^attempt)]. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export interface RetryOptions {
  /** Total attempts including the first; at most 5 so a caller cannot create unbounded retries. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryable: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const MAX_RETRY_ATTEMPTS = 5;

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.min(options.attempts, MAX_RETRY_ATTEMPTS));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !options.retryable(error)) throw error;
      const delay = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs, options.random);
      options.onRetry?.(attempt + 1, error, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial request is let through. */
  resetTimeoutMs: number;
  /** Errors that do not indicate dependency failure (validation, 4xx) should not trip the breaker. */
  isFailure?: (error: unknown) => boolean;
  now?: () => number;
}

export interface BreakerSnapshot {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
  totalRejected: number;
}

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private totals = { failures: 0, successes: 0, rejected: 0 };
  private readonly now: () => number;

  constructor(readonly name: string, private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  currentState(): BreakerState {
    if (this.state === "open" && this.openedAt !== null && this.now() - this.openedAt >= this.options.resetTimeoutMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  /** Milliseconds until a trial request is allowed, or 0 when calls may proceed. */
  retryAfterMs(): number {
    if (this.currentState() !== "open" || this.openedAt === null) return 0;
    return Math.max(0, this.options.resetTimeoutMs - (this.now() - this.openedAt));
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState();
    if (state === "open" || (state === "half-open" && this.trialInFlight)) {
      this.totals.rejected += 1;
      throw new CircuitOpenError(this.name, Math.max(this.retryAfterMs(), 1000));
    }
    const trial = state === "half-open";
    if (trial) this.trialInFlight = true;
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      if (this.options.isFailure?.(error) ?? true) this.recordFailure();
      else this.recordSuccess();
      throw error;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }

  recordSuccess(): void {
    this.totals.successes += 1;
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.openedAt = null;
  }

  recordFailure(): void {
    this.totals.failures += 1;
    this.consecutiveFailures += 1;
    if (this.state === "half-open" || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      name: this.name,
      state: this.currentState(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      totalFailures: this.totals.failures,
      totalSuccesses: this.totals.successes,
      totalRejected: this.totals.rejected,
    };
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** One breaker per dependency name per isolate, so health checks can report every dependency. */
export function breakerFor(name: string, options: CircuitBreakerOptions): CircuitBreaker {
  let breaker = breakers.get(name);
  if (!breaker) {
    breaker = new CircuitBreaker(name, options);
    breakers.set(name, breaker);
  }
  return breaker;
}

export function breakerSnapshots(): BreakerSnapshot[] {
  return [...breakers.values()].map((breaker) => breaker.snapshot());
}

/** Test hook: forget every breaker registered in this isolate. */
export function resetBreakers(): void {
  breakers.clear();
}

/** Limits concurrent executions of an expensive workload; excess callers wait in a bounded queue. */
export class Bulkhead {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly name: string, private readonly maxConcurrent: number, private readonly maxQueue: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxQueue) throw new BulkheadFullError(this.name);
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  inUse(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }
}
