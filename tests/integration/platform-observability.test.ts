import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Session } from "./support.js";

const h = createHarness("platform-observability");

let operator: Session;

async function get(session: Session, path: string, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path), status);
}

beforeAll(async () => {
  operator = await h.login("reviewer@medveris.local");
});

describe("platform observability routes", () => {
  it("refuses unauthenticated access", async () => {
    const response = await h.app.fetch(new Request("http://localhost/api/v1/platform/observability/overview"));
    expect(response.status).toBe(401);
  });

  it("refuses a non-operator session", async () => {
    const staff = await h.login("clinician@medveris.local");
    const response = await h.call(staff, "/api/v1/platform/observability/overview");
    expect(response.status).toBe(403);
    const body = await h.json(response);
    expect(body.error.code).toBe("forbidden");
  });

  it("returns local counters and a structured unavailable Cloudflare envelope when unconfigured", async () => {
    const body = await get(operator, "/api/v1/platform/observability/overview?span=1h");
    expect(body.configured).toBe(false);
    expect(body.span).toBe("1h");
    expect(body.local).toMatchObject({ database: "reachable" });
    expect(body.cloudflare.scripts.ok).toBe(false);
    expect(body.cloudflare.scripts.source).toBe("unavailable");
    expect(body.cloudflare.scripts.error).toMatch(/not configured/i);
    expect(body.cloudflare.invocations.ok).toBe(false);
    // The API token must never appear in a response body; the "not configured" guidance names
    // configuration keys, which are not secret material, so assert on credential-bearing content.
    expect(JSON.stringify(body)).not.toContain("Bearer");
  });

  it("rejects an invalid span", async () => {
    const response = await h.call(operator, "/api/v1/platform/observability/overview?span=99h");
    expect(response.status).toBe(422);
    const body = await h.json(response);
    expect(body.error.code).toBe("validation_error");
  });

  it("serves api-metrics with local latency and an unavailable Cloudflare envelope", async () => {
    const body = await get(operator, "/api/v1/platform/observability/api-metrics?span=6h");
    expect(body.span).toBe("6h");
    expect(body.local.latency).toMatchObject({ count: expect.any(Number) });
    expect(body.cloudflare.ok).toBe(false);
    expect(body.cloudflare.source).toBe("unavailable");
  });

  it("serves workers with scripts and invocations envelopes", async () => {
    const body = await get(operator, "/api/v1/platform/observability/workers?span=1h");
    expect(body.configured).toBe(false);
    expect(body.scripts).toMatchObject({ ok: false, source: "unavailable" });
    expect(body.invocations).toMatchObject({ ok: false, source: "unavailable" });
  });

  it("serves logs with a privacy note and no raw log bodies", async () => {
    const body = await get(operator, "/api/v1/platform/observability/logs?span=1h");
    expect(body.note).toMatch(/privacy-safe|roll-ups/i);
    expect(body.cloudflare.ok).toBe(false);
    expect(body.cloudflare.data).toBeNull();
  });

  it("serves traces with a roll-ups-only note", async () => {
    const body = await get(operator, "/api/v1/platform/observability/traces?span=1h");
    expect(body.note).toMatch(/roll-ups/i);
    expect(body.cloudflare.ok).toBe(false);
  });

  it("serves jobs from the local outbox backlog", async () => {
    const body = await get(operator, "/api/v1/platform/observability/jobs");
    expect(body.source).toBe("app-local");
    expect(Array.isArray(body.outbox)).toBe(true);
    expect(body.relay).toMatchObject({ batchSize: expect.any(Number), perTenantBatchLimit: expect.any(Number) });
  });

  it("serves integrations from the local registry", async () => {
    const body = await get(operator, "/api/v1/platform/observability/integrations");
    expect(body.source).toBe("app-local");
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(body.integrations.length).toBeGreaterThan(0);
    const first = body.integrations[0];
    expect(first).toMatchObject({ id: expect.any(String), name: expect.any(String), state: expect.any(String) });
  });

  it("serves security counters without claiming to proxy Cloudflare WAF events", async () => {
    const body = await get(operator, "/api/v1/platform/observability/security");
    expect(body.source).toBe("app-local");
    expect(body.note).toMatch(/Cloudflare dashboard/i);
    expect(body.rateLimit).toMatchObject({ trustForwardedFor: expect.any(Boolean), distributed: expect.any(Boolean) });
    expect(Array.isArray(body.breakers)).toBe(true);
  });

  it("keeps every Cloudflare-backed envelope structured when unconfigured", async () => {
    for (const path of [
      "/api/v1/platform/observability/overview",
      "/api/v1/platform/observability/workers",
      "/api/v1/platform/observability/logs",
      "/api/v1/platform/observability/traces",
    ]) {
      const body = await get(operator, path);
      const envelopes = [body.cloudflare, body.cloudflare?.scripts, body.cloudflare?.invocations, body.scripts, body.invocations]
        .filter((value) => value && typeof value === "object" && "ok" in value);
      expect(envelopes.length).toBeGreaterThan(0);
      for (const envelope of envelopes) {
        expect(envelope).toMatchObject({
          ok: false,
          error: expect.any(String),
          source: "unavailable",
          fetchedAt: expect.any(String),
        });
      }
    }
  });
});
