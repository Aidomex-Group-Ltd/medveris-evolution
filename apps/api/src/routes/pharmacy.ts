import { Hono } from "hono";
import {
  administrationSchema,
  dispenseSchema,
  medicineSchema,
  medicationOrderSchema,
  medicationReviewSchema,
  stockLotSchema,
  stockMovementSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertMembershipAdmin } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const pharmacyRoutes = new Hono<AppEnv>();

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function requirePharmacyRead(c: Parameters<typeof requireStaff>[0]): void {
  if (!hasRole(c, "clinician", "nurse", "pharmacist", "facility_admin")) throw new ForbiddenError("Pharmacy access is required");
}

pharmacyRoutes.get("/medicines", async (c) => {
  requireStaff(c);
  requirePharmacyRead(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select m.*, (select coalesce(sum(l.quantity), 0) from stock_lots l where l.medicine_id = m.id) as stock_quantity
      from medicines m where m.tenant_id = ${auth.activeTenant!.id} order by m.name
  `);
  return c.json({ medicines: rows });
});

pharmacyRoutes.post("/medicines", async (c) => {
  requireStaff(c);
  assertMembershipAdmin(requestActor(c));
  if (!hasRole(c, "pharmacist", "facility_admin")) throw new ForbiddenError("The pharmacy role is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, medicineSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into medicines (id, tenant_id, name, strength, form, route, code_system, code_version, code, knowledge_source, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.name}, ${body.strength}, ${body.form}, ${body.route},
        ${body.codeSystem || null}, ${body.codeVersion || null}, ${body.code || null}, ${body.knowledgeSource || null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "medicine.create", {
      resourceType: "Medicine", resourceId: id,
      metadata: { code: body.code ?? null, codeSystem: body.codeSystem ?? null, hasKnowledgeSource: Boolean(body.knowledgeSource) },
    }));
  });
  return c.json({ ok: true, medicine: { id } }, 201);
});

pharmacyRoutes.get("/medication-orders", async (c) => {
  requireStaff(c);
  requirePharmacyRead(c);
  const auth = c.get("auth")!;
  const status = c.req.query("status");
  const rows = await withStaffActor(c, async (tx) => tx`
    select mo.*, p.public_id, p.given_name, p.family_name, m.name as medicine_name, m.strength, m.form,
           u.display_name as ordered_by_name,
           (select row_to_json(r) from medication_order_reviews r where r.order_id = mo.id order by r.created_at desc limit 1) as latest_review
      from medication_orders mo join patients p on p.id = mo.patient_id join medicines m on m.id = mo.medicine_id
      join users u on u.id = mo.ordered_by
     where mo.tenant_id = ${auth.activeTenant!.id}
       ${status ? tx`and mo.status = ${status}` : tx``}
     order by mo.created_at desc limit 200
  `);
  return c.json({ orders: rows });
});

pharmacyRoutes.post("/medication-orders", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "clinician", "nurse")) throw new ForbiddenError("Only clinical staff may order medication");
  const auth = c.get("auth")!;
  const body = await parseJson(c, medicationOrderSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const encounter = await requireRows(await tx`
      select id, patient_id from encounters where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id}
    `, "Encounter not found");
    if (String(encounter.patientId) !== body.patientId) throw new ValidationError("Encounter does not belong to the selected patient");
    const medicine = await tx`select 1 from medicines where id = ${body.medicineId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!medicine[0]) throw new ValidationError("The selected medicine does not exist");
    await tx`
      insert into medication_orders (id, tenant_id, patient_id, encounter_id, medicine_id, dose_text, route, frequency, duration_days, ordered_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId}, ${body.medicineId},
        ${body.doseText}, ${body.route}, ${body.frequency}, ${body.durationDays ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "medication.order.create", {
      subjectPatientId: body.patientId, resourceType: "MedicationOrder", resourceId: id,
      metadata: { medicineId: body.medicineId, status: "pending-review" },
    }));
  });
  return c.json({ ok: true, order: { id } }, 201);
});

pharmacyRoutes.post("/medication-orders/:id/review", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "pharmacist")) throw new ForbiddenError("Medication review requires the pharmacist role");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, medicationReviewSchema);
  await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select id, patient_id, status from medication_orders where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Medication order not found");
    if (order.status !== "pending-review") throw new ConflictError("Only orders pending review can be reviewed");
    await tx`
      insert into medication_order_reviews (id, tenant_id, order_id, decision, note, pharmacist_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.decision}, ${body.note}, ${auth.user.id})
    `;
    await tx`
      update medication_orders set status = ${body.decision === "approved" ? "approved" : "rejected"}, version = version + 1, updated_at = now()
       where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `medication.order.${body.decision}`, {
      subjectPatientId: String(order.patientId), resourceType: "MedicationOrder", resourceId: id,
      metadata: { note: body.note },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: `medication.order.${body.decision}`, aggregateId: id });
  });
  return c.json({ ok: true });
});

