import { Hono } from "hono";
import type { Context } from "hono";
import {
  inventoryAdjustmentDecisionSchema,
  inventoryAdjustmentSchema,
  inventoryAssetEventSchema,
  inventoryAssetSchema,
  inventoryCountDecisionSchema,
  inventoryCountSchema,
  inventoryIssueSchema,
  inventoryItemSchema,
  inventoryItemUpdateSchema,
  inventoryLocationSchema,
  inventoryPolicySchema,
  inventoryRecallSchema,
  inventoryReceiptSchema,
  inventoryRequisitionDecisionSchema,
  inventoryRequisitionIssueSchema,
  inventoryRequisitionSchema,
  inventoryTransferDispatchSchema,
  inventoryTransferReceiveSchema,
  inventoryTransferSchema,
  stockReservationSchema,
  uuidSchema,
} from "@medveris/contracts";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson, requireIdempotency } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const inventoryRoutes = new Hono<AppEnv>();

type Tx = Parameters<Parameters<typeof withStaffActor>[1]>[0];
type HandlerContext = Parameters<typeof requireStaff>[0];

const ORG_SCOPE_ROLES = ["facility_admin", "auditor", "finance", "quality", "it_admin"];
const APPROVER_ROLES = ["facility_admin", "pharmacist", "biomedical"];
const CENTRAL_MANAGER_ROLES = ["facility_admin", "pharmacist"];
const TECHNICAL_ROLES = ["facility_admin", "biomedical"];

function requirePermission(c: HandlerContext, ...permissions: Permission[]): void {
  const granted = permissionsForRoles(requestActor(c).roles);
  if (!permissions.some((permission) => granted.has(permission))) {
    throw new ForbiddenError(`This action requires one of: ${permissions.join(", ")}`);
  }
}

function hasAnyRole(c: HandlerContext, roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function requireRole(c: HandlerContext, roles: string[]): void {
  if (!hasAnyRole(c, roles)) throw new ForbiddenError(`This action requires one of: ${roles.join(", ")}`);
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function idempotency(c: HandlerContext, route: string, payload: unknown): Promise<string | null> {
  if (!c.req.header("idempotency-key")) return Promise.resolve(null);
  return requireIdempotency(c, route, payload).then((key) => key);
}

async function userDepartmentIds(tx: Tx, tenantId: string, userId: string): Promise<string[]> {
  const rows = await tx`
    select distinct a.department_id
      from department_assignments a
      join engagements e on e.id = a.engagement_id
      join staff_persons s on s.id = e.staff_person_id
     where s.user_id = ${userId} and e.tenant_id = ${tenantId}
       and a.starts_on <= current_date and (a.ends_on is null or a.ends_on >= current_date)
  `;
  return rows.map((row) => String(row.departmentId));
}

interface LocationScope {
  all: boolean;
  ids: string[];
}

async function locationScope(tx: Tx, c: HandlerContext, tenantId: string, userId: string): Promise<LocationScope> {
  const requested = c.req.query("scope");
  const canViewOrganisation = hasAnyRole(c, ORG_SCOPE_ROLES) && permissionsForRoles(requestActor(c).roles).has("inventory.report.read");
  if (requested === "all") {
    if (!canViewOrganisation) throw new ForbiddenError("Organisation-wide inventory scope requires explicit reporting permission");
    return { all: true, ids: [] };
  }
  const departments = await userDepartmentIds(tx, tenantId, userId);
  const rows = await tx`
    select id from inventory_locations
     where tenant_id = ${tenantId}
       and (
         location_type = 'central-store'
         or custodian_user_id = ${userId}
         or department_id = any(${tx.array(departments)}::uuid[])
       )
  `;
  return { all: false, ids: rows.map((row) => String(row.id)) };
}

async function locationRow(tx: Tx, tenantId: string, locationId: string) {
  const rows = await tx`
    select id, code, name, location_type, department_id, parent_id, status
      from inventory_locations where id = ${locationId} and tenant_id = ${tenantId}
  `;
  return requireRows(rows, "Inventory location not found");
}

async function itemRow(tx: Tx, tenantId: string, itemId: string) {
  const rows = await tx`
    select id, item_code, name, classification, base_unit, lot_tracked, expiry_tracked, serial_tracked, medicine_id
      from inventory_items where id = ${itemId} and tenant_id = ${tenantId}
  `;
  return requireRows(rows, "Inventory item not found");
}

async function unitFactor(tx: Tx, tenantId: string, itemId: string, unit: string): Promise<number> {
  const rows = await tx`
    select conversion_factor from inventory_item_units
     where tenant_id = ${tenantId} and item_id = ${itemId} and unit = ${unit}
  `;
  if (!rows[0]) throw new ValidationError(`Unit ${unit} is not configured for this item`);
  return numberValue(rows[0].conversionFactor);
}

async function ensureBalance(tx: Tx, tenantId: string, locationId: string, itemId: string, lotId: string | null) {
  await tx`select pg_advisory_xact_lock(hashtext(${`inventory-balance:${tenantId}:${locationId}:${itemId}:${lotId ?? "none"}`}))`;
  const existing = await tx`
    select id, on_hand, reserved, quarantined, in_transit, updated_at
      from inventory_balances
     where tenant_id = ${tenantId} and location_id = ${locationId} and item_id = ${itemId}
       and lot_id is not distinct from ${lotId}
     for update
  `;
  if (existing[0]) return existing[0];
  const id = crypto.randomUUID();
  await tx`
    insert into inventory_balances (id, tenant_id, location_id, item_id, lot_id)
    values (${id}, ${tenantId}, ${locationId}, ${itemId}, ${lotId})
  `;
  return requireRows(await tx`
    select id, on_hand, reserved, quarantined, in_transit, updated_at
      from inventory_balances where id = ${id} for update
  `, "Inventory balance could not be created");
}

async function moveBalance(
  tx: Tx,
  tenantId: string,
  locationId: string,
  itemId: string,
  lotId: string | null,
  field: "on_hand" | "reserved" | "quarantined" | "in_transit",
  delta: number,
): Promise<void> {
  await ensureBalance(tx, tenantId, locationId, itemId, lotId);
  if (field === "on_hand") {
    await tx`update inventory_balances set on_hand = on_hand + ${delta}, updated_at = now()
      where tenant_id = ${tenantId} and location_id = ${locationId} and item_id = ${itemId} and lot_id is not distinct from ${lotId}`;
  } else if (field === "reserved") {
    await tx`update inventory_balances set reserved = reserved + ${delta}, updated_at = now()
      where tenant_id = ${tenantId} and location_id = ${locationId} and item_id = ${itemId} and lot_id is not distinct from ${lotId}`;
  } else if (field === "quarantined") {
    await tx`update inventory_balances set quarantined = quarantined + ${delta}, updated_at = now()
      where tenant_id = ${tenantId} and location_id = ${locationId} and item_id = ${itemId} and lot_id is not distinct from ${lotId}`;
  } else {
    await tx`update inventory_balances set in_transit = in_transit + ${delta}, updated_at = now()
      where tenant_id = ${tenantId} and location_id = ${locationId} and item_id = ${itemId} and lot_id is not distinct from ${lotId}`;
  }
}

interface PostedMovement {
  id: string;
  replayed: boolean;
  [key: string]: unknown;
}

interface MovementInput {
  itemId: string;
  lotId?: string | null;
  sourceLocationId?: string | null;
  destinationLocationId?: string | null;
  quantity: number;
  unit: string;
  movementType: string;
  reason: string;
  occurredAt?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  approverId?: string | null;
  reversesMovementId?: string | null;
  allowIneligible?: boolean;
  serialNumber?: string | null;
}

async function postMovement(tx: Tx, tenantId: string, actorId: string, input: MovementInput): Promise<PostedMovement> {
  if (input.idempotencyKey) {
    const existing = await tx`
      select * from inventory_movements
       where tenant_id = ${tenantId} and idempotency_key = ${input.idempotencyKey}
    `;
    if (existing[0]) return { ...(existing[0] as Record<string, unknown>), id: String(existing[0].id), replayed: true };
  }
  const item = await itemRow(tx, tenantId, input.itemId);
  if (!input.sourceLocationId && !input.destinationLocationId) {
    throw new ValidationError("A source or destination location is required");
  }
  if (input.sourceLocationId) await locationRow(tx, tenantId, input.sourceLocationId);
  if (input.destinationLocationId) await locationRow(tx, tenantId, input.destinationLocationId);
  const factor = await unitFactor(tx, tenantId, input.itemId, input.unit);
  const baseQuantity = round4(input.quantity * factor);
  if (baseQuantity <= 0) throw new ValidationError("Quantity must be greater than zero");

  let lotId = input.lotId ?? null;
  if (input.sourceLocationId) {
    if (Boolean(item.lotTracked) && !lotId) {
      throw new ValidationError("This item is lot tracked; select an eligible lot before issuing stock");
    }
    if (lotId) {
      const lots = await tx`
        select id, status, expires_on, item_id from inventory_lots
         where id = ${lotId} and tenant_id = ${tenantId}
      `;
      const lot = await requireRows(lots, "Inventory lot not found");
      if (String(lot.itemId) !== input.itemId) throw new ValidationError("The selected lot does not belong to this item");
      if (!input.allowIneligible) {
        if (String(lot.status) !== "available") {
          throw new ConflictError(`Lot ${lotId} is ${lot.status} and cannot be issued or transferred`);
        }
        if (Boolean(item.expiryTracked) && lot.expiresOn && new Date(String(lot.expiresOn)) < new Date(new Date().toDateString())) {
          throw new ConflictError("The selected lot has expired and cannot be issued or transferred");
        }
      }
    }
  }
  if (!lotId) lotId = null;

  if (input.sourceLocationId) {
    const balance = await ensureBalance(tx, tenantId, input.sourceLocationId, input.itemId, lotId);
    const available = numberValue(balance.onHand) - numberValue(balance.reserved) - numberValue(balance.quarantined);
    if (available + 0.00005 < baseQuantity) {
      throw new ConflictError("Insufficient available stock at the source location", {
        available: round4(available),
        requested: baseQuantity,
      });
    }
  }

  const id = crypto.randomUUID();
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  await tx`
    insert into inventory_movements (
      id, tenant_id, item_id, lot_id, serial_number, source_location_id, destination_location_id,
      quantity, unit, conversion_factor, movement_type, reference_type, reference_id, occurred_at,
      actor_id, approver_id, reason, idempotency_key, reverses_movement_id
    ) values (
      ${id}, ${tenantId}, ${input.itemId}, ${lotId}, ${input.serialNumber ?? null},
      ${input.sourceLocationId ?? null}, ${input.destinationLocationId ?? null},
      ${input.quantity}, ${input.unit}, ${factor}, ${input.movementType},
      ${input.referenceType || null}, ${input.referenceId || null}, ${occurredAt},
      ${actorId}, ${input.approverId ?? null}, ${input.reason}, ${input.idempotencyKey ?? null},
      ${input.reversesMovementId ?? null}
    )
  `;
  if (input.sourceLocationId) {
    await moveBalance(tx, tenantId, input.sourceLocationId, input.itemId, lotId, "on_hand", -baseQuantity);
  }
  if (input.destinationLocationId) {
    await moveBalance(tx, tenantId, input.destinationLocationId, input.itemId, lotId, "on_hand", baseQuantity);
  }
  const rows = await tx`select * from inventory_movements where id = ${id}`;
  const movement = await requireRows(rows, "Inventory movement not found");
  return { ...(movement as Record<string, unknown>), id: String(movement.id), replayed: false };
}

async function selectEligibleLot(
  tx: Tx,
  tenantId: string,
  locationId: string,
  itemId: string,
  baseQuantity: number,
  lotTracked: boolean,
  expiryTracked: boolean,
): Promise<string | null> {
  const rows = await tx`
    select b.lot_id, b.on_hand, b.reserved, b.quarantined, l.expires_on, l.status
      from inventory_balances b
      left join inventory_lots l on l.id = b.lot_id
     where b.tenant_id = ${tenantId} and b.location_id = ${locationId} and b.item_id = ${itemId}
       and (b.on_hand - b.reserved - b.quarantined) >= ${baseQuantity}
       and (${lotTracked} = false or b.lot_id is not null)
       and (b.lot_id is null or (l.status = 'available' and (${expiryTracked} = false or l.expires_on is null or l.expires_on >= current_date)))
     order by l.expires_on asc nulls last, b.updated_at asc
     limit 1
  `;
  return rows[0]?.lotId ? String(rows[0].lotId) : null;
}

const REFERENCES = {
  requisition: { table: "inventory_requisitions", column: "request_number", prefix: "REQ" },
  transfer: { table: "inventory_transfers", column: "transfer_number", prefix: "TRF" },
  count: { table: "inventory_counts", column: "count_number", prefix: "CNT" },
  adjustment: { table: "inventory_adjustments", column: "adjustment_number", prefix: "ADJ" },
  recall: { table: "inventory_recalls", column: "recall_number", prefix: "RCL" },
} as const;

async function nextReference(tx: Tx, tenantId: string, kind: keyof typeof REFERENCES): Promise<string> {
  const definition = REFERENCES[kind];
  const year = new Date().getUTCFullYear();
  await tx`select pg_advisory_xact_lock(hashtext(${`inventory:${kind}:${tenantId}:${year}`}))`;
  const rows = await tx.unsafe(
    `select count(*)::int as count from ${definition.table} where tenant_id = $1 and ${definition.column} like $2`,
    [tenantId, `${definition.prefix}-${year}-%`],
  );
  return `${definition.prefix}-${year}-${String(Number(rows[0]?.count ?? 0) + 1).padStart(5, "0")}`;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "";
  const headers = Object.keys(first);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}

async function reportResponse(
  c: Context<AppEnv>,
  tx: Tx,
  key: string,
  rows: Record<string, unknown>[],
): Promise<Response | void> {
  if (c.req.query("format") !== "csv") return;
  const auth = c.get("auth")!;
  await tx`
    insert into inventory_export_audit (id, tenant_id, user_id, report_key, filters, row_count)
    values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${auth.user.id}, ${key},
      ${tx.json({ format: "csv", scope: c.req.query("scope") ?? "mine" } as never)}, ${rows.length})
  `;
  await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.report.export", {
    resourceType: "InventoryReport", resourceId: null, metadata: { reportKey: key, rowCount: rows.length },
  }));
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="${key}.csv"`);
  return c.body(toCsv(rows));
}

inventoryRoutes.get("/inventory/items", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.catalogue.read");
  const auth = c.get("auth")!;
  const q = c.req.query("q")?.trim().toLowerCase();
  const classification = c.req.query("classification");
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select i.id, i.item_code, i.name, i.description, i.category, i.subcategory, i.classification,
           i.base_unit, i.manufacturer, i.supplier_name, i.barcode, i.lot_tracked, i.serial_tracked,
           i.expiry_tracked, i.storage_requirements, i.criticality, i.unit_cost::float8 as unit_cost,
           i.currency, i.status, i.updated_at, m.name as medicine_name,
           (select json_agg(json_build_object('unit', u.unit, 'conversionFactor', u.conversion_factor::float8,
              'isBase', u.is_base, 'purchasingUnit', u.purchasing_unit, 'issuingUnit', u.issuing_unit))
             from inventory_item_units u where u.item_id = i.id) as units
      from inventory_items i
      left join medicines m on m.id = i.medicine_id
     where i.tenant_id = ${auth.activeTenant!.id}
       ${classification ? tx`and i.classification = ${classification}` : tx``}
       ${status ? tx`and i.status = ${status}` : tx``}
       ${q ? tx`and (lower(i.name) like ${`%${q}%`} or lower(i.item_code) like ${`%${q}%`} or lower(i.category) like ${`%${q}%`})` : tx``}
     order by i.category, i.name limit 500
  `);
  return c.json({ items: rows });
});

