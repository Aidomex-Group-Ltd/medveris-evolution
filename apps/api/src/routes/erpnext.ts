import { Hono } from "hono";
import { z } from "zod";
import {
  assertWorkforceAccess,
} from "@medveris/authz";
import { uuidSchema } from "@medveris/contracts";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { ErpnextAdapter } from "../integrations/erpnext.js";
import type { AppEnv } from "../types.js";

export const erpnextRoutes = new Hono<AppEnv>();

const adapterCache = new Map<string, ErpnextAdapter>();

function adapterFor(c: Parameters<typeof requireStaff>[0]): ErpnextAdapter {
  const config = c.get("deps").config.erpnext;
  const key = JSON.stringify([config.baseUrl, config.apiKey, config.apiSecret]);
  let adapter = adapterCache.get(key);
  if (!adapter) {
    adapter = new ErpnextAdapter(config);
    adapterCache.set(key, adapter);
  }
  return adapter;
}

const linkCreateSchema = z.object({
  staffPersonId: uuidSchema,
  company: z.string().trim().min(1).max(200).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
});

erpnextRoutes.get("/erpnext/status", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const adapter = adapterFor(c);
  if (adapter.mode !== "off") await adapter.verifyConnection();
  const status = adapter.status;
  return c.json({
    mode: status.mode,
    configured: status.configured,
    connected: status.connected,
    providerHost: status.providerHost,
    providerVersion: status.providerVersion,
    lastVerifiedAt: status.lastVerifiedAt,
    note: "ERPNext is configured strictly server-side. No ERPNext credential is returned by this endpoint, or stored in the Medveris database.",
  });
});

erpnextRoutes.get("/erpnext/links", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, (tx) => tx`
    select l.id, l.staff_person_id as "staffPersonId", s.staff_ref as "staffRef",
           s.given_name as "givenName", s.family_name as "familyName",
           l.erpnext_employee_id as "erpnextEmployeeId", l.erpnext_company as "erpnextCompany",
           l.sync_status as "syncStatus", l.linked_at as "linkedAt", l.created_at as "createdAt"
    from staff_erpnext_link l join staff_persons s on s.id = l.staff_person_id
    where l.tenant_id = ${auth.activeTenant!.id}
    order by l.created_at desc
  `);
  return c.json({ links: rows });
});

erpnextRoutes.post("/erpnext/links", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, linkCreateSchema);
  const id = crypto.randomUUID();
  const link = await withStaffActor(c, async (tx) => {
    const staff = await tx`select id from staff_persons where id = ${body.staffPersonId}`;
    if (!staff[0]) throw new NotFoundError("Staff person not found");
    const engagement = await tx`select 1 from engagements where staff_person_id = ${body.staffPersonId} and tenant_id = ${auth.activeTenant!.id} and status <> 'withdrawn' limit 1`;
    if (!engagement[0]) throw new ValidationError("Staff person has no active engagement in this facility");
    const existing = await tx`select id from staff_erpnext_link where tenant_id = ${auth.activeTenant!.id} and staff_person_id = ${body.staffPersonId} limit 1`;
    const result = existing[0]
      ? await tx`
          update staff_erpnext_link set erpnext_company = coalesce(${body.company ?? null}, erpnext_company),
            sync_status = case when sync_status = 'revoked' then 'pending' else sync_status end,
            sync_error = null, updated_at = now()
          where id = ${existing[0].id}
          returning id, sync_status as "syncStatus"
        `
      : await tx`
          insert into staff_erpnext_link (id, tenant_id, staff_person_id, erpnext_company, sync_status, created_by)
          values (${id}, ${auth.activeTenant!.id}, ${body.staffPersonId}, ${body.company ?? null}, 'pending', ${auth.user.id})
          returning id, sync_status as "syncStatus"
        `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "erpnext.link.create", {
      resourceType: "StaffErpnextLink", resourceId: result[0]!.id,
      metadata: { staffPersonId: body.staffPersonId, company: body.company ?? null, branch: body.branch ?? null },
    }));
    await writeOutbox(tx, {
      tenantId: auth.activeTenant!.id, eventType: "erpnext.link.upsert", aggregateId: result[0]!.id,
      payload: { staffPersonId: body.staffPersonId, company: body.company ?? null },
    });
    return result[0]!;
  });
  return c.json({ ok: true, link: { id: link.id, syncStatus: link.syncStatus }, note: "Mapping stored locally. External employee upsert in ERPNext runs only after explicit administrative approval (not enabled in this environment)." }, 201);
});

erpnextRoutes.patch("/erpnext/links/:id/revoke", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const revoked = await withStaffActor(c, async (tx) => {
    const existing = await tx`select id from staff_erpnext_link where id = ${id} and tenant_id = ${auth.activeTenant!.id}`;
    if (!existing[0]) throw new NotFoundError("ERPNext link not found");
    const rows = await tx`
      update staff_erpnext_link set sync_status = 'revoked', updated_at = now()
      where id = ${id} and tenant_id = ${auth.activeTenant!.id}
      returning id
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "erpnext.link.revoke", {
      resourceType: "StaffErpnextLink", resourceId: id, metadata: {},
    }));
    return rows[0];
  });
  return c.json({ ok: true, id: revoked?.id });
});

erpnextRoutes.post("/erpnext/connection", async (c) => {
  requireStaff(c);
  assertWorkforceAccess(requestActor(c));
  const auth = c.get("auth")!;
  const body = await parseJson(c, z.object({
    enabled: z.boolean(),
    company: z.string().trim().min(1).max(200).optional(),
    branch: z.string().trim().max(200).optional(),
  }));
  const connectionId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into integration_erpnext_connection (id, tenant_id, enabled, company_name, branch_name)
      values (${connectionId}, ${auth.activeTenant!.id}, ${body.enabled}, ${body.company ?? null}, ${body.branch ?? null})
      on conflict (tenant_id) do update set enabled = excluded.enabled, company_name = excluded.company_name,
        branch_name = excluded.branch_name, updated_at = now()
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "erpnext.connection.update", {
      resourceType: "IntegrationErpnextConnection", resourceId: connectionId,
      metadata: { enabled: body.enabled, company: body.company ?? null },
    }));
  });
  return c.json({ ok: true });
});