pharmacyRoutes.get("/stock/lots", async (c) => {
  requireStaff(c);
  requirePharmacyRead(c);
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select l.*, m.name as medicine_name, m.strength, m.form,
           (l.expires_on < current_date) as expired
      from stock_lots l join medicines m on m.id = l.medicine_id
     where l.tenant_id = ${auth.activeTenant!.id} order by l.expires_on, m.name
  `);
  return c.json({ lots: rows });
});

pharmacyRoutes.post("/stock/lots", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "pharmacist")) throw new ForbiddenError("Stock receipt requires the pharmacist role");
  const auth = c.get("auth")!;
  const body = await parseJson(c, stockLotSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const medicine = await tx`select 1 from medicines where id = ${body.medicineId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!medicine[0]) throw new ValidationError("The selected medicine does not exist");
    if (new Date(`${body.expiresOn}T00:00:00Z`) <= new Date()) throw new ValidationError("An expired stock lot cannot be received");
    await tx`
      insert into stock_lots (id, tenant_id, medicine_id, lot_number, expires_on, quantity, location)
      values (${id}, ${auth.activeTenant!.id}, ${body.medicineId}, ${body.lotNumber}, ${body.expiresOn}, ${body.quantity}, ${body.location})
    `;
    await tx`
      insert into stock_movements (id, tenant_id, lot_id, delta, reason, actor_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.quantity}, 'Initial stock receipt', ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "stock.lot.receive", {
      resourceType: "StockLot", resourceId: id, metadata: { lotNumber: body.lotNumber, quantity: body.quantity },
    }));
  });
  return c.json({ ok: true, lot: { id } }, 201);
});

pharmacyRoutes.post("/stock/movements", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "pharmacist")) throw new ForbiddenError("Stock adjustment requires the pharmacist role");
  const auth = c.get("auth")!;
  const body = await parseJson(c, stockMovementSchema);
  const movementId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const lot = await requireRows(await tx`
      select id, quantity from stock_lots where id = ${body.lotId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Stock lot not found");
    const next = Number(lot.quantity) + body.delta;
    if (next < 0) throw new ConflictError("The stock movement would result in negative stock");
    await tx`update stock_lots set quantity = ${next}, version = version + 1, updated_at = now() where id = ${body.lotId}`;
    await tx`
      insert into stock_movements (id, tenant_id, lot_id, delta, reason, actor_id)
      values (${movementId}, ${auth.activeTenant!.id}, ${body.lotId}, ${body.delta}, ${body.reason}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "stock.movement.create", {
      resourceType: "StockLot", resourceId: body.lotId, metadata: { delta: body.delta, reason: body.reason },
    }));
  });
  return c.json({ ok: true, movement: { id: movementId } }, 201);
});

pharmacyRoutes.post("/dispenses", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "pharmacist")) throw new ForbiddenError("Dispensing requires the pharmacist role");
  const auth = c.get("auth")!;
  const body = await parseJson(c, dispenseSchema);
  const dispenseId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select id, patient_id, medicine_id, status from medication_orders
       where id = ${body.orderId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Medication order not found");
    if (!["approved", "active"].includes(String(order.status))) throw new ConflictError("Only approved medication orders can be dispensed");
    const lot = await requireRows(await tx`
      select id, medicine_id, quantity, expires_on from stock_lots
       where id = ${body.lotId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Stock lot not found");
    if (String(lot.medicineId) !== String(order.medicineId)) throw new ValidationError("The stock lot does not match the ordered medicine");
    if (new Date(`${String(lot.expiresOn).slice(0, 10)}T23:59:59Z`) < new Date()) throw new ValidationError("Expired stock cannot be dispensed");
    const remaining = Number(lot.quantity) - body.quantity;
    if (remaining < 0) throw new ConflictError("Insufficient stock in the selected lot");
    await tx`update stock_lots set quantity = ${remaining}, version = version + 1, updated_at = now() where id = ${body.lotId}`;
    await tx`
      insert into stock_movements (id, tenant_id, lot_id, delta, reason, actor_id)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${body.lotId}, ${-body.quantity}, ${`Dispensed for order ${body.orderId}`}, ${auth.user.id})
    `;
    await tx`
      insert into dispenses (id, tenant_id, order_id, lot_id, quantity, notes, dispensed_by)
      values (${dispenseId}, ${auth.activeTenant!.id}, ${body.orderId}, ${body.lotId}, ${body.quantity}, ${body.notes || null}, ${auth.user.id})
    `;
    await tx`update medication_orders set status = 'active', version = version + 1, updated_at = now() where id = ${body.orderId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "medication.dispense", {
      subjectPatientId: String(order.patientId), resourceType: "Dispense", resourceId: dispenseId,
      metadata: { orderId: body.orderId, lotId: body.lotId, quantity: body.quantity },
    }));
    await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "medication.dispensed", aggregateId: dispenseId, payload: { orderId: body.orderId } });
  });
  return c.json({ ok: true, dispense: { id: dispenseId } }, 201);
});

pharmacyRoutes.post("/medication-administrations", async (c) => {
  requireStaff(c);
  if (!hasRole(c, "clinician", "nurse")) throw new ForbiddenError("Medication administration requires clinical or nursing staff");
  const auth = c.get("auth")!;
  const body = await parseJson(c, administrationSchema);
  const adminId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const order = await requireRows(await tx`
      select id, patient_id, status from medication_orders where id = ${body.orderId} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Medication order not found");
    if (!["approved", "active"].includes(String(order.status))) throw new ConflictError("Medication must be approved and dispensed before administration");
    const dispensed = await tx`select 1 from dispenses where order_id = ${body.orderId}`;
    if (!dispensed[0]) throw new ConflictError("Medication must be dispensed before administration");
    if (body.witnessedBy) {
      const witness = await tx`
        select 1 from memberships where tenant_id = ${auth.activeTenant!.id} and user_id = ${body.witnessedBy} and status = 'active'
      `;
      if (!witness[0]) throw new ValidationError("The witness is not an active facility member");
    }
    await tx`
      insert into medication_administrations (id, tenant_id, order_id, patient_id, dose_text, administered_at, site, notes, status, witnessed_by, administered_by)
      values (${adminId}, ${auth.activeTenant!.id}, ${body.orderId}, ${order.patientId}, ${body.doseText}, ${new Date(body.administeredAt)},
        ${body.site || null}, ${body.notes || null}, ${body.status}, ${body.witnessedBy ?? null}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `medication.administer.${body.status}`, {
      subjectPatientId: String(order.patientId), resourceType: "MedicationAdministration", resourceId: adminId,
      metadata: { orderId: body.orderId, witnessed: Boolean(body.witnessedBy) },
    }));
  });
  return c.json({ ok: true, administration: { id: adminId } }, 201);
});

pharmacyRoutes.get("/patients/:id/medication", async (c) => {
  requireStaff(c);
  requirePharmacyRead(c);
  const auth = c.get("auth")!;
  const patientId = uuidSchema.parse(c.req.param("id"));
  const linked = await withStaffActor(c, async (tx) => tx`
    select 1 from tenant_patient_links where tenant_id = ${auth.activeTenant!.id} and patient_id = ${patientId}
  `);
  if (!linked[0]) throw new ValidationError("Patient is not linked to this facility");
  const data = await withStaffActor(c, async (tx) => {
    const orders = await tx`
      select mo.*, m.name as medicine_name, m.strength, m.form
        from medication_orders mo join medicines m on m.id = mo.medicine_id
       where mo.patient_id = ${patientId} and mo.tenant_id = ${auth.activeTenant!.id}
       order by mo.created_at desc
    `;
    const administrations = await tx`
      select ma.*, u.display_name as administered_by_name from medication_administrations ma join users u on u.id = ma.administered_by
       where ma.patient_id = ${patientId} and ma.tenant_id = ${auth.activeTenant!.id}
       order by ma.administered_at desc
    `;
    return { orders, administrations };
  });
  await withStaffActor(c, async (tx) => writeAudit(tx, c.get("deps").config, requestAudit(c, "medication.patient.read", {
    subjectPatientId: patientId, resourceType: "MedicationSummary", resourceId: patientId,
  })));
  return c.json(data);
});