inventoryRoutes.post("/inventory/items", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.catalogue.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryItemSchema);
  if (body.units.filter((unit) => unit.isBase).length !== 1) throw new ValidationError("Exactly one base unit is required");
  const base = body.units.find((unit) => unit.isBase)!;
  if (base.unit !== body.baseUnit) throw new ValidationError("The base unit must match the item base unit");
  if (Number(base.conversionFactor) !== 1) throw new ValidationError("The base unit conversion factor must be 1");
  if (body.classification === "medicine" && !body.medicineId) throw new ValidationError("Medicine items must be linked to a medicine record");
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.medicineId) {
      const medicine = await tx`select id from medicines where id = ${body.medicineId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!medicine[0]) throw new ValidationError("The linked medicine was not found");
    }
    if (body.serialTracked && body.classification !== "asset") throw new ValidationError("Serial tracking is only supported for assets");
    await tx`
      insert into inventory_items (
        id, tenant_id, item_code, name, description, category, subcategory, classification, base_unit,
        medicine_id, manufacturer, supplier_name, barcode, lot_tracked, serial_tracked, expiry_tracked,
        storage_requirements, criticality, unit_cost, currency, created_by
      ) values (
        ${id}, ${auth.activeTenant!.id}, ${body.itemCode}, ${body.name}, ${body.description || null},
        ${body.category}, ${body.subcategory || null}, ${body.classification}, ${body.baseUnit},
        ${body.medicineId ?? null}, ${body.manufacturer || null}, ${body.supplierName || null},
        ${body.barcode || null}, ${body.lotTracked}, ${body.serialTracked}, ${body.expiryTracked},
        ${body.storageRequirements || null}, ${body.criticality}, ${body.unitCost}, ${body.currency}, ${auth.user.id}
      )
    `;
    for (const unit of body.units) {
      await tx`
        insert into inventory_item_units (id, tenant_id, item_id, unit, conversion_factor, is_base, purchasing_unit, issuing_unit)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${unit.unit}, ${unit.conversionFactor},
          ${unit.isBase}, ${unit.purchasingUnit}, ${unit.issuingUnit})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.item.create", {
      resourceType: "InventoryItem", resourceId: id,
      metadata: { itemCode: body.itemCode, classification: body.classification, criticality: body.criticality },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "inventory.item.created", aggregateId: id, payload: { itemCode: body.itemCode } });
  });
  return c.json({ ok: true, item: { id } }, 201);
});

inventoryRoutes.patch("/inventory/items/:id", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.catalogue.manage");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryItemUpdateSchema);
  await withStaffActor(c, async (tx) => {
    await itemRow(tx, auth.activeTenant!.id, id);
    await tx`
      update inventory_items set
        name = coalesce(${body.name ?? null}, name),
        description = coalesce(${body.description === undefined ? null : body.description || null}, description),
        category = coalesce(${body.category ?? null}, category),
        subcategory = coalesce(${body.subcategory === undefined ? null : body.subcategory || null}, subcategory),
        criticality = coalesce(${body.criticality ?? null}, criticality),
        unit_cost = coalesce(${body.unitCost ?? null}, unit_cost),
        currency = coalesce(${body.currency ?? null}, currency),
        storage_requirements = coalesce(${body.storageRequirements === undefined ? null : body.storageRequirements || null}, storage_requirements),
        status = coalesce(${body.status ?? null}, status),
        updated_at = now()
      where id = ${id} and tenant_id = ${auth.activeTenant!.id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.item.update", {
      resourceType: "InventoryItem", resourceId: id, metadata: { fields: Object.keys(body) },
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.get("/inventory/locations", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.catalogue.read");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select l.id, l.code, l.name, l.location_type, l.parent_id, l.department_id, l.unit_id,
             l.physical_location_id, l.custodian_user_id, l.status, l.description,
             d.name as department_name, u.name as unit_name, p.name as parent_name, c.display_name as custodian_name,
             (select count(*)::int from inventory_balances b where b.location_id = l.id and b.on_hand > 0) as stocked_items
        from inventory_locations l
        left join departments d on d.id = l.department_id
        left join units u on u.id = l.unit_id
        left join inventory_locations p on p.id = l.parent_id
        left join users c on c.id = l.custodian_user_id
       where l.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and l.id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       order by l.location_type, l.name
    `;
  });
  return c.json({ locations: rows });
});

inventoryRoutes.post("/inventory/locations", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.catalogue.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryLocationSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.parentId) {
      const parent = await tx`select id, location_type from inventory_locations where id = ${body.parentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!parent[0]) throw new ValidationError("The parent inventory location was not found");
    }
    if (body.departmentId) {
      const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!department[0]) throw new ValidationError("The department was not found");
    }
    if (body.unitId) {
      const unit = await tx`select id from units where id = ${body.unitId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!unit[0]) throw new ValidationError("The unit was not found");
    }
    if (body.physicalLocationId) {
      const location = await tx`select id from locations where id = ${body.physicalLocationId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!location[0]) throw new ValidationError("The physical location was not found");
    }
    await tx`
      insert into inventory_locations (id, tenant_id, parent_id, code, name, location_type, department_id,
        unit_id, physical_location_id, custodian_user_id, description, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.parentId ?? null}, ${body.code}, ${body.name}, ${body.locationType},
        ${body.departmentId ?? null}, ${body.unitId ?? null}, ${body.physicalLocationId ?? null},
        ${body.custodianUserId ?? null}, ${body.description || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.location.create", {
      resourceType: "InventoryLocation", resourceId: id, metadata: { code: body.code, locationType: body.locationType },
    }));
  });
  return c.json({ ok: true, location: { id } }, 201);
});

