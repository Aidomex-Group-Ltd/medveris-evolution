import { Hono, type Context } from "hono";
import { sha256Hex, randomToken } from "@medveris/auth";
import {
  facilityRegistrationSchema,
  interSiteReceiveSchema,
  interSiteTransferSchema,
  inventoryModeResponseSchema,
  organizationHistoryGrantSchema,
  organizationLinkEndSchema,
  organizationLinkRequestSchema,
  registrationStatusSchema,
  uuidSchema,
  workspaceModulesSchema,
  workspaceProfileSchema,
} from "@medveris/contracts";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import { describeLevel, recommendModules, rollUpLevel, type LevelStatus, type ResolvedLevel } from "@medveris/domain";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { parseJson } from "../lib/http.js";
import { assertLocationInScope } from "../lib/scope.js";
import { duplicateFindings, insertRegistration, levelFrom, recordLevelHistory, recordLinkEvent } from "../services/workspaces.js";
import { itemRow, locationRow, postMovement } from "./inventory.js";
import type { AppEnv } from "../types.js";

export const workspaceRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

function can(c: C, permission: Permission): boolean {
  return permissionsForRoles(requestActor(c).roles).has(permission);
}

function requirePermission(c: C, permission: Permission, message: string): void {
  if (!can(c, permission)) throw new ForbiddenError(message);
}

function levelOf(row: Record<string, unknown>): ResolvedLevel {
  return {
    levelStatus: row.levelStatus as LevelStatus,
    officialLevel: (row.officialLevel as ResolvedLevel["officialLevel"]) ?? null,
    officialLevelSource: (row.officialLevelSource as ResolvedLevel["officialLevelSource"]) ?? null,
    officialLevelReference: (row.officialLevelReference as string | null) ?? null,
    equivalentLevel: (row.equivalentLevel as ResolvedLevel["equivalentLevel"]) ?? null,
    equivalentJustification: (row.equivalentJustification as string | null) ?? null,
  };
}

async function liveLink(tx: Tx, tenantId: string) {
  const [link] = await tx`
    select l.*, o.name as organization_name, o.kind as organization_kind
      from organization_links l join organizations o on o.id = l.organization_id
     where l.tenant_id = ${tenantId} and l.status in ('pending','active')
  `;
  return link ?? null;
}

workspaceRoutes.get("/workspace", async (c) => {
  const auth = requireStaff(c);
  const tenantId = auth.activeTenant!.id;
  const data = await withStaffActor(c, async (tx) => {
    const [tenant] = await tx`
      select id, name, slug, workspace_kind, service_category, service_subtype, ownership, level_status, official_level,
             official_level_source, official_level_reference, equivalent_level, equivalent_justification, level_updated_at,
             city, district, region, address, country, host_tenant_id, enabled_modules, organization_id, created_at
        from tenants where id = ${tenantId}`;
    if (!tenant) throw new NotFoundError("Workspace not found");
    const registrations = await tx`
      select id, kind, issuer, identifier, valid_from, valid_until, status, verified_at, created_at
        from facility_registrations where tenant_id = ${tenantId} order by created_at`;
    const history = await tx`
      select h.level_status, h.official_level, h.official_level_source, h.official_level_reference, h.equivalent_level,
             h.equivalent_justification, h.reason, h.recorded_at, u.display_name as recorded_by_name
        from tenant_level_history h left join users u on u.id = h.recorded_by
       where h.tenant_id = ${tenantId} order by h.recorded_at desc limit 20`;
    const [host] = tenant.hostTenantId ? await tx`
      select name, level_status, official_level, official_level_source, official_level_reference, equivalent_level
        from tenants where id = ${tenant.hostTenantId}` : [];
    return { tenant, registrations, history, host: host ?? null, link: await liveLink(tx, tenantId) };
  });
  const level = levelOf(data.tenant);
  const category = String(data.tenant.serviceCategory ?? "clinic");
  return c.json({
    workspace: data.tenant,
    level: describeLevel(level),
    rollUpLevel: data.host ? { hostName: data.host.name, ...rollUpLevel(levelOf(data.host)) } : null,
    recommendations: recommendModules(category, level),
    registrations: data.registrations,
    levelHistory: data.history.map((row) => ({ ...row, display: describeLevel(levelOf(row)) })),
    organizationLink: data.link,
    permissions: { manage: can(c, "workspace.profile.manage"), link: can(c, "organization.link.manage") },
  });
});

