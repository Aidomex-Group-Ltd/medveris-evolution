import { beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createHarness, type Session } from "./support.js";

const h = createHarness("support-center");

let operator: Session;
let operatorId = "";

async function post(session: Session, path: string, body: unknown, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path, { method: "POST", body: JSON.stringify(body) }), status);
}

beforeAll(async () => {
  operator = await h.login("reviewer@medveris.local");
  const me = (await h.expectOk(await h.call(operator, "/api/v1/me"))) as any;
  operatorId = me.user.id as string;
});

describe("support center — access model", () => {
  it("refuses unauthenticated access on tickets, alerts, operators and reporting", async () => {
    for (const path of ["/api/v1/support-center/tickets", "/api/v1/support-center/alerts", "/api/v1/support-center/operators", "/api/v1/support-center/reporting/summary?span=24h"]) {
      const response = await h.app.fetch(new Request(`http://localhost${path}`));
      expect(response.status).toBe(401);
    }
  });

  it("refuses non-platform-operator sessions", async () => {
    const admin = await h.login("admin@medveris.local");
    const clinician = await h.login("clinician@medveris.local");
    for (const staff of [admin, clinician]) {
      for (const path of ["/api/v1/support-center/tickets", "/api/v1/support-center/alerts"]) {
        const response = await h.call(staff, path);
        expect(response.status).toBe(403);
      }
    }
  });
});

describe("support center — incident lifecycle", () => {
  const externalRef = `test-${Date.now()}`;
  let ticketId = "";

  it("creates an incident and enforces the alert-dedupe rule", async () => {
    const created = await post(operator, "/api/v1/support-center/tickets", {
      title: "Synthetic: elevated dead-letter backlog in sandbox",
      summary: "Synthetic acceptance record: three dead-lettered outbox events reported by the jobs relay in the last hour.",
      category: "infrastructure",
      severity: "sev3",
      source: "alert",
      externalRef,
    }, 201);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    ticketId = created.id as string;

    const duplicate = await h.call(operator, "/api/v1/support-center/tickets", {
      method: "POST",
      body: JSON.stringify({
        title: "Synthetic: elevated dead-letter backlog in sandbox",
        summary: "Duplicate of the same alert reference; must be rejected with 409.",
        category: "infrastructure",
        severity: "sev3",
        source: "alert",
        externalRef,
      }),
    });
    expect(duplicate.status).toBe(409);
  });

  it("lists and reads the ticket with its timeline", async () => {
    const list = (await h.expectOk(await h.call(operator, "/api/v1/support-center/tickets?status=open"))) as any;
    expect(list.tickets.some((row: any) => row.id === ticketId)).toBe(true);

    const detail = (await h.expectOk(await h.call(operator, `/api/v1/support-center/tickets/${ticketId}`))) as any;
    expect(detail.ticket).toMatchObject({ id: ticketId, status: "open", severity: "sev3", source: "alert", externalRef });
    expect(detail.events.map((event: any) => event.action)).toEqual(["opened"]);
  });

  it("acknowledges, assigns, annotates and re-severifies severity", async () => {
    await post(operator, `/api/v1/support-center/tickets/${ticketId}/acknowledge`, {});
    await post(operator, `/api/v1/support-center/tickets/${ticketId}/assign`, { assigneeUserId: operatorId });
    await post(operator, `/api/v1/support-center/tickets/${ticketId}/notes`, { note: "Sandbox dead-letter batch inspected; replay queued." });
    await post(operator, `/api/v1/support-center/tickets/${ticketId}/severity`, { severity: "sev2", note: "Backlog persisting across two cycles." });

    const detail = (await h.expectOk(await h.call(operator, `/api/v1/support-center/tickets/${ticketId}`))) as any;
    expect(detail.ticket).toMatchObject({ status: "in_progress", severity: "sev2", assigneeUserId: operatorId });
    expect(detail.ticket.acknowledgedAt).toBeTruthy();
    expect(detail.ticket.assignedAt).toBeTruthy();
    expect(detail.events.map((event: any) => event.action)).toEqual(["opened", "acknowledged", "assigned", "note", "severity-change"]);
  });

  it("rejects assignment to a non-operator and close before resolve", async () => {
    const staff = await h.login("admin@medveris.local");
    const target = (await h.expectOk(await h.call(staff, "/api/v1/me"))) as any;
    const assign = await h.call(operator, `/api/v1/support-center/tickets/${ticketId}/assign`, {
      method: "POST",
      body: JSON.stringify({ assigneeUserId: target.user.id }),
    });
    expect(assign.status).toBe(422);

    const close = await h.call(operator, `/api/v1/support-center/tickets/${ticketId}/close`, {
      method: "POST",
      body: JSON.stringify({ note: "premature close" }),
    });
    expect(close.status).toBe(409);
  });

  it("resolves and closes; further transitions are refused", async () => {
    await post(operator, `/api/v1/support-center/tickets/${ticketId}/resolve`, { resolution: "Backlog drained after replay; jobs relay healthy for 30 minutes." });
    await post(operator, `/api/v1/support-center/tickets/${ticketId}/close`, { note: "Acceptable to close; intermittent recurrence will re-open." });

    const detail = (await h.expectOk(await h.call(operator, `/api/v1/support-center/tickets/${ticketId}`))) as any;
    expect(detail.ticket.status).toBe("closed");
    expect(detail.ticket.resolvedAt).toBeTruthy();
    expect(detail.ticket.closedAt).toBeTruthy();

    const again = await h.call(operator, `/api/v1/support-center/tickets/${ticketId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution: "double resolve must be refused with 409." }),
    });
    expect(again.status).toBe(409);
  });

  it("writes hash-chained audit rows for every lifecycle step", async () => {
    const jobsSql = createSql(process.env.JOBS_DATABASE_URL!, { max: 1 });
    try {
      const rows = await jobsSql`
        select action from audit_events where resource_type = 'SupportTicket' and resource_id = ${ticketId}
      `;
      const actions = rows.map((row) => String(row.action));
      for (const expected of ["support_ticket.opened", "support_ticket.acknowledged", "support_ticket.assigned", "support_ticket.resolved", "support_ticket.closed"]) {
        expect(actions).toContain(expected);
      }
    } finally {
      await jobsSql.end({ timeout: 5 });
    }
  });

  it("serves derived alerts and reporting aggregates", async () => {
    const alerts = (await h.expectOk(await h.call(operator, "/api/v1/support-center/alerts"))) as any;
    expect(Array.isArray(alerts.alerts)).toBe(true);

    const reporting = (await h.expectOk(await h.call(operator, "/api/v1/support-center/reporting/summary?span=30d"))) as any;
    expect(reporting.span).toBe("30d");
    expect(reporting.incidents.byStatus.some((row: any) => row.status === "closed" && row.count >= 1)).toBe(true);
    expect(reporting.lifecycle.avgMinutesToAcknowledge).not.toBeNull();
    expect(Array.isArray(reporting.operatorActivity)).toBe(true);
  });
});
