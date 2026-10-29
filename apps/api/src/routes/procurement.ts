import { Hono, type Context } from "hono";
import {
  purchaseOrderActionSchema,
  purchaseOrderReceiveSchema,
  purchaseOrderSchema,
  supplierSchema,
  supplierStatusSchema,
  uuidSchema,
} from "@medveris/contracts";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { uniqueViolation } from "../lib/idempotency.js";
import { actorScope, assertDepartmentInScope, assertLocationInScope } from "../lib/scope.js";
import { itemRow, locationRow, postMovement, unitFactor } from "./inventory.js";
import type { AppEnv } from "../types.js";

/** Supplier records and purchase orders for each workspace; receipts post to the workspace's own stock ledger. */
export const procurementRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

function requirePermission(c: C, permission: Permission): void {
  if (!permissionsForRoles(requestActor(c).roles).has(permission)) throw new ForbiddenError(`This action requires ${permission}`);
}

async function nextPoNumber(tx: Tx, tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx`select pg_advisory_xact_lock(hashtext(${`procurement:po:${tenantId}:${year}`}))`;
  const [row] = await tx`select count(*)::int as n from purchase_orders where tenant_id = ${tenantId} and po_number like ${`PO-${year}-%`}`;
  return `PO-${year}-${String(Number(row?.n ?? 0) + 1).padStart(5, "0")}`;
}

procurementRoutes.get("/procurement/suppliers", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.catalogue.read");
  const rows = await withStaffActor(c, async (tx) => tx`
    select id, code, name, contact_name, phone, email, address, tax_id, licence_reference, status, notes, created_at
      from suppliers where tenant_id = ${auth.activeTenant!.id} order by status, name`);
  return c.json({ suppliers: rows });
});

procurementRoutes.post("/procurement/suppliers", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.procurement.manage");
  const body = await parseJson(c, supplierSchema);
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      await tx`
        insert into suppliers (id, tenant_id, code, name, contact_name, phone, email, address, tax_id, licence_reference, notes, created_by)
        values (${id}, ${auth.activeTenant!.id}, ${body.code}, ${body.name}, ${body.contactName || null}, ${body.phone || null},
          ${body.email || null}, ${body.address || null}, ${body.taxId || null}, ${body.licenceReference || null}, ${body.notes || null}, ${auth.user.id})`;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "procurement.supplier.create", { resourceType: "Supplier", resourceId: id, metadata: { code: body.code } }));
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new ConflictError(`Supplier code ${body.code} is already used in this workspace`);
    throw error;
  }
  return c.json({ ok: true, id }, 201);
});

procurementRoutes.post("/procurement/suppliers/:id/status", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.procurement.manage");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, supplierStatusSchema);
  await withStaffActor(c, async (tx) => {
    const rows = await tx`update suppliers set status = ${body.status}, updated_at = now() where id = ${id} and tenant_id = ${auth.activeTenant!.id} returning id`;
    if (!rows[0]) throw new NotFoundError("Supplier not found");
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "procurement.supplier.status", { resourceType: "Supplier", resourceId: id, metadata: { status: body.status } }));
  });
  return c.json({ ok: true });
});

procurementRoutes.get("/procurement/purchase-orders", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const rows = await withStaffActor(c, async (tx) => {
    const scope = await actorScope(tx, c);
    return tx`
      select po.id, po.po_number, po.status, po.currency, po.expected_on, po.created_at, po.approved_at, po.version,
             s.name as supplier_name, l.name as location_name, d.name as department_name, u.name as unit_name,
             (select coalesce(sum(line.quantity_ordered * line.unit_price), 0) from purchase_order_lines line where line.purchase_order_id = po.id) as total_amount,
             (select count(*)::int from purchase_order_lines line where line.purchase_order_id = po.id) as line_count
        from purchase_orders po
        join suppliers s on s.id = po.supplier_id
        join inventory_locations l on l.id = po.destination_location_id
        left join departments d on d.id = po.department_id
        left join units u on u.id = po.unit_id
       where po.tenant_id = ${auth.activeTenant!.id}
         and (${scope.kind === "workspace"} or po.department_id = ${scope.kind === "workspace" ? null : scope.departmentId}::uuid)
       order by po.created_at desc limit 200`;
  });
  return c.json({ purchaseOrders: rows });
});