workspaceRoutes.put("/workspace/profile", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "workspace.profile.manage", "Workspace administrator permission is required");
  const body = await parseJson(c, workspaceProfileSchema);
  const level = levelFrom(body);
  const tenantId = auth.activeTenant!.id;
  const config = c.get("deps").config;
  const result = await withStaffActor(c, async (tx) => {
    const [current] = await tx`
      select service_category, service_subtype, level_status, official_level, official_level_source, official_level_reference,
             equivalent_level, equivalent_justification
        from tenants where id = ${tenantId} for update`;
    if (!current) throw new NotFoundError("Workspace not found");
    const before = levelOf(current);
    const levelChanged = JSON.stringify(before) !== JSON.stringify(level) || current.serviceCategory !== body.serviceCategory
      || (current.serviceSubtype ?? null) !== (body.serviceSubtype ?? null);
    // An official designation is never replaced silently; the earlier value stays in the level history.
    if (before.levelStatus === "official" && level.levelStatus !== "official" && (body.reason?.trim().length ?? 0) < 10) {
      throw new ValidationError("Replacing an official level needs a reason of at least 10 characters");
    }
    await tx`
      update tenants set name = ${body.name}, service_category = ${body.serviceCategory}, service_subtype = ${body.serviceSubtype ?? null},
        ownership = ${body.ownership}, city = ${body.city || null}, district = ${body.district || null}, region = ${body.region || null},
        address = ${body.address || null}, level_status = ${level.levelStatus}, official_level = ${level.officialLevel},
        official_level_source = ${level.officialLevelSource}, official_level_reference = ${level.officialLevelReference},
        equivalent_level = ${level.equivalentLevel}, equivalent_justification = ${level.equivalentJustification},
        level_updated_by = ${levelChanged ? auth.user.id : null}, level_updated_at = ${levelChanged ? new Date() : null}, updated_at = now()
       where id = ${tenantId}`;
    if (levelChanged) {
      await recordLevelHistory(tx, tenantId, body.serviceCategory, body.serviceSubtype ?? null, level, auth.user.id, body.reason || null);
    }
    await writeAudit(tx, config, requestAudit(c, "workspace.profile.update", {
      resourceType: "Organization", resourceId: tenantId,
      metadata: { levelChanged, from: describeLevel(before).label, to: describeLevel(level).label, serviceCategory: body.serviceCategory },
    }));
    return { levelChanged };
  });
  return c.json({ ok: true, ...result, level: describeLevel(level) });
});

