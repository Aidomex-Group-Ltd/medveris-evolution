import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod/v4";
import {
  supportTicketAssignSchema,
  supportTicketCloseSchema,
  supportTicketCreateSchema,
  supportTicketNoteSchema,
  supportTicketResolveSchema,
  supportTicketSeveritySchema,
  supportTicketStatus,
  uuidSchema,
} from "@medveris/contracts";
import { isPlatformOperator, withPlatformActor } from "../auth/middleware.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import type { Tx } from "@medveris/db";
import type { AppEnv, AuthContext } from "../types.js";

/**
 * Dedicated Observability Support Center backend (Phase 6).
 *
 * Platform-operator only: every route requires an active platform_operator grant; mutating
 * routes additionally require a verified MFA session. Every mutation is written to the
 * hash-chained audit trail. Incidents are operational records — no patient data, no tenant
 * attribution. Telemetry reuses the platform-observability API; this file owns Alerting
 * (derived signals), Ticketing (incident lifecycle) and Reporting (aggregate analytics).
 */
export const supportCenterRoutes = new Hono<AppEnv>();

function requireOperator(c: Context<AppEnv>, { mfa }: { mfa: boolean }): void {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  if (mfa && !c.get("auth")?.mfaVerified) {
    throw new ForbiddenError("A verified two-step session is required for this action");
  }
}

function mapTicket(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    source: row.source,
    externalRef: row.externalRef ?? null,
    category: row.category,
    severity: row.severity,
    status: row.status,
    title: row.title,
    summary: row.summary,
    resolution: row.resolution ?? null,
    assigneeUserId: row.assigneeUserId ?? null,
    openedBy: row.openedBy,
    openedAt: row.openedAt,
    acknowledgedAt: row.acknowledgedAt ?? null,
    assignedAt: row.assignedAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    closedAt: row.closedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Locks the ticket, enforces the transition, runs the change and audits it. */
async function transition(
  c: Context<AppEnv>,
  id: string,
  action: string,
  allowedFrom: ReadonlySet<string>,
  apply: (tx: Tx, auth: AuthContext) => Promise<Record<string, unknown> | void>,
): Promise<void> {
  requireOperator(c, { mfa: true });
  const deps = c.get("deps");
  const auth = c.get("auth")!;
  await withPlatformActor(c, async (tx) => {
    const rows = await tx`select id, status from support_tickets where id = ${id} for update`;
    const ticket = rows[0];
    if (!ticket) throw new NotFoundError("Support ticket not found");
    if (!allowedFrom.has(String(ticket.status))) {
      throw new ConflictError(`Ticket is ${String(ticket.status)}; this transition is not available`);
    }
    const metadata = (await apply(tx, auth)) ?? {};
    await writeAudit(tx, deps.config, {
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant?.roles ?? [],
      action: `support_ticket.${action}`,
      resourceType: "SupportTicket",
      resourceId: id,
      ...auditMeta(c),
      metadata: { from: ticket.status, ...metadata },
    });
  });
}

async function insertEvent(tx: Tx, ticketId: string, actorUserId: string, action: string, note?: string, metadata?: Record<string, unknown>): Promise<void> {
  await tx`
    insert into support_ticket_events (id, ticket_id, actor_user_id, action, note, metadata)
    values (${crypto.randomUUID()}, ${ticketId}, ${actorUserId}, ${action}, ${note ?? null}, ${tx.json((metadata ?? {}) as never)})
  `;
}

supportCenterRoutes.get("/support-center/tickets", async (c) => {
  requireOperator(c, { mfa: false });
  const status = c.req.query("status");
  const severity = c.req.query("severity");
  if (status !== undefined) supportTicketStatus.parse(status);
  if (severity !== undefined) z.enum(["sev1", "sev2", "sev3", "sev4"]).parse(severity);
  const rows = await withPlatformActor(c, (tx) => tx`
    select t.id, t.source, t.external_ref, t.category, t.severity, t.status, t.title, t.summary, t.resolution,
           t.assignee_user_id, t.opened_by, t.opened_at, t.acknowledged_at, t.assigned_at, t.resolved_at, t.closed_at,
           t.created_at, t.updated_at
      from support_tickets t
     where (${status ?? null}::text is null or t.status = ${status ?? null})
       and (${severity ?? null}::text is null or t.severity = ${severity ?? null})
     order by t.opened_at desc
     limit 100
  `);
  return c.json({ tickets: rows.map(mapTicket) });
});

supportCenterRoutes.get("/support-center/tickets/:id", async (c) => {
  requireOperator(c, { mfa: false });
  const id = uuidSchema.parse(c.req.param("id"));
  const rows = await withPlatformActor(c, (tx) => tx`
    select t.id, t.source, t.external_ref, t.category, t.severity, t.status, t.title, t.summary, t.resolution,
           t.assignee_user_id, t.opened_by, t.opened_at, t.acknowledged_at, t.assigned_at, t.resolved_at, t.closed_at,
           t.created_at, t.updated_at
      from support_tickets t
     where t.id = ${id}
  `);
  const ticket = rows[0];
  if (!ticket) throw new NotFoundError("Support ticket not found");
  const events = await withPlatformActor(c, (tx) => tx`
    select id, actor_user_id, action, note, metadata, created_at
      from support_ticket_events where ticket_id = ${id} order by created_at asc limit 200
  `);
  return c.json({
    ticket: mapTicket(ticket),
    events: events.map((event) => ({
      id: String(event.id),
      actorUserId: event.actorUserId ?? null,
      action: event.action,
      note: event.note ?? null,
      metadata: event.metadata ?? {},
      createdAt: event.createdAt,
    })),
  });
});

supportCenterRoutes.post("/support-center/tickets", async (c) => {
  requireOperator(c, { mfa: true });
  const deps = c.get("deps");
  const auth = c.get("auth")!;
  const body = await parseJson(c, supportTicketCreateSchema);
  if (body.externalRef) {
    const existing = await withPlatformActor(c, (tx) => tx`
      select id from support_tickets where external_ref = ${body.externalRef} and status in ('open', 'in_progress') limit 1
    `);
    if (existing.length) throw new ConflictError("An open ticket already exists for this reference");
  }
  const id = crypto.randomUUID();
  await withPlatformActor(c, async (tx) => {
    await tx`
      insert into support_tickets (id, source, external_ref, category, severity, status, title, summary, opened_by)
      values (${id}, ${body.source}, ${body.externalRef ?? null}, ${body.category}, ${body.severity}, 'open', ${body.title}, ${body.summary}, ${auth.user.id})
    `;
    await insertEvent(tx, id, auth.user.id, "opened", undefined, { source: body.source, severity: body.severity, category: body.category });
    await writeAudit(tx, deps.config, {
      actorKind: "staff",
      actorUserId: auth.user.id,
      actorRoles: auth.activeTenant?.roles ?? [],
      action: "support_ticket.opened",
      resourceType: "SupportTicket",
      resourceId: id,
      ...auditMeta(c),
      metadata: { source: body.source, severity: body.severity, category: body.category, externalRef: body.externalRef ?? null },
    });
  });
  return c.json({ ok: true, id }, 201);
});

supportCenterRoutes.post("/support-center/tickets/:id/acknowledge", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  await transition(c, id, "acknowledged", new Set(["open"]), async (tx, auth) => {
    await tx`
      update support_tickets
         set status = 'in_progress', acknowledged_at = coalesce(acknowledged_at, now()), updated_at = now()
       where id = ${id}
    `;
    await insertEvent(tx, id, auth.user.id, "acknowledged");
    return { status: "in_progress" };
  });
  return c.json({ ok: true });
});