inventoryRoutes.get("/inventory/policies", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select p.id, p.location_id, p.item_id, p.minimum_quantity::float8 as minimum_quantity,
             p.maximum_quantity::float8 as maximum_quantity, p.reorder_quantity::float8 as reorder_quantity,
             p.criticality, p.updated_at, l.name as location_name, i.name as item_name, i.base_unit,
             coalesce(sum(b.on_hand) filter (where b.location_id = p.location_id and b.item_id = p.item_id), 0)::float8 as on_hand,
             coalesce(sum(b.reserved + b.quarantined) filter (where b.location_id = p.location_id and b.item_id = p.item_id), 0)::float8 as committed
        from inventory_location_policies p
        join inventory_locations l on l.id = p.location_id
        join inventory_items i on i.id = p.item_id
        left join inventory_balances b on b.location_id = p.location_id and b.item_id = p.item_id
       where p.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and p.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       group by p.id, l.name, i.name, i.base_unit
       order by l.name, i.name
    `;
  });
  return c.json({ policies: rows });
});

inventoryRoutes.post("/inventory/policies", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.catalogue.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryPolicySchema);
  await withStaffActor(c, async (tx) => {
    await locationRow(tx, auth.activeTenant!.id, body.locationId);
    await itemRow(tx, auth.activeTenant!.id, body.itemId);
    await tx`
      insert into inventory_location_policies (id, tenant_id, location_id, item_id, minimum_quantity,
        maximum_quantity, reorder_quantity, criticality, updated_by)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${body.locationId}, ${body.itemId},
        ${body.minimumQuantity}, ${body.maximumQuantity ?? null}, ${body.reorderQuantity}, ${body.criticality}, ${auth.user.id})
      on conflict (location_id, item_id) do update set
        minimum_quantity = excluded.minimum_quantity,
        maximum_quantity = excluded.maximum_quantity,
        reorder_quantity = excluded.reorder_quantity,
        criticality = excluded.criticality,
        updated_by = excluded.updated_by,
        updated_at = now()
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.policy.upsert", {
      resourceType: "InventoryPolicy", resourceId: body.locationId,
      metadata: { itemId: body.itemId, minimum: body.minimumQuantity, reorder: body.reorderQuantity },
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.get("/inventory/stock", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const locationId = c.req.query("locationId");
  const itemId = c.req.query("itemId");
  const q = c.req.query("q")?.trim().toLowerCase();
  const includeEmpty = c.req.query("includeEmpty") === "true";
  const rows = await withStaffActor(c, async (tx) => {
    await tx`
      update stock_reservations r
         set status = 'expired', released_at = now()
       where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'active'
         and r.expires_at is not null and r.expires_at <= now()
         and not exists (select 1 from stock_reservations x where x.id = r.id and x.status <> 'active')
    `;
    const replenished = await tx`
      select r.id, r.location_id, r.item_id, r.lot_id, r.quantity
        from stock_reservations r
       where r.tenant_id = ${auth.activeTenant!.id} and r.status = 'expired' and r.released_at = now()
    `;
    for (const reservation of replenished) {
      await moveBalance(tx, auth.activeTenant!.id, String(reservation.locationId), String(reservation.itemId),
        reservation.lotId ? String(reservation.lotId) : null, "reserved", -numberValue(reservation.quantity));
    }
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select b.id, b.location_id, b.item_id, b.lot_id, b.on_hand::float8 as on_hand,
             b.reserved::float8 as reserved, b.quarantined::float8 as quarantined,
             b.in_transit::float8 as in_transit,
             (b.on_hand - b.reserved - b.quarantined)::float8 as available,
             b.updated_at, i.item_code, i.name as item_name, i.category, i.classification, i.base_unit,
             i.criticality, i.unit_cost::float8 as unit_cost, i.currency, i.lot_tracked, i.expiry_tracked,
             l.code as location_code, l.name as location_name, l.location_type,
             lt.lot_number, lt.expires_on, lt.status as lot_status,
             (i.expiry_tracked and lt.expires_on is not null and lt.expires_on < current_date) as expired
        from inventory_balances b
        join inventory_items i on i.id = b.item_id
        join inventory_locations l on l.id = b.location_id
        left join inventory_lots lt on lt.id = b.lot_id
       where b.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and b.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
         ${locationId ? tx`and b.location_id = ${locationId}` : tx``}
         ${itemId ? tx`and b.item_id = ${itemId}` : tx``}
         ${q ? tx`and (lower(i.name) like ${`%${q}%`} or lower(i.item_code) like ${`%${q}%`} or lower(lt.lot_number) like ${`%${q}%`})` : tx``}
         ${includeEmpty ? tx`` : tx`and b.on_hand > 0`}
       order by i.name, l.name, lt.expires_on asc nulls last
       limit 1000
    `;
  });
  return c.json({ stock: rows });
});

inventoryRoutes.get("/inventory/lots", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select lt.id, lt.lot_number, lt.manufacture_on, lt.expires_on, lt.supplier, lt.receipt_reference,
           lt.status, lt.notes, lt.created_at, i.id as item_id, i.item_code, i.name as item_name, i.base_unit,
           coalesce(sum(b.on_hand), 0)::float8 as on_hand,
           coalesce(sum(b.reserved + b.quarantined), 0)::float8 as committed,
           (select count(distinct b2.location_id)::int from inventory_balances b2 where b2.lot_id = lt.id and b2.on_hand > 0) as location_count
      from inventory_lots lt
      join inventory_items i on i.id = lt.item_id
      left join inventory_balances b on b.lot_id = lt.id
     where lt.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and lt.status = ${status}` : tx``}
     group by lt.id, i.id
     order by lt.expires_on asc nulls last, i.name
  `);
  return c.json({ lots: rows });
});

inventoryRoutes.get("/inventory/movements", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select m.id, m.item_id, m.lot_id, m.source_location_id, m.destination_location_id,
             m.quantity::float8 as quantity, m.unit, m.base_quantity::float8 as base_quantity,
             m.movement_type, m.reference_type, m.reference_id, m.occurred_at, m.posted_at,
             m.reason, m.actor_id, m.approver_id, m.reverses_movement_id,
             i.name as item_name, i.item_code, lt.lot_number,
             sl.name as source_location_name, dl.name as destination_location_name,
             u.display_name as actor_name
        from inventory_movements m
        join inventory_items i on i.id = m.item_id
        left join inventory_lots lt on lt.id = m.lot_id
        left join inventory_locations sl on sl.id = m.source_location_id
        left join inventory_locations dl on dl.id = m.destination_location_id
        left join users u on u.id = m.actor_id
       where m.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and (m.source_location_id = any(${tx.array(scope.ids)}::uuid[]) or m.destination_location_id = any(${tx.array(scope.ids)}::uuid[]))` : tx`and false`}
       order by m.occurred_at desc, m.posted_at desc limit ${limit}
    `;
  });
  return c.json({ movements: rows });
});

inventoryRoutes.post("/inventory/receipts", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.receive");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryReceiptSchema);
  const key = await idempotency(c, "inventory.receipt", body);
  const result = await withStaffActor(c, async (tx) => {
    const item = await itemRow(tx, auth.activeTenant!.id, body.itemId);
    await locationRow(tx, auth.activeTenant!.id, body.locationId);
    if (Boolean(item.lotTracked) && !body.lotNumber) throw new ValidationError("A lot number is required for lot-tracked items");
    if (Boolean(item.expiryTracked) && !body.expiresOn) throw new ValidationError("An expiry date is required for expiry-tracked items");
    let lotId: string | null = null;
    if (Boolean(item.lotTracked)) {
      const existing = await tx`
        select id, status from inventory_lots
         where tenant_id = ${auth.activeTenant!.id} and item_id = ${body.itemId} and lot_number = ${body.lotNumber ?? ""}
      `;
      if (existing[0]) {
        lotId = String(existing[0].id);
        if (String(existing[0].status) === "recalled") throw new ConflictError("This lot is under recall and cannot be received");
        await tx`
          update inventory_lots set
            manufacture_on = coalesce(${body.manufactureOn ?? null}, manufacture_on),
            expires_on = coalesce(${body.expiresOn ?? null}, expires_on),
            supplier = coalesce(${body.supplier || null}, supplier),
            receipt_reference = coalesce(${body.receiptReference || null}, receipt_reference),
            updated_at = now()
           where id = ${lotId}
        `;
      } else {
        lotId = crypto.randomUUID();
        await tx`
          insert into inventory_lots (id, tenant_id, item_id, lot_number, manufacture_on, expires_on,
            supplier, receipt_reference, status, created_by)
          values (${lotId}, ${auth.activeTenant!.id}, ${body.itemId}, ${body.lotNumber ?? ""},
            ${body.manufactureOn ?? null}, ${body.expiresOn ?? null}, ${body.supplier || null},
            ${body.receiptReference || null}, 'available', ${auth.user.id})
        `;
      }
    }
    const movement = await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
      itemId: body.itemId, lotId, destinationLocationId: body.locationId, quantity: body.quantity,
      unit: body.unit, movementType: "receipt", reason: body.reason, occurredAt: body.occurredAt,
      referenceType: body.referenceType || null, referenceId: body.receiptReference || body.referenceId || null,
      idempotencyKey: key,
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.stock.receipt", {
      resourceType: "InventoryMovement", resourceId: String(movement.id),
      metadata: { itemId: body.itemId, locationId: body.locationId, quantity: body.quantity, unit: body.unit, lotId },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "inventory.stock.received", aggregateId: String(movement.id), payload: { itemId: body.itemId, locationId: body.locationId } });
    return movement;
  });
  return c.json({ ok: true, movement: result, replayed: Boolean((result as { replayed?: boolean }).replayed) }, 201);
});

inventoryRoutes.post("/inventory/issues", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.issue");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryIssueSchema);
  const key = await idempotency(c, "inventory.issue", body);
  const result = await withStaffActor(c, async (tx) => {
    const item = await itemRow(tx, auth.activeTenant!.id, body.itemId);
    await locationRow(tx, auth.activeTenant!.id, body.locationId);
    if (body.destinationLocationId) await locationRow(tx, auth.activeTenant!.id, body.destinationLocationId);
    const factor = await unitFactor(tx, auth.activeTenant!.id, body.itemId, body.unit);
    const baseQuantity = round4(body.quantity * factor);
    let lotId = body.lotId ?? null;
    if (!lotId) {
      lotId = await selectEligibleLot(tx, auth.activeTenant!.id, body.locationId, body.itemId, baseQuantity,
        Boolean(item.lotTracked), Boolean(item.expiryTracked));
    }
    if (body.reservationId) {
      const reservations = await tx`
        select id, status, quantity, location_id, item_id, lot_id, owner_user_id, expires_at
          from stock_reservations where id = ${body.reservationId} and tenant_id = ${auth.activeTenant!.id} for update
      `;
      const reservation = await requireRows(reservations, "Stock reservation not found");
      if (String(reservation.status) !== "active") throw new ConflictError("The stock reservation is no longer active");
      if (reservation.expiresAt && new Date(String(reservation.expiresAt)) <= new Date()) throw new ConflictError("The stock reservation has expired");
      if (String(reservation.locationId) !== body.locationId || String(reservation.itemId) !== body.itemId) {
        throw new ValidationError("The reservation does not match the selected location and item");
      }
      if (numberValue(reservation.quantity) + 0.00005 < baseQuantity) throw new ConflictError("The issue exceeds the reserved quantity");
      if (reservation.lotId) lotId = String(reservation.lotId);
      await moveBalance(tx, auth.activeTenant!.id, body.locationId, body.itemId,
        reservation.lotId ? String(reservation.lotId) : null, "reserved", -baseQuantity);
      await tx`update stock_reservations set status = 'fulfilled', released_at = now() where id = ${body.reservationId}`;
    }
    const movement = await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
      itemId: body.itemId, lotId, sourceLocationId: body.locationId,
      destinationLocationId: body.destinationLocationId ?? null,
      quantity: body.quantity, unit: body.unit, movementType: body.movementType,
      reason: body.reason, occurredAt: body.occurredAt, referenceType: body.referenceType || null,
      referenceId: body.referenceId || null, idempotencyKey: key,
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.stock.issue", {
      resourceType: "InventoryMovement", resourceId: String(movement.id),
      metadata: { itemId: body.itemId, locationId: body.locationId, quantity: body.quantity, movementType: body.movementType },
    }));
    return movement;
  });
  return c.json({ ok: true, movement: result, replayed: Boolean((result as { replayed?: boolean }).replayed) }, 201);
});

inventoryRoutes.post("/inventory/movements/:id/reverse", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.adjust");
  requireRole(c, APPROVER_ROLES);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryAdjustmentSchema.pick({ reason: true }).extend({ reason: inventoryAdjustmentSchema.shape.reason! }));
  const key = await idempotency(c, "inventory.reverse", { id, body });
  const result = await withStaffActor(c, async (tx) => {
    const original = await requireRows(await tx`
      select * from inventory_movements where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Inventory movement not found");
    if (String(original.movementType) === "reversal") throw new ConflictError("A reversal cannot itself be reversed");
    if (["transfer-out", "transfer-in"].includes(String(original.movementType))) {
      throw new ConflictError("Use a stock adjustment to correct in-transit transfer quantities");
    }
    const already = await tx`select id from inventory_movements where reverses_movement_id = ${id}`;
    if (already[0]) throw new ConflictError("This movement has already been reversed");
    const movement = await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
      itemId: String(original.itemId), lotId: original.lotId ? String(original.lotId) : null,
      sourceLocationId: original.destinationLocationId ? String(original.destinationLocationId) : null,
      destinationLocationId: original.sourceLocationId ? String(original.sourceLocationId) : null,
      quantity: numberValue(original.quantity), unit: String(original.unit), movementType: "reversal",
      reason: body.reason, idempotencyKey: key, reversesMovementId: id, approverId: auth.user.id,
      allowIneligible: true,
    });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.movement.reverse", {
      resourceType: "InventoryMovement", resourceId: String(movement.id),
      metadata: { reverses: id, reason: body.reason },
    }));
    return movement;
  });
  return c.json({ ok: true, movement: result }, 201);
});

