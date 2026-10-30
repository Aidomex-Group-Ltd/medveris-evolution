import { Hono } from "hono";
import { uuidSchema } from "@medveris/contracts";
import { requireAuth, withActor } from "../auth/middleware.js";
import { writeAudit } from "../lib/audit.js";
import { requestAudit } from "../lib/actor.js";
import { NotFoundError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const notificationRoutes = new Hono<AppEnv>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * The caller's notification inbox. Row-level security restricts every query to
 * `recipient_user_id = app.current_user()`, so no tenant or role check is needed here.
 */
notificationRoutes.get("/notifications", async (c) => {
  requireAuth(c);
  const unread = c.req.query("unread") === "true";
  const requested = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requested) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested))) : DEFAULT_LIMIT;
  const notifications = await withActor(c, async (tx) => tx`
    select id, kind, title, body, resource_type, resource_id, created_at, read_at
      from notifications
     where ${unread ? tx`read_at is null` : tx`true`}
     order by created_at desc
     limit ${limit}
  `);
  return c.json({ notifications });
});

notificationRoutes.post("/notifications/:id/read", async (c) => {
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const notification = await withActor(c, async (tx) => {
    const rows = await tx`
      update notifications
         set read_at = coalesce(read_at, now()), read_by = coalesce(read_by, ${auth.user.id})
       where id = ${id}
       returning id, tenant_id, kind, title, read_at`;
    if (!rows[0]) throw new NotFoundError("Notification not found");
    await writeAudit(tx, c.get("deps").config, {
      ...requestAudit(c, "notification.read", { resourceType: "Notification", resourceId: id }),
      tenantId: rows[0].tenantId as string,
    });
    return rows[0];
  });
  return c.json({ notification });
});