workspaceRoutes.put("/workspace/modules", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "workspace.profile.manage", "Workspace administrator permission is required");
  const body = await parseJson(c, workspaceModulesSchema);
  await withStaffActor(c, async (tx) => {
    await tx`update tenants set enabled_modules = ${body.modules}, updated_at = now() where id = ${auth.activeTenant!.id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workspace.modules.update", {
      resourceType: "Organization", resourceId: auth.activeTenant!.id, metadata: { modules: body.modules },
    }));
  });
  return c.json({ ok: true, modules: body.modules });
});

workspaceRoutes.post("/workspace/registrations", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "workspace.profile.manage", "Workspace administrator permission is required");
  const body = await parseJson(c, facilityRegistrationSchema);
  const id = await withStaffActor(c, async (tx) => {
    const recordId = await insertRegistration(tx, auth.activeTenant!.id, body, auth.user.id);
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workspace.registration.add", {
      resourceType: "FacilityRegistration", resourceId: recordId, metadata: { kind: body.kind },
    }));
    return recordId;
  });
  return c.json({ ok: true, id }, 201);
});

workspaceRoutes.post("/workspace/registrations/:id/status", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "workspace.profile.manage", "Workspace administrator permission is required");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, registrationStatusSchema);
  await withStaffActor(c, async (tx) => {
    const rows = await tx`
      update facility_registrations set status = ${body.status}, updated_at = now()
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} and status <> 'withdrawn' returning kind`;
    if (!rows[0]) throw new NotFoundError("Registration not found");
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "workspace.registration.status", {
      resourceType: "FacilityRegistration", resourceId: id, metadata: { status: body.status, kind: rows[0].kind },
    }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- organization link (workspace side)

workspaceRoutes.get("/workspace/organization", async (c) => {
  const auth = requireStaff(c);
  const data = await withStaffActor(c, async (tx) => {
    const link = await liveLink(tx, auth.activeTenant!.id);
    const history = await tx`
      select l.id, l.status, l.origin, l.requested_at, l.decided_at, l.ended_at, l.end_reason, o.name as organization_name
        from organization_links l join organizations o on o.id = l.organization_id
       where l.tenant_id = ${auth.activeTenant!.id} order by l.requested_at desc limit 20`;
    const events = link ? await tx`
      select e.event, e.detail, e.occurred_at, u.display_name as actor_name
        from organization_link_events e left join users u on u.id = e.actor_user_id
       where e.link_id = ${link.id} order by e.occurred_at desc limit 50` : [];
    return { link, history, events };
  });
  return c.json({ ...data, permissions: { manage: can(c, "organization.link.manage") } });
});

workspaceRoutes.post("/workspace/organization/link-request", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "organization.link.manage", "Only the workspace administrator can link it to an organization");
  const body = await parseJson(c, organizationLinkRequestSchema);
  const tenantId = auth.activeTenant!.id;
  const codeHash = await sha256Hex(`org-join:${body.joinCode}`);
  const result = await withStaffActor(c, async (tx) => {
    if (await liveLink(tx, tenantId)) throw new ConflictError("This workspace already has a pending or active organization link");
    await tx`select set_config('app.invitation_token_hash', ${codeHash}, true)`;
    const [code] = await tx`
      select c.id, c.organization_id, c.max_uses, c.uses, c.expires_at, c.revoked_at, o.name, o.status
        from organization_join_codes c join organizations o on o.id = c.organization_id
       where c.code_hash = ${codeHash} for update of c`;
    if (!code || code.revokedAt || (code.expiresAt as Date).getTime() <= Date.now() || Number(code.uses) >= Number(code.maxUses) || code.status !== "active") {
      throw new AppError(404, "join_code_invalid", "This organization join code is not valid, has expired or has been used");
    }
    await tx`update organization_join_codes set uses = uses + 1 where id = ${code.id}`;
    const findings = await duplicateFindings(tx, String(code.organizationId), tenantId);
    const full = body.historyVisibility === "full-history";
    const linkId = crypto.randomUUID();
    await tx`
      insert into organization_links (id, organization_id, tenant_id, status, origin, join_code_id, requested_by, duplicate_findings,
        history_visibility, history_granted_by, history_granted_at)
      values (${linkId}, ${code.organizationId}, ${tenantId}, 'pending', 'join-request', ${code.id}, ${auth.user.id},
        ${tx.json(findings as never)}, ${full ? "full-history" : "from-link-date"}, ${full ? auth.user.id : null}, ${full ? new Date() : null})
    `;
    await recordLinkEvent(tx, { linkId, organizationId: String(code.organizationId), tenantId, event: "requested", actorUserId: auth.user.id, detail: { duplicates: findings.length, historyVisibility: body.historyVisibility } });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "organization.link.request", {
      resourceType: "OrganizationLink", resourceId: linkId,
      metadata: { organizationId: code.organizationId, historyVisibility: body.historyVisibility, duplicates: findings.length },
    }));
    return { linkId, organizationName: String(code.name), duplicates: findings.length };
  });
  return c.json({ ok: true, link: { id: result.linkId, status: "pending", organizationName: result.organizationName }, possibleDuplicates: result.duplicates }, 201);
});

async function lockLiveLink(tx: Tx, tenantId: string, statuses: string[]) {
  const [link] = await tx`
    select * from organization_links where tenant_id = ${tenantId} and status = any(${statuses}) for update`;
  if (!link) throw new NotFoundError("No matching organization link for this workspace");
  return link;
}

workspaceRoutes.post("/workspace/organization/withdraw", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "organization.link.manage", "Only the workspace administrator can withdraw a link request");
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const link = await lockLiveLink(tx, tenantId, ["pending"]);
    await tx`update organization_links set status = 'withdrawn', updated_at = now() where id = ${link.id}`;
    await recordLinkEvent(tx, { linkId: String(link.id), organizationId: String(link.organizationId), tenantId, event: "withdrawn", actorUserId: auth.user.id });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "organization.link.withdraw", { resourceType: "OrganizationLink", resourceId: String(link.id) }));
  });
  return c.json({ ok: true });
});

/** The workspace administrator's explicit decision to include activity from before the link in roll-ups. */
workspaceRoutes.post("/workspace/organization/history", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "organization.link.manage", "Only the workspace administrator can share earlier history");
  const body = await parseJson(c, organizationHistoryGrantSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const link = await lockLiveLink(tx, tenantId, ["pending", "active"]);
    if (link.historyVisibility === "full-history") throw new ConflictError("Earlier history is already shared with this organization");
    await tx`
      update organization_links set history_visibility = 'full-history', visible_from = null, history_granted_by = ${auth.user.id},
        history_granted_at = now(), updated_at = now() where id = ${link.id}`;
    await recordLinkEvent(tx, { linkId: String(link.id), organizationId: String(link.organizationId), tenantId, event: "history-granted", actorUserId: auth.user.id, detail: { reason: body.reason } });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "organization.link.history-grant", {
      resourceType: "OrganizationLink", resourceId: String(link.id), metadata: { organizationId: link.organizationId },
    }));
  });
  return c.json({ ok: true });
});

workspaceRoutes.post("/workspace/organization/inventory-mode", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "organization.link.manage", "Only the workspace administrator can change inventory sharing");
  const body = await parseJson(c, inventoryModeResponseSchema);
  const tenantId = auth.activeTenant!.id;
  const mode = await withStaffActor(c, async (tx) => {
    const link = await lockLiveLink(tx, tenantId, ["active"]);
    if (!link.inventoryModeProposed) throw new ConflictError("The organization has not proposed an inventory change");
    const accepted = body.accept ? String(link.inventoryModeProposed) : String(link.inventoryMode);
    await tx`
      update organization_links set inventory_mode = ${accepted}, inventory_mode_proposed = null,
        inventory_mode_accepted_by = ${body.accept ? auth.user.id : link.inventoryModeAcceptedBy},
        inventory_mode_changed_at = ${body.accept ? new Date() : link.inventoryModeChangedAt}, updated_at = now()
       where id = ${link.id}`;
    await recordLinkEvent(tx, {
      linkId: String(link.id), organizationId: String(link.organizationId), tenantId,
      event: body.accept ? "inventory-mode-accepted" : "inventory-mode-declined", actorUserId: auth.user.id,
      detail: { proposed: link.inventoryModeProposed, note: body.note },
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "organization.link.inventory-mode", {
      resourceType: "OrganizationLink", resourceId: String(link.id), metadata: { proposed: link.inventoryModeProposed, accepted: body.accept },
    }));
    return accepted;
  });
  return c.json({ ok: true, inventoryMode: mode });
});

/** Leaving keeps every record with the workspace; the organization loses roll-up visibility from now on. */
workspaceRoutes.post("/workspace/organization/end", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "organization.link.manage", "Only the workspace administrator can leave an organization");
  const body = await parseJson(c, organizationLinkEndSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const link = await lockLiveLink(tx, tenantId, ["active"]);
    const open = await tx`
      select count(*)::int as n from organization_stock_transfers
       where (source_tenant_id = ${tenantId} or destination_tenant_id = ${tenantId}) and status = 'dispatched'`;
    if (Number(open[0]?.n ?? 0) > 0) throw new ConflictError("Receive or cancel in-transit inter-site transfers before leaving the organization");
    await tx`
      update organization_links set status = 'ended', ended_by = ${auth.user.id}, ended_at = now(), end_reason = ${body.reason},
        inventory_mode = 'independent', updated_at = now() where id = ${link.id}`;
    await tx`update tenants set organization_id = null, host_tenant_id = null, updated_at = now() where id = ${tenantId}`;
    await recordLinkEvent(tx, { linkId: String(link.id), organizationId: String(link.organizationId), tenantId, event: "ended", actorUserId: auth.user.id, detail: { reason: body.reason, by: "workspace" } });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "organization.link.end", {
      resourceType: "OrganizationLink", resourceId: String(link.id), metadata: { organizationId: link.organizationId, by: "workspace" },
    }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- inter-site supply

function transferNumber(): string {
  return `OTR-${new Date().getUTCFullYear()}-${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "X").slice(0, 8)}`;
}

workspaceRoutes.get("/workspace/shared-supply", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.stock.read", "Inventory access is required");
  const tenantId = auth.activeTenant!.id;
  const data = await withStaffActor(c, async (tx) => {
    const sites = await tx`select tenant_id, name, organization_id from app.shared_supply_sites(${tenantId})`;
    const transfers = await tx`
      select t.id, t.transfer_number, t.status, t.item_code, t.item_name, t.lot_number, t.expires_on, t.quantity, t.unit, t.base_quantity,
             t.received_quantity, t.discrepancy_note, t.reason, t.dispatched_at, t.received_at,
             t.source_tenant_id, t.destination_tenant_id, src.name as source_name, dst.name as destination_name,
             t.source_tenant_id = ${tenantId} as outgoing
        from organization_stock_transfers t
        join tenants src on src.id = t.source_tenant_id
        join tenants dst on dst.id = t.destination_tenant_id
       order by t.dispatched_at desc limit 200`;
    return { sites, transfers };
  });
  return c.json({ ...data, permissions: { transfer: can(c, "inventory.transfer.manage") } });
});

workspaceRoutes.post("/workspace/shared-supply/transfers", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.transfer.manage", "Inventory transfer permission is required");
  const body = await parseJson(c, interSiteTransferSchema);
  const tenantId = auth.activeTenant!.id;
  const config = c.get("deps").config;
  const result = await withStaffActor(c, async (tx) => {
    const [arrangement] = await tx`select app.shared_supply_organization(${tenantId}, ${body.destinationTenantId}) as organization_id`;
    if (!arrangement?.organizationId) {
      throw new ConflictError("Both sites must be active members of the same organization with shared supply accepted by each site");
    }
    await locationRow(tx, tenantId, body.sourceLocationId);
    await assertLocationInScope(tx, c, body.sourceLocationId);
    const item = await itemRow(tx, tenantId, body.itemId);
    let lot: { lotNumber: string | null; expiresOn: string | null } = { lotNumber: null, expiresOn: null };
    if (body.lotId) {
      const [row] = await tx`select lot_number, to_char(expires_on, 'YYYY-MM-DD') as expires_on from inventory_lots where id = ${body.lotId} and tenant_id = ${tenantId}`;
      if (!row) throw new NotFoundError("Inventory lot not found");
      lot = { lotNumber: String(row.lotNumber), expiresOn: (row.expiresOn as string | null) ?? null };
    }
    const number = transferNumber();
    const movement = await postMovement(tx, tenantId, auth.user.id, {
      itemId: body.itemId, lotId: body.lotId ?? null, sourceLocationId: body.sourceLocationId, quantity: body.quantity, unit: body.unit,
      movementType: "transfer-out", reason: body.reason, referenceType: "organization-transfer", referenceId: number,
    });
    const id = crypto.randomUUID();
    await tx`
      insert into organization_stock_transfers (id, organization_id, transfer_number, source_tenant_id, source_location_id, source_item_id,
        destination_tenant_id, item_code, item_name, lot_number, expires_on, quantity, unit, base_quantity, reason, dispatched_by, dispatch_movement_id)
      values (${id}, ${arrangement.organizationId}, ${number}, ${tenantId}, ${body.sourceLocationId}, ${body.itemId},
        ${body.destinationTenantId}, ${item.itemCode}, ${item.name}, ${lot.lotNumber}, ${lot.expiresOn}, ${body.quantity}, ${body.unit},
        ${Number(movement.baseQuantity)}, ${body.reason}, ${auth.user.id}, ${movement.id})
    `;
    await writeAudit(tx, config, requestAudit(c, "inventory.inter-site.dispatch", {
      resourceType: "OrganizationStockTransfer", resourceId: id,
      metadata: { transferNumber: number, destinationTenantId: body.destinationTenantId, itemId: body.itemId, quantity: body.quantity, unit: body.unit },
    }));
    await writeOutbox(tx, { tenantId, eventType: "inventory.inter-site.dispatched", aggregateId: id, payload: { destinationTenantId: body.destinationTenantId } });
    return { id, transferNumber: number };
  });
  return c.json({ ok: true, transfer: result }, 201);
});

workspaceRoutes.post("/workspace/shared-supply/transfers/:id/receive", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.stock.receive", "Stock receipt permission is required");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, interSiteReceiveSchema);
  const tenantId = auth.activeTenant!.id;
  const config = c.get("deps").config;
  await withStaffActor(c, async (tx) => {
    const transfer = await requireRows(await tx`
      select * from organization_stock_transfers where id = ${id} and destination_tenant_id = ${tenantId} for update`, "Transfer not found");
    if (transfer.status !== "dispatched") throw new ConflictError(`This transfer is ${transfer.status}`);
    await locationRow(tx, tenantId, body.destinationLocationId);
    await assertLocationInScope(tx, c, body.destinationLocationId);
    const item = await itemRow(tx, tenantId, body.destinationItemId);
    const expected = Number(transfer.baseQuantity);
    if (Math.abs(body.receivedQuantity - expected) > 0.00005 && (body.discrepancyNote?.trim().length ?? 0) < 5) {
      throw new ValidationError(`${expected} ${item.baseUnit} were dispatched; explain the difference to receive ${body.receivedQuantity}`);
    }
    let lotId: string | null = null;
    if (Boolean(item.lotTracked)) {
      if (!transfer.lotNumber) throw new ValidationError("The receiving item is lot tracked, but the dispatch has no lot number");
      const [existing] = await tx`select id, status from inventory_lots where tenant_id = ${tenantId} and item_id = ${item.id} and lot_number = ${transfer.lotNumber}`;
      if (existing?.status === "recalled") throw new ConflictError("This lot is under recall at the receiving site");
      lotId = existing ? String(existing.id) : crypto.randomUUID();
      if (!existing) {
        await tx`
          insert into inventory_lots (id, tenant_id, item_id, lot_number, expires_on, supplier, receipt_reference, status, created_by)
          values (${lotId}, ${tenantId}, ${item.id}, ${transfer.lotNumber}, ${transfer.expiresOn}, ${`Inter-site transfer ${transfer.transferNumber}`},
            ${transfer.transferNumber}, 'available', ${auth.user.id})`;
      }
    } else if (Boolean(item.expiryTracked) && !transfer.expiresOn) {
      throw new ValidationError("The receiving item is expiry tracked, but the dispatch has no expiry date");
    }
    const movement = await postMovement(tx, tenantId, auth.user.id, {
      itemId: String(item.id), lotId, destinationLocationId: body.destinationLocationId, quantity: body.receivedQuantity, unit: String(item.baseUnit),
      movementType: "transfer-in", reason: `Inter-site receipt ${transfer.transferNumber}`, referenceType: "organization-transfer", referenceId: String(transfer.transferNumber),
    });
    await tx`
      update organization_stock_transfers set status = 'received', destination_location_id = ${body.destinationLocationId},
        destination_item_id = ${item.id}, received_by = ${auth.user.id}, received_at = now(), received_quantity = ${body.receivedQuantity},
        receipt_movement_id = ${movement.id}, discrepancy_note = ${body.discrepancyNote || null}
       where id = ${id}`;
    await writeAudit(tx, config, requestAudit(c, "inventory.inter-site.receive", {
      resourceType: "OrganizationStockTransfer", resourceId: id,
      metadata: { transferNumber: transfer.transferNumber, receivedQuantity: body.receivedQuantity, dispatched: expected },
    }));
  });
  return c.json({ ok: true });
});

workspaceRoutes.post("/workspace/shared-supply/transfers/:id/cancel", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.transfer.manage", "Inventory transfer permission is required");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, organizationLinkEndSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const transfer = await requireRows(await tx`
      select * from organization_stock_transfers where id = ${id} and source_tenant_id = ${tenantId} for update`, "Transfer not found");
    if (transfer.status !== "dispatched") throw new ConflictError(`This transfer is ${transfer.status}`);
    const [lot] = transfer.lotNumber
      ? await tx`select id from inventory_lots where tenant_id = ${tenantId} and item_id = ${transfer.sourceItemId} and lot_number = ${transfer.lotNumber}`
      : [];
    const [item] = await tx`select base_unit from inventory_items where id = ${transfer.sourceItemId}`;
    await postMovement(tx, tenantId, auth.user.id, {
      itemId: String(transfer.sourceItemId), lotId: lot ? String(lot.id) : null, destinationLocationId: String(transfer.sourceLocationId),
      quantity: Number(transfer.baseQuantity), unit: String(item!.baseUnit), movementType: "return",
      reason: `Inter-site transfer ${transfer.transferNumber} cancelled: ${body.reason}`, referenceType: "organization-transfer", referenceId: String(transfer.transferNumber),
    });
    await tx`update organization_stock_transfers set status = 'cancelled', discrepancy_note = ${body.reason} where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.inter-site.cancel", {
      resourceType: "OrganizationStockTransfer", resourceId: id, metadata: { transferNumber: transfer.transferNumber },
    }));
  });
  return c.json({ ok: true });
});