async function loadOrder(tx: Tx, tenantId: string, id: string, lock = false) {
  const order = await requireRows(lock
    ? await tx`select * from purchase_orders where id = ${id} and tenant_id = ${tenantId} for update`
    : await tx`select * from purchase_orders where id = ${id} and tenant_id = ${tenantId}`, "Purchase order not found");
  const lines = await tx`
    select line.id, line.item_id, line.unit, line.quantity_ordered, line.unit_price, line.quantity_received,
           i.item_code, i.name as item_name, i.lot_tracked, i.expiry_tracked
      from purchase_order_lines line join inventory_items i on i.id = line.item_id
     where line.purchase_order_id = ${id} order by line.created_at, line.id`;
  return { order, lines };
}

procurementRoutes.get("/procurement/purchase-orders/:id", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.stock.read");
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const loaded = await loadOrder(tx, auth.activeTenant!.id, id);
    const receipts = await tx`
      select m.id, m.quantity, m.unit, m.occurred_at, i.name as item_name, l.lot_number, u.display_name as actor_name
        from inventory_movements m join inventory_items i on i.id = m.item_id
        left join inventory_lots l on l.id = m.lot_id join users u on u.id = m.actor_id
       where m.tenant_id = ${auth.activeTenant!.id} and m.reference_type = 'purchase-order' and m.reference_id = ${loaded.order.poNumber}
       order by m.occurred_at`;
    return { ...loaded, receipts };
  });
  return c.json(data);
});

procurementRoutes.post("/procurement/purchase-orders", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.procurement.manage");
  const body = await parseJson(c, purchaseOrderSchema);
  const tenantId = auth.activeTenant!.id;
  const id = crypto.randomUUID();
  const poNumber = await withStaffActor(c, async (tx) => {
    const [supplier] = await tx`select status from suppliers where id = ${body.supplierId} and tenant_id = ${tenantId}`;
    if (!supplier) throw new ValidationError("Supplier not found in this workspace");
    if (supplier.status !== "active") throw new ConflictError("This supplier is inactive");
    await locationRow(tx, tenantId, body.destinationLocationId);
    await assertLocationInScope(tx, c, body.destinationLocationId);
    await assertDepartmentInScope(tx, c, body.departmentId, body.unitId);
    for (const line of body.lines) {
      await itemRow(tx, tenantId, line.itemId);
      await unitFactor(tx, tenantId, line.itemId, line.unit);
    }
    const number = await nextPoNumber(tx, tenantId);
    await tx`
      insert into purchase_orders (id, tenant_id, po_number, supplier_id, department_id, unit_id, destination_location_id, currency, expected_on, notes, created_by)
      values (${id}, ${tenantId}, ${number}, ${body.supplierId}, ${body.departmentId ?? null}, ${body.unitId ?? null}, ${body.destinationLocationId},
        ${body.currency}, ${body.expectedOn || null}, ${body.notes || null}, ${auth.user.id})`;
    for (const line of body.lines) {
      await tx`
        insert into purchase_order_lines (id, tenant_id, purchase_order_id, item_id, unit, quantity_ordered, unit_price)
        values (${crypto.randomUUID()}, ${tenantId}, ${id}, ${line.itemId}, ${line.unit}, ${line.quantity}, ${line.unitPrice})`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "procurement.purchase-order.create", {
      resourceType: "PurchaseOrder", resourceId: id, metadata: { poNumber: number, lines: body.lines.length, supplierId: body.supplierId },
    }));
    return number;
  });
  return c.json({ ok: true, purchaseOrder: { id, poNumber, status: "draft", version: 1 } }, 201);
});

procurementRoutes.post("/procurement/purchase-orders/:id/action", async (c) => {
  const auth = requireStaff(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, purchaseOrderActionSchema);
  requirePermission(c, body.action === "approve" ? "inventory.procurement.approve" : "inventory.procurement.manage");
  const tenantId = auth.activeTenant!.id;
  const status = await withStaffActor(c, async (tx) => {
    const { order } = await loadOrder(tx, tenantId, id, true);
    ensureMatch(body.expectedVersion, Number(order.version));
    await assertLocationInScope(tx, c, String(order.destinationLocationId));
    let next: string;
    if (body.action === "submit") {
      if (order.status !== "draft") throw new ConflictError(`A ${order.status} purchase order cannot be submitted`);
      next = "submitted";
      await tx`update purchase_orders set status = 'submitted', submitted_by = ${auth.user.id}, submitted_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
    } else if (body.action === "approve") {
      if (order.status !== "submitted") throw new ConflictError("Only a submitted purchase order can be approved");
      next = "approved";
      await tx`update purchase_orders set status = 'approved', approved_by = ${auth.user.id}, approved_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
    } else {
      if (!["draft", "submitted", "approved"].includes(String(order.status))) throw new ConflictError(`A ${order.status} purchase order cannot be cancelled`);
      if (!body.reason) throw new ValidationError("A reason is required to cancel a purchase order");
      next = "cancelled";
      await tx`update purchase_orders set status = 'cancelled', cancelled_by = ${auth.user.id}, cancelled_at = now(), cancel_reason = ${body.reason}, version = version + 1, updated_at = now() where id = ${id}`;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `procurement.purchase-order.${body.action}`, {
      resourceType: "PurchaseOrder", resourceId: id,
      metadata: { poNumber: order.poNumber, from: order.status, to: next, sameApprover: body.action === "approve" && order.createdBy === auth.user.id },
    }));
    return next;
  });
  return c.json({ ok: true, status });
});