inventoryRoutes.post("/inventory/reservations", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const body = await parseJson(c, stockReservationSchema);
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    const item = await itemRow(tx, auth.activeTenant!.id, body.itemId);
    await locationRow(tx, auth.activeTenant!.id, body.locationId);
    const factor = await unitFactor(tx, auth.activeTenant!.id, body.itemId, item.baseUnit as string);
    const base = round4(body.quantity * factor);
    let lotId = body.lotId ?? null;
    if (!lotId && Boolean(item.lotTracked)) {
      lotId = await selectEligibleLot(tx, auth.activeTenant!.id, body.locationId, body.itemId, base,
        true, Boolean(item.expiryTracked));
    }
    if (!lotId && Boolean(item.lotTracked)) throw new ConflictError("No eligible lot is available to reserve");
    const balance = await ensureBalance(tx, auth.activeTenant!.id, body.locationId, body.itemId, lotId);
    const available = numberValue(balance.onHand) - numberValue(balance.reserved) - numberValue(balance.quarantined);
    if (available + 0.00005 < base) throw new ConflictError("Insufficient available stock to reserve");
    await moveBalance(tx, auth.activeTenant!.id, body.locationId, body.itemId, lotId, "reserved", base);
    await tx`
      insert into stock_reservations (id, tenant_id, location_id, item_id, lot_id, quantity, source_type,
        source_id, owner_user_id, expires_at, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.locationId}, ${body.itemId}, ${lotId}, ${base},
        ${body.sourceType}, ${body.sourceId || null}, ${auth.user.id}, ${body.expiresAt ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.reservation.create", {
      resourceType: "StockReservation", resourceId: id, metadata: { itemId: body.itemId, locationId: body.locationId, quantity: base },
    }));
    return { id, quantity: base };
  });
  return c.json({ ok: true, reservation: result }, 201);
});

inventoryRoutes.post("/inventory/reservations/:id/release", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const reservation = await requireRows(await tx`
      select * from stock_reservations where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Stock reservation not found");
    if (String(reservation.status) !== "active") throw new ConflictError("Only active reservations can be released");
    await moveBalance(tx, auth.activeTenant!.id, String(reservation.locationId), String(reservation.itemId),
      reservation.lotId ? String(reservation.lotId) : null, "reserved", -numberValue(reservation.quantity));
    await tx`update stock_reservations set status = 'cancelled', released_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.reservation.release", {
      resourceType: "StockReservation", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.get("/inventory/requisitions", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select r.id, r.request_number, r.requesting_department_id, r.requesting_location_id,
             r.fulfilling_location_id, r.requested_by, r.approved_by, r.status, r.reason, r.version,
             r.approved_at, r.created_at, r.updated_at,
             d.name as requesting_department_name, rl.name as requesting_location_name,
             fl.name as fulfilling_location_name, u.display_name as requested_by_name,
             a.display_name as approved_by_name,
             (select count(*)::int from inventory_requisition_lines l where l.requisition_id = r.id) as line_count,
             (select coalesce(sum(l.issued_quantity), 0)::float8 from inventory_requisition_lines l where l.requisition_id = r.id) as issued_quantity
        from inventory_requisitions r
        left join departments d on d.id = r.requesting_department_id
        left join inventory_locations rl on rl.id = r.requesting_location_id
        join inventory_locations fl on fl.id = r.fulfilling_location_id
        left join users u on u.id = r.requested_by
        left join users a on a.id = r.approved_by
       where r.tenant_id = ${auth.activeTenant!.id}
         ${status ? tx`and r.status = ${status}` : tx``}
         ${scope.all ? tx`` : scope.ids.length ? tx`and (r.requesting_location_id = any(${tx.array(scope.ids)}::uuid[]) or r.fulfilling_location_id = any(${tx.array(scope.ids)}::uuid[]))` : tx`and false`}
       order by r.created_at desc limit 300
    `;
  });
  return c.json({ requisitions: rows });
});

inventoryRoutes.get("/inventory/requisitions/:id", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const requisition = await requireRows(await tx`
      select r.*, d.name as requesting_department_name, rl.name as requesting_location_name,
             fl.name as fulfilling_location_name, u.display_name as requested_by_name, a.display_name as approved_by_name
        from inventory_requisitions r
        left join departments d on d.id = r.requesting_department_id
        left join inventory_locations rl on rl.id = r.requesting_location_id
        join inventory_locations fl on fl.id = r.fulfilling_location_id
        left join users u on u.id = r.requested_by
        left join users a on a.id = r.approved_by
       where r.id = ${id} and r.tenant_id = ${auth.activeTenant!.id}
    `, "Requisition not found");
    const lines = await tx`
      select l.id, l.requisition_id, l.item_id, l.requested_quantity::float8 as requested_quantity,
             l.approved_quantity::float8 as approved_quantity, l.issued_quantity::float8 as issued_quantity,
             l.unit, l.notes, i.item_code, i.name as item_name, i.base_unit, i.lot_tracked, i.expiry_tracked,
             coalesce((select sum(b.on_hand - b.reserved - b.quarantined)::float8 from inventory_balances b
               where b.location_id = ${requisition.fulfillingLocationId} and b.item_id = l.item_id), 0) as available
        from inventory_requisition_lines l join inventory_items i on i.id = l.item_id
       where l.requisition_id = ${id} order by i.name
    `;
    return { requisition, lines };
  });
  return c.json(data);
});

inventoryRoutes.post("/inventory/requisitions", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryRequisitionSchema);
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    await locationRow(tx, auth.activeTenant!.id, body.fulfillingLocationId);
    if (body.requestingLocationId) await locationRow(tx, auth.activeTenant!.id, body.requestingLocationId);
    for (const line of body.lines) {
      await itemRow(tx, auth.activeTenant!.id, line.itemId);
      await unitFactor(tx, auth.activeTenant!.id, line.itemId, line.unit);
    }
    const requestNumber = await nextReference(tx, auth.activeTenant!.id, "requisition");
    await tx`
      insert into inventory_requisitions (id, tenant_id, request_number, requesting_department_id,
        requesting_location_id, fulfilling_location_id, requested_by, status, reason)
      values (${id}, ${auth.activeTenant!.id}, ${requestNumber}, ${body.requestingDepartmentId ?? null},
        ${body.requestingLocationId ?? null}, ${body.fulfillingLocationId}, ${auth.user.id}, 'draft', ${body.reason})
    `;
    for (const line of body.lines) {
      await tx`
        insert into inventory_requisition_lines (id, tenant_id, requisition_id, item_id, requested_quantity, unit, notes)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${line.itemId}, ${line.quantity}, ${line.unit}, ${line.notes || null})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.requisition.create", {
      resourceType: "InventoryRequisition", resourceId: id, metadata: { requestNumber, lines: body.lines.length },
    }));
    return { id, requestNumber };
  });
  return c.json({ ok: true, requisition: result }, 201);
});

inventoryRoutes.post("/inventory/requisitions/:id/submit", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const requisition = await requireRows(await tx`
      select id, status, requested_by, version from inventory_requisitions
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Requisition not found");
    if (String(requisition.requestedBy) !== auth.user.id && !hasAnyRole(c, CENTRAL_MANAGER_ROLES)) {
      throw new ForbiddenError("Only the requester or a central store manager can submit this requisition");
    }
    if (String(requisition.status) !== "draft") throw new ConflictError("Only draft requisitions can be submitted");
    await tx`update inventory_requisitions set status = 'submitted', version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.requisition.submit", {
      resourceType: "InventoryRequisition", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.post("/inventory/requisitions/:id/decision", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.receive");
  requireRole(c, CENTRAL_MANAGER_ROLES);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryRequisitionDecisionSchema);
  const result = await withStaffActor(c, async (tx) => {
    const requisition = await requireRows(await tx`
      select id, status, requested_by, version from inventory_requisitions
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Requisition not found");
    ensureMatch(body.expectedVersion, Number(requisition.version));
    if (String(requisition.status) !== "submitted") throw new ConflictError("Only submitted requisitions can be decided");
    if (String(requisition.requestedBy) === auth.user.id) throw new ForbiddenError("A requisition cannot be approved or rejected by its requester");
    const lines = await tx`select id, requested_quantity, unit from inventory_requisition_lines where requisition_id = ${id}`;
    if (body.decision === "reject") {
      await tx`update inventory_requisitions set status = 'rejected', approved_by = ${auth.user.id},
        approved_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.requisition.reject", {
        resourceType: "InventoryRequisition", resourceId: id, reasonCode: "rejected", metadata: { reason: body.reason },
      }));
      return { status: "rejected" };
    }
    const requested = new Map(lines.map((line) => [String(line.id), numberValue(line.requestedQuantity)]));
    if (body.lines) {
      for (const line of body.lines) {
        if (!requested.has(line.lineId)) throw new ValidationError("An approval line does not belong to this requisition");
        if (line.approvedQuantity > (requested.get(line.lineId) ?? 0) + 0.00005) throw new ValidationError("Approved quantity cannot exceed requested quantity");
        await tx`update inventory_requisition_lines set approved_quantity = ${line.approvedQuantity} where id = ${line.lineId}`;
      }
    }
    for (const line of lines) {
      if (!body.lines?.some((approved) => approved.lineId === String(line.id))) {
        await tx`update inventory_requisition_lines set approved_quantity = requested_quantity where id = ${line.id}`;
      }
    }
    await tx`update inventory_requisitions set status = 'approved', approved_by = ${auth.user.id},
      approved_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.requisition.approve", {
      resourceType: "InventoryRequisition", resourceId: id, metadata: { reason: body.reason },
    }));
    return { status: "approved" };
  });
  return c.json({ ok: true, ...result });
});

