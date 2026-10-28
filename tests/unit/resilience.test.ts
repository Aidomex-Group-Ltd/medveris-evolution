import { afterEach, describe, expect, it } from "vitest";
import {
  backoffDelay,
  breakerFor,
  breakerSnapshots,
  Bulkhead,
  BulkheadFullError,
  CircuitBreaker,
  CircuitOpenError,
  correlationIdFrom,
  resetBreakers,
  retry,
  safeFields,
  setLogSink,
  TimeoutError,
  withTimeout,
} from "@medveris/platform";
import { routeShape } from "../../apps/api/src/lib/observability.js";
import { isDatabaseUnavailable } from "../../apps/api/src/lib/db-health.js";

afterEach(() => {
  resetBreakers();
  setLogSink(() => undefined);
});

describe("timeouts and retries", () => {
  it("times out and aborts the signal", async () => {
    let aborted = false;
    await expect(withTimeout("slow", 20, (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; });
      setTimeout(resolve, 500);
    }))).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  it("uses full-jitter backoff bounded by the cap", () => {
    expect(backoffDelay(0, 100, 1000, () => 0.999)).toBeLessThan(100);
    expect(backoffDelay(10, 100, 1000, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(0);
  });

  it("retries only retryable errors and never more than five attempts", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(retry(async () => {
      calls += 1;
      throw new Error("transient");
    }, { attempts: 50, baseDelayMs: 10, maxDelayMs: 100, retryable: () => true, sleep: async (ms) => { sleeps.push(ms); } })).rejects.toThrow("transient");
    expect(calls).toBe(5);
    expect(sleeps).toHaveLength(4);

    calls = 0;
    await expect(retry(async () => {
      calls += 1;
      throw new Error("validation");
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, retryable: () => false, sleep: async () => undefined })).rejects.toThrow("validation");
    expect(calls).toBe(1);
  });
});

describe("circuit breaker", () => {
  it("opens after consecutive failures, rejects fast, then lets one trial through", async () => {
    let now = 0;
    const breaker = new CircuitBreaker("dep", { failureThreshold: 3, resetTimeoutMs: 1000, now: () => now });
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(breaker.currentState()).toBe("open");
    let called = false;
    await expect(breaker.execute(async () => { called = true; })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);

    now = 1500;
    expect(breaker.currentState()).toBe("half-open");
    let release!: () => void;
    const trial = breaker.execute(() => new Promise<void>((resolve) => { release = resolve; }));
    await expect(breaker.execute(async () => undefined)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await trial;
    expect(breaker.currentState()).toBe("closed");
  });

  it("does not count errors the caller marks as non-failures", async () => {
    const breaker = new CircuitBreaker("dep", { failureThreshold: 1, resetTimeoutMs: 1000, isFailure: (error) => (error as Error).message !== "client" });
    await expect(breaker.execute(async () => { throw new Error("client"); })).rejects.toThrow("client");
    expect(breaker.currentState()).toBe("closed");
  });

  it("registers one breaker per dependency for health reporting", () => {
    breakerFor("email", { failureThreshold: 1, resetTimeoutMs: 1 });
    breakerFor("email", { failureThreshold: 9, resetTimeoutMs: 9 });
    expect(breakerSnapshots().map((snapshot) => snapshot.name)).toEqual(["email"]);
  });
});

describe("bulkhead", () => {
  it("bounds concurrency and queue length", async () => {
    const bulkhead = new Bulkhead("reports", 2, 1);
    const releases: Array<() => void> = [];
    const task = () => bulkhead.run(() => new Promise<void>((resolve) => releases.push(resolve)));
    const running = [task(), task(), task()];
    await expect(task()).rejects.toBeInstanceOf(BulkheadFullError);
    expect(bulkhead.inUse()).toEqual({ active: 2, queued: 1 });
    while (releases.length) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(running);
    expect(bulkhead.inUse()).toEqual({ active: 0, queued: 0 });
  });
});

describe("privacy-safe telemetry", () => {
  it("drops credential, contact and clinical fields and non-primitive values", () => {
    const fields = safeFields({
      route: "/api/v1/patients/:id", status: 200, password: "x", sessionToken: "x", authorization: "x", cookie: "x",
      email: "a@b", payload: { mrn: "1" }, clinicalNote: "x", givenName: "x", ipAddress: "203.0.113.1", ticket: "t", ms: 12,
    });
    expect(fields).toEqual({ route: "/api/v1/patients/:id", status: 200, ms: 12 });
  });

  it("accepts only bounded correlation IDs, so a header cannot inject log structure", () => {
    expect(correlationIdFrom("abc-123_def.456")).toBe("abc-123_def.456");
    const generated = correlationIdFrom('x","event":"forged');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom("short")).not.toBe("short");
  });

  it("logs route shapes without identifiers", () => {
    expect(routeShape("/api/v1/patients/0e3daf50-7a54-4107-9e7b-44794cf475b7/encounters/42")).toBe("/api/v1/patients/:id/encounters/:n");
    expect(routeShape("/api/v1/auth/invitations/status")).toBe("/api/v1/auth/invitations/status");
    expect(routeShape("/api/v1/public/directory/facilities/pub_9f8e7d6c5b4a3210")).toBe("/api/v1/public/directory/facilities/:value");
    expect(routeShape("/assets/index-abc.js")).toBe("static");
  });

  it("classifies connection loss and failover answers as database unavailability", () => {
    expect(isDatabaseUnavailable({ code: "ECONNREFUSED" })).toBe(true);
    expect(isDatabaseUnavailable({ code: "CONNECT_TIMEOUT" })).toBe(true);
    expect(isDatabaseUnavailable({ code: "57P01" })).toBe(true);
    expect(isDatabaseUnavailable({ code: "25006" })).toBe(true);
    expect(isDatabaseUnavailable({ code: "23505" })).toBe(false);
    expect(isDatabaseUnavailable(new Error("plain"))).toBe(false);
  });
});