supportCenterRoutes.post("/support-center/tickets/:id/assign", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supportTicketAssignSchema);
  await transition(c, id, "assigned", new Set(["open", "in_progress"]), async (tx, auth) => {
    const operator = await tx`
      select user_id from platform_roles
       where user_id = ${body.assigneeUserId} and role = 'platform_operator' and revoked_at is null
         and (expires_at is null or expires_at > now())
    `;
    if (!operator.length) throw new ValidationError("Assignee is not an active platform operator");
    await tx`
      update support_tickets
         set assignee_user_id = ${body.assigneeUserId}, assigned_at = now(), status = 'in_progress',
             acknowledged_at = coalesce(acknowledged_at, now()), updated_at = now()
       where id = ${id}
    `;
    await insertEvent(tx, id, auth.user.id, "assigned", undefined, { assigneeUserId: body.assigneeUserId });
    return { status: "in_progress", assigneeUserId: body.assigneeUserId };
  });
  return c.json({ ok: true });
});

supportCenterRoutes.post("/support-center/tickets/:id/notes", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supportTicketNoteSchema);
  await transition(c, id, "note", new Set(["open", "in_progress", "resolved"]), async (tx, auth) => {
    await insertEvent(tx, id, auth.user.id, "note", body.note);
    return {};
  });
  return c.json({ ok: true });
});

supportCenterRoutes.post("/support-center/tickets/:id/severity", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supportTicketSeveritySchema);
  await transition(c, id, "severity-changed", new Set(["open", "in_progress", "resolved"]), async (tx, auth) => {
    await tx`update support_tickets set severity = ${body.severity}, updated_at = now() where id = ${id}`;
    await insertEvent(tx, id, auth.user.id, "severity-change", body.note, { severity: body.severity });
    return { severity: body.severity };
  });
  return c.json({ ok: true });
});

supportCenterRoutes.post("/support-center/tickets/:id/resolve", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supportTicketResolveSchema);
  await transition(c, id, "resolved", new Set(["open", "in_progress"]), async (tx, auth) => {
    await tx`
      update support_tickets
         set status = 'resolved', resolution = ${body.resolution}, resolved_at = now(), updated_at = now()
       where id = ${id}
    `;
    await insertEvent(tx, id, auth.user.id, "resolved", body.resolution);
    return { status: "resolved" };
  });
  return c.json({ ok: true });
});