inventoryRoutes.post("/inventory/requisitions/:id/issue", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.issue");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryRequisitionIssueSchema);
  const key = await idempotency(c, "inventory.requisition.issue", { id, body });
  const result = await withStaffActor(c, async (tx) => {
    const requisition = await requireRows(await tx`
      select * from inventory_requisitions where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Requisition not found");
    ensureMatch(body.expectedVersion, Number(requisition.version));
    if (!["approved", "partially-issued"].includes(String(requisition.status))) {
      throw new ConflictError("Only approved or partially issued requisitions can be issued");
    }
    if (String(requisition.requestedBy) === auth.user.id && !hasAnyRole(c, CENTRAL_MANAGER_ROLES)) {
      throw new ForbiddenError("The requester cannot issue their own requisition");
    }
    const line = await requireRows(await tx`
      select l.*, i.lot_tracked, i.expiry_tracked from inventory_requisition_lines l
        join inventory_items i on i.id = l.item_id
       where l.id = ${body.lineId} and l.requisition_id = ${id} for update
    `, "Requisition line not found");
    const approved = numberValue(line.approvedQuantity ?? line.requestedQuantity);
    const remaining = approved - numberValue(line.issuedQuantity);
    if (body.quantity > remaining + 0.00005) throw new ConflictError("The issue exceeds the approved remaining quantity", { remaining: round4(remaining) });
    const factor = await unitFactor(tx, auth.activeTenant!.id, String(line.itemId), body.unit);
    const base = round4(body.quantity * factor);
    let lotId = body.lotId ?? null;
    if (!lotId && Boolean(line.lotTracked)) {
      lotId = await selectEligibleLot(tx, auth.activeTenant!.id, String(requisition.fulfillingLocationId),
        String(line.itemId), base, true, Boolean(line.expiryTracked));
    }
    const movement = await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
      itemId: String(line.itemId), lotId, sourceLocationId: String(requisition.fulfillingLocationId),
      destinationLocationId: requisition.requestingLocationId ? String(requisition.requestingLocationId) : null,
      quantity: body.quantity, unit: body.unit, movementType: "issue",
      reason: `Requisition ${requisition.requestNumber}`,
      referenceType: "inventory-requisition", referenceId: id, idempotencyKey: key,
    });
    await tx`update inventory_requisition_lines set issued_quantity = issued_quantity + ${body.quantity} where id = ${body.lineId}`;
    const remainingRows = await tx`
      select count(*)::int as count from inventory_requisition_lines
       where requisition_id = ${id} and issued_quantity < coalesce(approved_quantity, requested_quantity)
    `;
    const complete = Number(remainingRows[0]?.count ?? 0) === 0;
    await tx`update inventory_requisitions set status = ${complete ? "issued" : "partially-issued"},
      version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.requisition.issue", {
      resourceType: "InventoryMovement", resourceId: String(movement.id),
      metadata: { requisitionId: id, lineId: body.lineId, quantity: body.quantity, unit: body.unit },
    }));
    return movement;
  });
  return c.json({ ok: true, movement: result }, 201);
});

inventoryRoutes.get("/inventory/transfers", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select t.id, t.transfer_number, t.source_location_id, t.destination_location_id, t.status,
             t.dispatched_by, t.received_by, t.dispatched_at, t.received_at, t.discrepancy_note,
             t.version, t.created_at, sl.name as source_location_name, dl.name as destination_location_name,
             (select count(*)::int from inventory_transfer_lines l where l.transfer_id = t.id) as line_count,
             (select coalesce(sum(l.dispatched_quantity), 0)::float8 from inventory_transfer_lines l where l.transfer_id = t.id) as dispatched_quantity,
             (select coalesce(sum(l.received_quantity), 0)::float8 from inventory_transfer_lines l where l.transfer_id = t.id) as received_quantity
        from inventory_transfers t
        join inventory_locations sl on sl.id = t.source_location_id
        join inventory_locations dl on dl.id = t.destination_location_id
       where t.tenant_id = ${auth.activeTenant!.id}
         ${status ? tx`and t.status = ${status}` : tx``}
         ${scope.all ? tx`` : scope.ids.length ? tx`and (t.source_location_id = any(${tx.array(scope.ids)}::uuid[]) or t.destination_location_id = any(${tx.array(scope.ids)}::uuid[]))` : tx`and false`}
       order by t.created_at desc limit 300
    `;
  });
  return c.json({ transfers: rows });
});

inventoryRoutes.get("/inventory/transfers/:id", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const transfer = await requireRows(await tx`
      select t.*, sl.name as source_location_name, dl.name as destination_location_name
        from inventory_transfers t
        join inventory_locations sl on sl.id = t.source_location_id
        join inventory_locations dl on dl.id = t.destination_location_id
       where t.id = ${id} and t.tenant_id = ${auth.activeTenant!.id}
    `, "Transfer not found");
    const lines = await tx`
      select l.id, l.transfer_id, l.item_id, l.lot_id, l.dispatched_quantity::float8 as dispatched_quantity,
             l.received_quantity::float8 as received_quantity, l.rejected_quantity::float8 as rejected_quantity,
             l.unit, l.discrepancy_reason, i.item_code, i.name as item_name, i.base_unit,
             lt.lot_number, lt.expires_on
        from inventory_transfer_lines l
        join inventory_items i on i.id = l.item_id
        left join inventory_lots lt on lt.id = l.lot_id
       where l.transfer_id = ${id} order by i.name
    `;
    return { transfer, lines };
  });
  return c.json(data);
});

inventoryRoutes.post("/inventory/transfers", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.transfer.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryTransferSchema);
  if (body.sourceLocationId === body.destinationLocationId) throw new ValidationError("Source and destination must differ");
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    await locationRow(tx, auth.activeTenant!.id, body.sourceLocationId);
    await locationRow(tx, auth.activeTenant!.id, body.destinationLocationId);
    for (const line of body.lines) {
      await itemRow(tx, auth.activeTenant!.id, line.itemId);
      await unitFactor(tx, auth.activeTenant!.id, line.itemId, line.unit);
    }
    const transferNumber = await nextReference(tx, auth.activeTenant!.id, "transfer");
    await tx`
      insert into inventory_transfers (id, tenant_id, transfer_number, source_location_id,
        destination_location_id, status, discrepancy_note, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${transferNumber}, ${body.sourceLocationId},
        ${body.destinationLocationId}, 'draft', ${body.note || null}, ${auth.user.id})
    `;
    for (const line of body.lines) {
      await tx`
        insert into inventory_transfer_lines (id, tenant_id, transfer_id, item_id, lot_id,
          dispatched_quantity, unit)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${line.itemId}, ${line.lotId ?? null},
          ${line.quantity}, ${line.unit})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.transfer.create", {
      resourceType: "InventoryTransfer", resourceId: id, metadata: { transferNumber, lines: body.lines.length },
    }));
    return { id, transferNumber };
  });
  return c.json({ ok: true, transfer: result }, 201);
});

inventoryRoutes.post("/inventory/transfers/:id/dispatch", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.transfer.manage");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryTransferDispatchSchema);
  await withStaffActor(c, async (tx) => {
    const transfer = await requireRows(await tx`
      select * from inventory_transfers where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Transfer not found");
    ensureMatch(body.expectedVersion, Number(transfer.version));
    if (String(transfer.status) !== "draft") throw new ConflictError("Only draft transfers can be dispatched");
    const lines = await tx`select * from inventory_transfer_lines where transfer_id = ${id} order by id`;
    for (const line of lines) {
      const factor = await unitFactor(tx, auth.activeTenant!.id, String(line.itemId), String(line.unit));
      const base = round4(numberValue(line.dispatchedQuantity) * factor);
      await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
        itemId: String(line.itemId), lotId: line.lotId ? String(line.lotId) : null,
        sourceLocationId: String(transfer.sourceLocationId), quantity: numberValue(line.dispatchedQuantity),
        unit: String(line.unit), movementType: "transfer-out",
        reason: `Transfer ${transfer.transferNumber} dispatched`,
        referenceType: "inventory-transfer", referenceId: id,
      });
      await moveBalance(tx, auth.activeTenant!.id, String(transfer.sourceLocationId), String(line.itemId),
        line.lotId ? String(line.lotId) : null, "in_transit", base);
    }
    await tx`update inventory_transfers set status = 'in-transit', dispatched_by = ${auth.user.id},
      dispatched_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.transfer.dispatch", {
      resourceType: "InventoryTransfer", resourceId: id, metadata: { transferNumber: transfer.transferNumber, lines: lines.length },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "inventory.transfer.dispatched", aggregateId: id });
  });
  return c.json({ ok: true });
});

