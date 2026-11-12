import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Session } from "./support.js";

const h = createHarness("security-events");

let operator: Session;

beforeAll(async () => {
  operator = await h.login("reviewer@medveris.local");
});

describe("platform observability — security events", () => {
  it("refuses unauthenticated access", async () => {
    const response = await h.app.fetch(new Request("http://localhost/api/v1/platform/observability/security-events"));
    expect(response.status).toBe(401);
  });

  it("refuses a non-operator session", async () => {
    const staff = await h.login("clinician@medveris.local");
    const response = await h.call(staff, "/api/v1/platform/observability/security-events?span=1h");
    expect(response.status).toBe(403);
  });

  it("rejects an invalid span", async () => {
    const response = await h.call(operator, "/api/v1/platform/observability/security-events?span=99h");
    expect(response.status).toBe(422);
  });

  it("returns counts-only rollups with no identifiers", async () => {
    const body = (await h.expectOk(await h.call(operator, "/api/v1/platform/observability/security-events?span=24h"))) as any;
    expect(body.source).toBe("app-local");
    expect(body.span).toBe("24h");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.totals).toMatchObject({ events: expect.any(Number), denied: expect.any(Number) });
    const recomputed = body.events.reduce((sum: number, row: any) => sum + row.events, 0);
    expect(recomputed).toBe(body.totals.events);
    const serialized = JSON.stringify(body);
    for (const forbidden of ["tenantId", "patientId", "actorUserId", "subjectPatientId", "email", "address"]) {
      expect(serialized).not.toContain(`"${forbidden}":`);
    }
    for (const row of body.events) {
      expect(row).toEqual({
        action: expect.any(String),
        decision: row.decision === null ? null : expect.any(String),
        reasonCode: row.reasonCode === null ? null : expect.any(String),
        events: expect.any(Number),
      });
    }
  });

  it("returns zero rows when the platform_operator GUC is not set", async () => {
    const rows = await h.sql`select * from app.security_event_summary(60)`;
    expect(rows).toHaveLength(0);
  });
});