procurementRoutes.post("/procurement/purchase-orders/:id/receive", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "inventory.stock.receive");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, purchaseOrderReceiveSchema);
  const tenantId = auth.activeTenant!.id;
  const result = await withStaffActor(c, async (tx) => {
    const { order, lines } = await loadOrder(tx, tenantId, id, true);
    ensureMatch(body.expectedVersion, Number(order.version));
    if (!["approved", "partially-received"].includes(String(order.status))) throw new ConflictError("Only an approved purchase order can be received");
    await assertLocationInScope(tx, c, String(order.destinationLocationId));
    const [supplier] = await tx`select name from suppliers where id = ${order.supplierId}`;
    const movements: string[] = [];
    for (const input of body.lines) {
      const line = lines.find((candidate) => candidate.id === input.lineId);
      if (!line) throw new ValidationError("A received line does not belong to this purchase order");
      const outstanding = Number(line.quantityOrdered) - Number(line.quantityReceived);
      if (input.quantity - outstanding > 0.00005) throw new ConflictError(`${line.itemName}: only ${outstanding} ${line.unit} remain outstanding`);
      if (line.lotTracked && !input.lotNumber) throw new ValidationError(`${line.itemName} is lot tracked; enter the lot number`);
      if (line.expiryTracked && !input.expiresOn) throw new ValidationError(`${line.itemName} is expiry tracked; enter the expiry date`);
      let lotId: string | null = null;
      if (line.lotTracked && input.lotNumber) {
        const [existing] = await tx`select id, status from inventory_lots where tenant_id = ${tenantId} and item_id = ${line.itemId} and lot_number = ${input.lotNumber}`;
        if (existing?.status === "recalled") throw new ConflictError(`Lot ${input.lotNumber} is under recall and cannot be received`);
        lotId = existing ? String(existing.id) : crypto.randomUUID();
        if (!existing) {
          await tx`
            insert into inventory_lots (id, tenant_id, item_id, lot_number, manufacture_on, expires_on, supplier, receipt_reference, status, created_by)
            values (${lotId}, ${tenantId}, ${line.itemId}, ${input.lotNumber}, ${input.manufactureOn || null}, ${input.expiresOn || null},
              ${supplier?.name ?? null}, ${order.poNumber}, 'available', ${auth.user.id})`;
        }
      }
      const movement = await postMovement(tx, tenantId, auth.user.id, {
        itemId: String(line.itemId), lotId, destinationLocationId: String(order.destinationLocationId), quantity: input.quantity, unit: String(line.unit),
        movementType: "receipt", reason: body.reason, referenceType: "purchase-order", referenceId: String(order.poNumber),
      });
      movements.push(movement.id);
      await tx`update purchase_order_lines set quantity_received = quantity_received + ${input.quantity} where id = ${line.id}`;
    }
    const [remaining] = await tx`
      select count(*)::int as n from purchase_order_lines where purchase_order_id = ${id} and quantity_received < quantity_ordered`;
    const status = Number(remaining?.n ?? 0) === 0 ? "received" : "partially-received";
    await tx`update purchase_orders set status = ${status}, version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "procurement.purchase-order.receive", {
      resourceType: "PurchaseOrder", resourceId: id, metadata: { poNumber: order.poNumber, lines: body.lines.length, status },
    }));
    await writeOutbox(tx, { tenantId, eventType: "inventory.stock.received", aggregateId: id, payload: { purchaseOrder: order.poNumber } });
    return { status, movements, version: Number(order.version) + 1 };
  });
  return c.json({ ok: true, ...result });
});