inventoryRoutes.post("/inventory/transfers/:id/receive", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.receive");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryTransferReceiveSchema);
  await withStaffActor(c, async (tx) => {
    const transfer = await requireRows(await tx`
      select * from inventory_transfers where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Transfer not found");
    ensureMatch(body.expectedVersion, Number(transfer.version));
    if (!["in-transit", "partially-received"].includes(String(transfer.status))) {
      throw new ConflictError("Only dispatched transfers can be received");
    }
    if (String(transfer.dispatchedBy) === auth.user.id) throw new ForbiddenError("The dispatcher cannot receive the same transfer");
    for (const input of body.lines) {
      const line = await requireRows(await tx`
        select * from inventory_transfer_lines where id = ${input.lineId} and transfer_id = ${id} for update
      `, "Transfer line not found");
      const handled = numberValue(input.receivedQuantity) + numberValue(input.rejectedQuantity);
      const remaining = numberValue(line.dispatchedQuantity) - numberValue(line.receivedQuantity) - numberValue(line.rejectedQuantity);
      if (handled > remaining + 0.00005) throw new ConflictError("Received and rejected quantities exceed the outstanding dispatched quantity");
      if (handled <= 0) continue;
      const factor = await unitFactor(tx, auth.activeTenant!.id, String(line.itemId), String(line.unit));
      if (numberValue(input.receivedQuantity) > 0) {
        await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
          itemId: String(line.itemId), lotId: line.lotId ? String(line.lotId) : null,
          destinationLocationId: String(transfer.destinationLocationId), quantity: numberValue(input.receivedQuantity),
          unit: String(line.unit), movementType: "transfer-in",
          reason: `Transfer ${transfer.transferNumber} received`,
          referenceType: "inventory-transfer", referenceId: id,
        });
      }
      if (numberValue(input.rejectedQuantity) > 0) {
        await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
          itemId: String(line.itemId), lotId: line.lotId ? String(line.lotId) : null,
          destinationLocationId: String(transfer.sourceLocationId), quantity: numberValue(input.rejectedQuantity),
          unit: String(line.unit), movementType: "return",
          reason: `Transfer ${transfer.transferNumber} rejected at receipt: ${input.discrepancyReason || "not stated"}`,
          referenceType: "inventory-transfer", referenceId: id, allowIneligible: true,
        });
      }
      await moveBalance(tx, auth.activeTenant!.id, String(transfer.sourceLocationId), String(line.itemId),
        line.lotId ? String(line.lotId) : null, "in_transit", -round4(handled * factor));
      await tx`update inventory_transfer_lines set received_quantity = received_quantity + ${input.receivedQuantity},
        rejected_quantity = rejected_quantity + ${input.rejectedQuantity},
        discrepancy_reason = coalesce(${input.discrepancyReason || null}, discrepancy_reason) where id = ${input.lineId}`;
    }
    const outstanding = await tx`
      select count(*)::int as count from inventory_transfer_lines
       where transfer_id = ${id} and received_quantity + rejected_quantity < dispatched_quantity
    `;
    const complete = Number(outstanding[0]?.count ?? 0) === 0;
    const discrepancy = body.lines.find((line) => numberValue(line.rejectedQuantity) > 0)?.discrepancyReason || null;
    await tx`update inventory_transfers set status = ${complete ? "received" : "partially-received"},
      received_by = ${auth.user.id}, received_at = now(), discrepancy_note = coalesce(${discrepancy}, discrepancy_note),
      version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.transfer.receive", {
      resourceType: "InventoryTransfer", resourceId: id,
      metadata: { transferNumber: transfer.transferNumber, complete, discrepancy },
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.get("/inventory/counts", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select k.id, k.count_number, k.location_id, k.status, k.blind, k.counted_by, k.approved_by,
             k.snapshot_at, k.submitted_at, k.posted_at, k.version, l.name as location_name,
             u.display_name as counted_by_name,
             (select count(*)::int from inventory_count_lines cl where cl.count_id = k.id) as line_count,
             (select count(*)::int from inventory_count_lines cl where cl.count_id = k.id and coalesce(cl.variance, 0) <> 0) as variance_lines
        from inventory_counts k join inventory_locations l on l.id = k.location_id
        left join users u on u.id = k.counted_by
       where k.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and k.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       order by k.created_at desc limit 200
    `;
  });
  return c.json({ counts: rows });
});

inventoryRoutes.post("/inventory/counts", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.count.manage");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryCountSchema);
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    await locationRow(tx, auth.activeTenant!.id, body.locationId);
    const seen = new Set<string>();
    const countNumber = await nextReference(tx, auth.activeTenant!.id, "count");
    await tx`
      insert into inventory_counts (id, tenant_id, count_number, location_id, status, blind, counted_by,
        snapshot_at, submitted_at)
      values (${id}, ${auth.activeTenant!.id}, ${countNumber}, ${body.locationId}, 'submitted', ${body.blind},
        ${auth.user.id}, now(), now())
    `;
    for (const line of body.lines) {
      const identity = `${line.itemId}:${line.lotId ?? ""}`;
      if (seen.has(identity)) throw new ValidationError("Duplicate item and lot in stock count");
      seen.add(identity);
      const item = await itemRow(tx, auth.activeTenant!.id, line.itemId);
      if (Boolean(item.lotTracked) && !line.lotId) throw new ValidationError("Lot-tracked count lines require a lot");
      if (line.lotId) {
        const lot = await tx`select id from inventory_lots where id = ${line.lotId} and item_id = ${line.itemId} and tenant_id = ${auth.activeTenant!.id}`;
        if (!lot[0]) throw new ValidationError("A count lot does not belong to the selected item");
      }
      const balance = await tx`
        select on_hand::float8 as on_hand from inventory_balances
         where tenant_id = ${auth.activeTenant!.id} and location_id = ${body.locationId}
           and item_id = ${line.itemId} and lot_id is not distinct from ${line.lotId ?? null}
      `;
      const snapshot = numberValue(balance[0]?.onHand);
      await tx`
        insert into inventory_count_lines (id, tenant_id, count_id, item_id, lot_id, snapshot_quantity,
          counted_quantity, variance, reason_code)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${line.itemId}, ${line.lotId ?? null},
          ${snapshot}, ${line.countedQuantity}, ${round4(line.countedQuantity - snapshot)}, ${line.reasonCode || null})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.count.submit", {
      resourceType: "InventoryCount", resourceId: id,
      metadata: { countNumber, locationId: body.locationId, lines: body.lines.length, blind: body.blind },
    }));
    return { id, countNumber };
  });
  return c.json({ ok: true, count: result }, 201);
});

inventoryRoutes.post("/inventory/counts/:id/decision", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.adjust");
  requireRole(c, APPROVER_ROLES);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryCountDecisionSchema);
  const result = await withStaffActor(c, async (tx) => {
    const count = await requireRows(await tx`
      select * from inventory_counts where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Stock count not found");
    ensureMatch(body.expectedVersion, Number(count.version));
    if (String(count.status) !== "submitted") throw new ConflictError("Only submitted counts can be decided");
    if (String(count.countedBy) === auth.user.id) throw new ForbiddenError("A count cannot be approved by the person who counted it");
    if (body.decision === "reject") {
      await tx`update inventory_counts set status = 'rejected', approved_by = ${auth.user.id},
        version = version + 1 where id = ${id}`;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.count.reject", {
        resourceType: "InventoryCount", resourceId: id, reasonCode: "rejected", metadata: { reason: body.reason },
      }));
      return { status: "rejected" };
    }
    const lines = await tx`
      select cl.*, i.base_unit from inventory_count_lines cl
        join inventory_items i on i.id = cl.item_id
       where cl.count_id = ${id} order by cl.id
    `;
    let adjusted = 0;
    for (const line of lines) {
      const variance = numberValue(line.variance);
      if (Math.abs(variance) < 0.00005) continue;
      const movement = await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
        itemId: String(line.itemId), lotId: line.lotId ? String(line.lotId) : null,
        sourceLocationId: variance < 0 ? String(count.locationId) : null,
        destinationLocationId: variance > 0 ? String(count.locationId) : null,
        quantity: Math.abs(variance), unit: String(line.baseUnit), movementType: "count-adjustment",
        reason: `Count ${count.countNumber}: ${body.reason}`,
        referenceType: "inventory-count", referenceId: id, approverId: auth.user.id,
        allowIneligible: true,
      });
      await tx`update inventory_count_lines set adjustment_movement_id = ${movement.id} where id = ${line.id}`;
      adjusted += 1;
    }
    await tx`update inventory_counts set status = 'posted', approved_by = ${auth.user.id},
      posted_at = now(), version = version + 1 where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.count.post", {
      resourceType: "InventoryCount", resourceId: id,
      metadata: { countNumber: count.countNumber, adjustedLines: adjusted, reason: body.reason },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "inventory.count.posted", aggregateId: id, payload: { adjustedLines: adjusted } });
    return { status: "posted", adjustedLines: adjusted };
  });
  return c.json({ ok: true, ...result });
});

inventoryRoutes.get("/inventory/adjustments", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select a.id, a.adjustment_number, a.location_id, a.item_id, a.lot_id, a.quantity_delta::float8 as quantity_delta,
             a.unit, a.reason_code, a.reason, a.status, a.requested_by, a.approved_by, a.movement_id,
             a.version, a.created_at, l.name as location_name, i.name as item_name, i.base_unit,
             u.display_name as requested_by_name
        from inventory_adjustments a
        join inventory_locations l on l.id = a.location_id
        join inventory_items i on i.id = a.item_id
        left join users u on u.id = a.requested_by
       where a.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and a.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       order by a.created_at desc limit 300
    `;
  });
  return c.json({ adjustments: rows });
});

inventoryRoutes.post("/inventory/adjustments", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.adjust");
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryAdjustmentSchema);
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    await locationRow(tx, auth.activeTenant!.id, body.locationId);
    await itemRow(tx, auth.activeTenant!.id, body.itemId);
    await unitFactor(tx, auth.activeTenant!.id, body.itemId, body.unit);
    const adjustmentNumber = await nextReference(tx, auth.activeTenant!.id, "adjustment");
    await tx`
      insert into inventory_adjustments (id, tenant_id, adjustment_number, location_id, item_id, lot_id,
        quantity_delta, unit, reason_code, reason, status, requested_by)
      values (${id}, ${auth.activeTenant!.id}, ${adjustmentNumber}, ${body.locationId}, ${body.itemId},
        ${body.lotId ?? null}, ${body.quantityDelta}, ${body.unit}, ${body.reasonCode}, ${body.reason},
        'requested', ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.adjustment.request", {
      resourceType: "InventoryAdjustment", resourceId: id,
      metadata: { adjustmentNumber, quantityDelta: body.quantityDelta, reasonCode: body.reasonCode },
    }));
    return { id, adjustmentNumber };
  });
  return c.json({ ok: true, adjustment: result }, 201);
});

inventoryRoutes.post("/inventory/adjustments/:id/decision", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.adjust");
  requireRole(c, APPROVER_ROLES);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryAdjustmentDecisionSchema);
  const result = await withStaffActor(c, async (tx) => {
    const adjustment = await requireRows(await tx`
      select * from inventory_adjustments where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Adjustment not found");
    ensureMatch(body.expectedVersion, Number(adjustment.version));
    if (String(adjustment.status) !== "requested") throw new ConflictError("Only requested adjustments can be decided");
    if (String(adjustment.requestedBy) === auth.user.id) throw new ForbiddenError("An adjustment cannot be approved by its requester");
    if (body.decision === "reject") {
      await tx`update inventory_adjustments set status = 'rejected', approved_by = ${auth.user.id},
        version = version + 1, updated_at = now() where id = ${id}`;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.adjustment.reject", {
        resourceType: "InventoryAdjustment", resourceId: id, reasonCode: "rejected", metadata: { reason: body.reason },
      }));
      return { status: "rejected" };
    }
    const delta = numberValue(adjustment.quantityDelta);
    const movement = await postMovement(tx, auth.activeTenant!.id, auth.user.id, {
      itemId: String(adjustment.itemId), lotId: adjustment.lotId ? String(adjustment.lotId) : null,
      sourceLocationId: delta < 0 ? String(adjustment.locationId) : null,
      destinationLocationId: delta > 0 ? String(adjustment.locationId) : null,
      quantity: Math.abs(delta), unit: String(adjustment.unit), movementType: "adjustment",
      reason: `${adjustment.reasonCode}: ${body.reason}`, referenceType: "inventory-adjustment",
      referenceId: id, approverId: auth.user.id, allowIneligible: true,
    });
    await tx`update inventory_adjustments set status = 'posted', approved_by = ${auth.user.id},
      movement_id = ${movement.id}, version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.adjustment.post", {
      resourceType: "InventoryAdjustment", resourceId: id,
      metadata: { adjustmentNumber: adjustment.adjustmentNumber, movementId: movement.id, reason: body.reason },
    }));
    return { status: "posted", movementId: movement.id };
  });
  return c.json({ ok: true, ...result });
});