supportCenterRoutes.post("/support-center/tickets/:id/close", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supportTicketCloseSchema);
  await transition(c, id, "closed", new Set(["resolved"]), async (tx, auth) => {
    await tx`
      update support_tickets set status = 'closed', closed_at = now(), updated_at = now() where id = ${id}
    `;
    await insertEvent(tx, id, auth.user.id, "closed", body.note);
    return { status: "closed" };
  });
  return c.json({ ok: true });
});

/**
 * Derived alert feed: high-severity open tickets and dead-lettered outbox events, without a
 * second alerting store. Each alert carries a stable externalRef for idempotent ticketing.
 */
supportCenterRoutes.get("/support-center/alerts", async (c) => {
  requireOperator(c, { mfa: false });
  const tickets = await withPlatformActor(c, (tx) => tx`
    select id, severity, title, opened_at from support_tickets
     where status in ('open', 'in_progress') and severity in ('sev1', 'sev2')
     order by opened_at asc limit 20
  `);
  const deadLetters = await withPlatformActor(c, (tx) => tx`
    select count(*)::int as count from outbox_events where status = 'dead-letter'
  `);
  const deadLetterCount = Number(deadLetters[0]?.count ?? 0);
  const alerts = [
    ...tickets.map((ticket) => ({
      id: `ticket:${String(ticket.id)}`,
      kind: "open-high-severity-ticket",
      severity: String(ticket.severity),
      title: String(ticket.title),
      externalRef: `ticket:${String(ticket.id)}`,
      since: ticket.opened_at,
    })),
    ...(deadLetterCount > 0
      ? [{
          id: "outbox-dead-letter",
          kind: "outbox-dead-letter",
          severity: deadLetterCount >= 5 ? "sev2" : "sev3",
          title: `${deadLetterCount} dead-lettered job event(s) awaiting operator replay`,
          externalRef: "outbox-dead-letter",
          since: null as unknown,
        }]
      : []),
  ];
  return c.json({ alerts });
});

supportCenterRoutes.get("/support-center/operators", async (c) => {
  requireOperator(c, { mfa: false });
  const rows = await withPlatformActor(c, (tx) => tx`
    select user_id, granted_at, expires_at from platform_roles
     where role = 'platform_operator' and revoked_at is null
       and (expires_at is null or expires_at > now())
     order by granted_at desc nulls last
  `);
  return c.json({
    operators: rows.map((row) => ({
      userId: String(row.user_id),
      grantedAt: row.granted_at ?? null,
      expiresAt: row.expires_at ?? null,
    })),
  });
});

/** Reporting: incident lifecycle + operator activity, counts only, over a trailing span. */
supportCenterRoutes.get("/support-center/reporting/summary", async (c) => {
  requireOperator(c, { mfa: false });
  const raw = c.req.query("span");
  if (raw !== undefined && raw !== "24h" && raw !== "7d" && raw !== "30d") {
    throw new ValidationError("span must be one of 24h, 7d, 30d");
  }
  const days = raw === "24h" ? 1 : raw === "7d" ? 7 : 30;
  const [byStatus, bySeverity, byCategory, lifecycle, operatorActivity] = await Promise.all([
    withPlatformActor(c, (tx) => tx`
      select status, count(*)::int as count from support_tickets
       where opened_at >= now() - make_interval(days => ${days}) group by status
    `),
    withPlatformActor(c, (tx) => tx`
      select severity, count(*)::int as count from support_tickets
       where opened_at >= now() - make_interval(days => ${days}) group by severity
    `),
    withPlatformActor(c, (tx) => tx`
      select category, count(*)::int as count from support_tickets
       where opened_at >= now() - make_interval(days => ${days}) group by category
    `),
    withPlatformActor(c, (tx) => tx`
      select avg(extract(epoch from acknowledged_at - opened_at) / 60)::float as avg_minutes_to_ack,
             avg(extract(epoch from closed_at - opened_at) / 60)::float as avg_minutes_to_close
        from support_tickets
       where opened_at >= now() - make_interval(days => ${days}) and acknowledged_at is not null
    `),
    withPlatformActor(c, (tx) => tx`
      select actor_user_id, count(*)::int as events
        from support_ticket_events
       where created_at >= now() - make_interval(days => ${days}) and actor_user_id is not null
       group by actor_user_id order by events desc limit 10
    `),
  ]);
  return c.json({
    span: raw ?? "30d",
    generatedAt: new Date().toISOString(),
    incidents: { byStatus, bySeverity, byCategory },
    lifecycle: {
      avgMinutesToAcknowledge: lifecycle[0]?.avgMinutesToAck ?? null,
      avgMinutesToClose: lifecycle[0]?.avgMinutesToClose ?? null,
    },
    operatorActivity: operatorActivity.map((row) => ({ actorUserId: String(row.actorUserId), events: Number(row.events) })),
  });
});