inventoryRoutes.get("/inventory/recalls", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select r.id, r.recall_number, r.item_id, r.lot_id, r.reason, r.status, r.initiated_by,
           r.acknowledged_by, r.acknowledged_at, r.notes, r.created_at, i.name as item_name, i.item_code,
           lt.lot_number, lt.expires_on, u.display_name as initiated_by_name,
           coalesce((select sum(b.on_hand)::float8 from inventory_balances b where b.item_id = r.item_id
             and (r.lot_id is null or b.lot_id = r.lot_id)), 0) as affected_quantity
      from inventory_recalls r
      join inventory_items i on i.id = r.item_id
      left join inventory_lots lt on lt.id = r.lot_id
      left join users u on u.id = r.initiated_by
     where r.tenant_id = ${auth.activeTenant!.id}
     order by r.created_at desc limit 200
  `);
  return c.json({ recalls: rows });
});

inventoryRoutes.post("/inventory/recalls", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.recall.manage");
  requireRole(c, ["facility_admin", "pharmacist", "quality"]);
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryRecallSchema);
  const id = crypto.randomUUID();
  const result = await withStaffActor(c, async (tx) => {
    await itemRow(tx, auth.activeTenant!.id, body.itemId);
    if (body.lotId) {
      const lot = await tx`select id from inventory_lots where id = ${body.lotId} and item_id = ${body.itemId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!lot[0]) throw new ValidationError("The recall lot does not belong to the selected item");
    }
    const recallNumber = await nextReference(tx, auth.activeTenant!.id, "recall");
    await tx`
      insert into inventory_recalls (id, tenant_id, recall_number, item_id, lot_id, reason, status,
        initiated_by, notes)
      values (${id}, ${auth.activeTenant!.id}, ${recallNumber}, ${body.itemId}, ${body.lotId ?? null},
        ${body.reason}, 'open', ${auth.user.id}, ${body.notes || null})
    `;
    if (body.lotId) {
      await tx`update inventory_lots set status = 'recalled', updated_at = now() where id = ${body.lotId}`;
    } else {
      await tx`update inventory_lots set status = 'recalled', updated_at = now()
        where tenant_id = ${auth.activeTenant!.id} and item_id = ${body.itemId} and status in ('available','quarantine')`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.recall.initiate", {
      resourceType: "InventoryRecall", resourceId: id,
      metadata: { recallNumber, itemId: body.itemId, lotId: body.lotId ?? null, reason: body.reason },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "inventory.recall.initiated", aggregateId: id, payload: { itemId: body.itemId, lotId: body.lotId ?? null } });
    return { id, recallNumber };
  });
  return c.json({ ok: true, recall: result }, 201);
});

inventoryRoutes.post("/inventory/recalls/:id/acknowledge", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const recall = await requireRows(await tx`
      select id, status from inventory_recalls where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Recall not found");
    if (String(recall.status) !== "open") throw new ConflictError("Only open recalls can be acknowledged");
    await tx`update inventory_recalls set status = 'acknowledged', acknowledged_by = ${auth.user.id},
      acknowledged_at = now(), updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.recall.acknowledge", {
      resourceType: "InventoryRecall", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.post("/inventory/recalls/:id/close", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.recall.manage");
  requireRole(c, ["facility_admin", "pharmacist", "quality"]);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const recall = await requireRows(await tx`
      select id, status from inventory_recalls where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Recall not found");
    if (String(recall.status) !== "acknowledged") throw new ConflictError("A recall must be acknowledged before it can be closed");
    await tx`update inventory_recalls set status = 'closed', updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.recall.close", {
      resourceType: "InventoryRecall", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});

inventoryRoutes.get("/inventory/assets", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.asset.read");
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    return tx`
      select a.id, a.item_id, a.asset_tag, a.name, a.manufacturer, a.model, a.serial_number,
             a.location_id, a.department_id, a.custodian_user_id, a.status, a.custody_status,
             a.acquisition_date, a.acquisition_cost::float8 as acquisition_cost, a.currency,
             a.warranty_ends_on, a.service_agreement, a.maintenance_interval_days, a.next_maintenance_on,
             a.next_calibration_on, a.commissioned_at, a.retired_at, a.version, a.notes, a.created_at,
             l.name as location_name, d.name as department_name, u.display_name as custodian_name,
             (current_date - a.next_maintenance_on) as maintenance_overdue_days
        from inventory_assets a
        left join inventory_locations l on l.id = a.location_id
        left join departments d on d.id = a.department_id
        left join users u on u.id = a.custodian_user_id
       where a.tenant_id = ${auth.activeTenant!.id}
         ${status ? tx`and a.status = ${status}` : tx``}
         ${scope.all ? tx`` : scope.ids.length ? tx`and (a.location_id = any(${tx.array(scope.ids)}::uuid[]) or a.location_id is null)` : tx`and a.location_id is null`}
       order by a.name limit 500
    `;
  });
  return c.json({ assets: rows });
});

inventoryRoutes.post("/inventory/assets", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.asset.manage");
  requireRole(c, TECHNICAL_ROLES);
  const auth = c.get("auth")!;
  const body = await parseJson(c, inventoryAssetSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    if (body.itemId) await itemRow(tx, auth.activeTenant!.id, body.itemId);
    if (body.locationId) await locationRow(tx, auth.activeTenant!.id, body.locationId);
    if (body.departmentId) {
      const department = await tx`select id from departments where id = ${body.departmentId} and tenant_id = ${auth.activeTenant!.id}`;
      if (!department[0]) throw new ValidationError("The department was not found");
    }
    await tx`
      insert into inventory_assets (id, tenant_id, item_id, asset_tag, name, manufacturer, model, serial_number,
        location_id, department_id, custodian_user_id, acquisition_date, acquisition_cost, currency,
        warranty_ends_on, service_agreement, maintenance_interval_days, next_maintenance_on,
        next_calibration_on, notes, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.itemId ?? null}, ${body.assetTag}, ${body.name},
        ${body.manufacturer || null}, ${body.model || null}, ${body.serialNumber || null},
        ${body.locationId ?? null}, ${body.departmentId ?? null}, ${body.custodianUserId ?? null},
        ${body.acquisitionDate ?? null}, ${body.acquisitionCost ?? null}, ${body.currency},
        ${body.warrantyEndsOn ?? null}, ${body.serviceAgreement || null}, ${body.maintenanceIntervalDays ?? null},
        ${body.nextMaintenanceOn ?? null}, ${body.nextCalibrationOn ?? null}, ${body.notes || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "inventory.asset.create", {
      resourceType: "InventoryAsset", resourceId: id, metadata: { assetTag: body.assetTag, name: body.name },
    }));
  });
  return c.json({ ok: true, asset: { id } }, 201);
});

inventoryRoutes.get("/inventory/assets/:id", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.asset.read");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const asset = await requireRows(await tx`
      select a.*, l.name as location_name, d.name as department_name, u.display_name as custodian_name
        from inventory_assets a
        left join inventory_locations l on l.id = a.location_id
        left join departments d on d.id = a.department_id
        left join users u on u.id = a.custodian_user_id
       where a.id = ${id} and a.tenant_id = ${auth.activeTenant!.id}
    `, "Asset not found");
    const events = await tx`
      select e.id, e.event_type, e.from_status, e.to_status, e.from_custody, e.to_custody, e.note,
             e.occurred_at, u.display_name as performed_by_name
        from inventory_asset_events e left join users u on u.id = e.performed_by
       where e.asset_id = ${id} order by e.occurred_at desc
    `;
    return { asset, events };
  });
  return c.json(data);
});

inventoryRoutes.post("/inventory/assets/:id/events", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.asset.manage");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, inventoryAssetEventSchema);
  const result = await withStaffActor(c, async (tx) => {
    const asset = await requireRows(await tx`
      select * from inventory_assets where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Asset not found");
    ensureMatch(body.expectedVersion, Number(asset.version));
    const current = String(asset.status);
    const technical = hasAnyRole(c, TECHNICAL_ROLES);
    if (["commission", "service-release", "calibration"].includes(body.eventType) && !technical) {
      throw new ForbiddenError("This asset action requires biomedical or facility administration authority");
    }
    const allowed: Record<string, { from: string[]; to: string }> = {
      commission: { from: ["pending-commissioning"], to: "in-service" },
      "service-release": { from: ["under-maintenance", "out-of-service"], to: "in-service" },
      maintenance: { from: ["in-service", "under-maintenance", "out-of-service"], to: "under-maintenance" },
      calibration: { from: [current], to: current },
      fault: { from: ["in-service", "under-maintenance", "reserved"], to: "out-of-service" },
      retirement: { from: ["pending-commissioning", "in-service", "reserved", "under-maintenance", "out-of-service"], to: "retired" },
      assignment: { from: [current], to: current },
      transfer: { from: [current], to: current },
      loan: { from: [current], to: current },
    };
    const rule = allowed[body.eventType];
    if (!rule) throw new ValidationError("Unsupported asset event");
    if (!rule.from.includes(current)) throw new ConflictError(`Cannot apply ${body.eventType} to an asset that is ${current}`);
    if (body.toStatus !== rule.to) throw new ValidationError(`A ${body.eventType} event must move the asset to ${rule.to}`);
    if (body.locationId) await locationRow(tx, auth.activeTenant!.id, body.locationId);
    await tx`
      insert into inventory_asset_events (id, tenant_id, asset_id, event_type, from_status, to_status,
        from_custody, to_custody, note, performed_by)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.eventType}, ${current},
        ${body.toStatus}, ${asset.custodyStatus}, ${body.toCustody ?? asset.custodyStatus}, ${body.note}, ${auth.user.id})
    `;
    await tx`
      update inventory_assets set status = ${body.toStatus},
        custody_status = coalesce(${body.toCustody ?? null}, custody_status),
        location_id = coalesce(${body.locationId ?? null}, location_id),
        custodian_user_id = coalesce(${body.custodianUserId ?? null}, custodian_user_id),
        next_maintenance_on = coalesce(${body.nextMaintenanceOn ?? null}, next_maintenance_on),
        next_calibration_on = coalesce(${body.nextCalibrationOn ?? null}, next_calibration_on),
        commissioned_at = case when ${body.eventType} = 'commission' then now() else commissioned_at end,
        commissioned_by = case when ${body.eventType} = 'commission' then ${auth.user.id}::uuid else commissioned_by end,
        retired_at = case when ${body.eventType} = 'retirement' then now() else retired_at end,
        version = version + 1, updated_at = now()
      where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `inventory.asset.${body.eventType}`, {
      resourceType: "InventoryAsset", resourceId: id,
      metadata: { assetTag: asset.assetTag, from: current, to: body.toStatus, note: body.note },
    }));
    return { status: body.toStatus, version: Number(asset.version) + 1 };
  });
  return c.json({ ok: true, asset: result });
});

inventoryRoutes.get("/inventory/reports/stock-on-hand", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const locationId = c.req.query("locationId");
  const itemId = c.req.query("itemId");
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select i.item_code, i.name as item_name, i.category, i.base_unit, i.criticality,
             l.code as location_code, l.name as location_name, l.location_type,
             lt.lot_number, lt.expires_on, lt.status as lot_status,
             b.on_hand::float8 as on_hand, b.reserved::float8 as reserved,
             b.quarantined::float8 as quarantined,
             (b.on_hand - b.reserved - b.quarantined)::float8 as available,
             round((b.on_hand * i.unit_cost)::numeric, 2)::float8 as value, i.currency
        from inventory_balances b
        join inventory_items i on i.id = b.item_id
        join inventory_locations l on l.id = b.location_id
        left join inventory_lots lt on lt.id = b.lot_id
       where b.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and b.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
         ${locationId ? tx`and b.location_id = ${locationId}` : tx``}
         ${itemId ? tx`and b.item_id = ${itemId}` : tx``}
       order by i.name, l.name, lt.expires_on asc nulls last
    `;
    const exported = await reportResponse(c, tx, "stock-on-hand", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/low-stock", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select p.id, l.code as location_code, l.name as location_name, i.item_code, i.name as item_name,
             i.base_unit, p.minimum_quantity::float8 as minimum_quantity, p.reorder_quantity::float8 as reorder_quantity,
             p.maximum_quantity::float8 as maximum_quantity, p.criticality,
             coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0)::float8 as available,
             case when coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0) <= 0 then 'stock-out'
                  when coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0) < p.minimum_quantity then 'below-minimum'
                  else 'reorder' end as alert
        from inventory_location_policies p
        join inventory_locations l on l.id = p.location_id
        join inventory_items i on i.id = p.item_id
        left join inventory_balances b on b.location_id = p.location_id and b.item_id = p.item_id
       where p.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and p.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       group by p.id, l.code, l.name, i.item_code, i.name, i.base_unit
      having coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0) <
             greatest(p.minimum_quantity, case when p.reorder_quantity > 0 then p.reorder_quantity else p.minimum_quantity end)
       order by p.criticality desc, alert, i.name
    `;
    const exported = await reportResponse(c, tx, "low-stock", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/expiry", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select i.item_code, i.name as item_name, i.base_unit, lt.lot_number, lt.expires_on, lt.status,
             (lt.expires_on - current_date) as days_to_expiry,
             l.code as location_code, l.name as location_name,
             coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0)::float8 as available,
             case when lt.expires_on < current_date then 'expired'
                  when lt.expires_on <= current_date + 30 then 'within-30-days'
                  when lt.expires_on <= current_date + 90 then 'within-90-days'
                  else 'later' end as expiry_band
        from inventory_lots lt
        join inventory_items i on i.id = lt.item_id
        left join inventory_balances b on b.lot_id = lt.id
        left join inventory_locations l on l.id = b.location_id
       where lt.tenant_id = ${auth.activeTenant!.id}
         and lt.expires_on is not null
         and lt.status in ('available','quarantine','expired')
         ${scope.all ? tx`` : scope.ids.length ? tx`and (b.location_id = any(${tx.array(scope.ids)}::uuid[]) or b.location_id is null)` : tx`and b.location_id is null`}
       group by i.item_code, i.name, i.base_unit, lt.id, l.code, l.name
      having coalesce(sum(b.on_hand - b.reserved - b.quarantined), 0) > 0 or lt.status = 'expired'
       order by lt.expires_on asc
    `;
    const exported = await reportResponse(c, tx, "expiry", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/consumption", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select date_trunc('month', m.occurred_at)::date as month, i.item_code, i.name as item_name, i.base_unit,
             l.code as location_code, l.name as location_name, m.movement_type,
             sum(m.base_quantity)::float8 as quantity, count(*)::int as movement_count,
             round(sum(m.base_quantity * i.unit_cost)::numeric, 2)::float8 as value, i.currency
        from inventory_movements m
        join inventory_items i on i.id = m.item_id
        join inventory_locations l on l.id = m.source_location_id
       where m.tenant_id = ${auth.activeTenant!.id}
         and m.occurred_at >= current_date - interval '90 days'
         and m.movement_type in ('issue','consumption','write-off','transfer-out')
         ${scope.all ? tx`` : scope.ids.length ? tx`and m.source_location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       group by month, i.item_code, i.name, i.base_unit, l.code, l.name, m.movement_type, i.currency
       order by month desc, quantity desc
    `;
    const exported = await reportResponse(c, tx, "consumption", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/valuation", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select i.item_code, i.name as item_name, i.category, i.base_unit, i.currency,
             coalesce(sum(b.on_hand), 0)::float8 as on_hand,
             i.unit_cost::float8 as unit_cost,
             round((coalesce(sum(b.on_hand), 0) * i.unit_cost)::numeric, 2)::float8 as value
        from inventory_items i
        left join inventory_balances b on b.item_id = i.id
          ${scope.all ? tx`` : scope.ids.length ? tx`and b.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       where i.tenant_id = ${auth.activeTenant!.id} and i.status = 'active'
       group by i.id, i.currency
       order by value desc
    `;
    const exported = await reportResponse(c, tx, "valuation", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/requisition-fulfilment", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select r.status, count(*)::int as requisitions,
             coalesce(sum((select sum(l.requested_quantity) from inventory_requisition_lines l where l.requisition_id = r.id)), 0)::float8 as requested,
             coalesce(sum((select sum(l.approved_quantity) from inventory_requisition_lines l where l.requisition_id = r.id)), 0)::float8 as approved,
             coalesce(sum((select sum(l.issued_quantity) from inventory_requisition_lines l where l.requisition_id = r.id)), 0)::float8 as issued,
             round(avg(extract(epoch from (coalesce(r.approved_at, now()) - r.created_at)) / 3600)::numeric, 2)::float8 as average_approval_hours
        from inventory_requisitions r
       where r.tenant_id = ${auth.activeTenant!.id}
         ${scope.all ? tx`` : scope.ids.length ? tx`and (r.requesting_location_id = any(${tx.array(scope.ids)}::uuid[]) or r.fulfilling_location_id = any(${tx.array(scope.ids)}::uuid[]))` : tx`and false`}
       group by r.status order by r.status
    `;
    const exported = await reportResponse(c, tx, "requisition-fulfilment", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/transfer-discrepancies", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select t.transfer_number, t.status, t.dispatched_at, t.received_at, t.discrepancy_note,
             sl.name as source_location_name, dl.name as destination_location_name,
             i.item_code, i.name as item_name, l.unit, l.dispatched_quantity::float8 as dispatched_quantity,
             l.received_quantity::float8 as received_quantity, l.rejected_quantity::float8 as rejected_quantity,
             l.discrepancy_reason
        from inventory_transfer_lines l
        join inventory_transfers t on t.id = l.transfer_id
        join inventory_locations sl on sl.id = t.source_location_id
        join inventory_locations dl on dl.id = t.destination_location_id
        join inventory_items i on i.id = l.item_id
       where t.tenant_id = ${auth.activeTenant!.id} and l.rejected_quantity > 0
         ${scope.all ? tx`` : scope.ids.length ? tx`and (t.source_location_id = any(${tx.array(scope.ids)}::uuid[]) or t.destination_location_id = any(${tx.array(scope.ids)}::uuid[]))` : tx`and false`}
       order by t.received_at desc nulls last
    `;
    const exported = await reportResponse(c, tx, "transfer-discrepancies", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/count-variance", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select k.count_number, k.posted_at, l.code as location_code, l.name as location_name,
             i.item_code, i.name as item_name, lt.lot_number, i.base_unit,
             cl.snapshot_quantity::float8 as snapshot_quantity, cl.counted_quantity::float8 as counted_quantity,
             cl.variance::float8 as variance, cl.reason_code, u.display_name as counted_by_name
        from inventory_count_lines cl
        join inventory_counts k on k.id = cl.count_id
        join inventory_locations l on l.id = k.location_id
        join inventory_items i on i.id = cl.item_id
        left join inventory_lots lt on lt.id = cl.lot_id
        left join users u on u.id = k.counted_by
       where k.tenant_id = ${auth.activeTenant!.id} and k.status = 'posted' and coalesce(cl.variance, 0) <> 0
         ${scope.all ? tx`` : scope.ids.length ? tx`and k.location_id = any(${tx.array(scope.ids)}::uuid[])` : tx`and false`}
       order by k.posted_at desc, abs(cl.variance) desc
    `;
    const exported = await reportResponse(c, tx, "count-variance", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/asset-downtime", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select a.asset_tag, a.name, a.status, a.custody_status, a.manufacturer, a.model, a.serial_number,
             l.name as location_name, d.name as department_name,
             (select max(e.occurred_at) from inventory_asset_events e where e.asset_id = a.id and e.event_type in ('fault','maintenance')) as downtime_since,
             (select e.note from inventory_asset_events e where e.asset_id = a.id and e.event_type in ('fault','maintenance') order by e.occurred_at desc limit 1) as downtime_reason,
             (select count(*)::int from inventory_asset_events e where e.asset_id = a.id and e.event_type in ('fault','maintenance','calibration')) as service_events
        from inventory_assets a
        left join inventory_locations l on l.id = a.location_id
        left join departments d on d.id = a.department_id
       where a.tenant_id = ${auth.activeTenant!.id} and a.status in ('out-of-service','under-maintenance')
         ${scope.all ? tx`` : scope.ids.length ? tx`and (a.location_id = any(${tx.array(scope.ids)}::uuid[]) or a.location_id is null)` : tx`and a.location_id is null`}
       order by downtime_since asc nulls last
    `;
    const exported = await reportResponse(c, tx, "asset-downtime", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/maintenance-due", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const scope = await locationScope(tx, c, auth.activeTenant!.id, auth.user.id);
    const rows = await tx`
      select a.asset_tag, a.name, a.status, a.next_maintenance_on, a.next_calibration_on,
             a.maintenance_interval_days, l.name as location_name, d.name as department_name,
             u.display_name as custodian_name,
             (a.next_maintenance_on - current_date) as maintenance_days,
             (a.next_calibration_on - current_date) as calibration_days
        from inventory_assets a
        left join inventory_locations l on l.id = a.location_id
        left join departments d on d.id = a.department_id
        left join users u on u.id = a.custodian_user_id
       where a.tenant_id = ${auth.activeTenant!.id}
         and a.status <> 'retired'
         and (a.next_maintenance_on <= current_date + 30 or a.next_calibration_on <= current_date + 30)
         ${scope.all ? tx`` : scope.ids.length ? tx`and (a.location_id = any(${tx.array(scope.ids)}::uuid[]) or a.location_id is null)` : tx`and a.location_id is null`}
       order by least(coalesce(a.next_maintenance_on, '9999-12-31'::date), coalesce(a.next_calibration_on, '9999-12-31'::date))
    `;
    const exported = await reportResponse(c, tx, "maintenance-due", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});

inventoryRoutes.get("/inventory/reports/recall-status", async (c) => {
  requireStaff(c);
  requirePermission(c, "inventory.report.read");
  const auth = c.get("auth")!;
  const result = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select r.recall_number, r.status, r.reason, r.notes, r.created_at, r.acknowledged_at,
             i.item_code, i.name as item_name, lt.lot_number, lt.expires_on,
             u.display_name as initiated_by_name,
             coalesce((select sum(b.on_hand)::float8 from inventory_balances b where b.item_id = r.item_id
               and (r.lot_id is null or b.lot_id = r.lot_id)), 0) as affected_quantity
        from inventory_recalls r
        join inventory_items i on i.id = r.item_id
        left join inventory_lots lt on lt.id = r.lot_id
        left join users u on u.id = r.initiated_by
       where r.tenant_id = ${auth.activeTenant!.id} and r.status <> 'closed'
       order by r.created_at desc
    `;
    const exported = await reportResponse(c, tx, "recall-status", rows as Record<string, unknown>[]);
    return { rows, exported };
  });
  if (result.exported) return result.exported;
  return c.json({ report: result.rows });
});
