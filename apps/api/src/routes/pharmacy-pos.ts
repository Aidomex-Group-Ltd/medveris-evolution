import { Hono } from "hono";
import {
  pharmacySaleSchema,
  pharmacySaleVoidSchema,
  prescriptionCancelSchema,
  prescriptionSchema,
  uuidSchema,
} from "@medveris/contracts";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { writeAudit, writeOutbox } from "../lib/audit.js";
import { idempotencyKey, uniqueViolation } from "../lib/idempotency.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import { assertLocationInScope } from "../lib/scope.js";
import { postMovement } from "./inventory.js";
import type { AppEnv } from "../types.js";

/** Retail pharmacy sale, prescription and reporting routes built on the departmental inventory ledger. */
export const pharmacyPosRoutes = new Hono<AppEnv>();

type HandlerContext = Parameters<typeof requireStaff>[0];

const POS_ROLES = ["pharmacist", "finance", "facility_admin", "owner"];
const PRESCRIBER_ROLES = ["clinician", "specialist_clinician"];
const VOID_ROLES = ["pharmacist", "facility_admin", "owner"];
const REPORT_ROLES = ["pharmacist", "finance", "facility_admin", "owner", "auditor"];
const PATIENT_LOOKUP_ROLES = ["pharmacist", "finance", "facility_admin", "owner", "receptionist", "nurse", "clinician", "specialist_clinician"];

function hasAnyRole(c: HandlerContext, roles: readonly string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

function requireAnyRole(c: HandlerContext, roles: readonly string[], message: string): void {
  if (!hasAnyRole(c, roles)) throw new ForbiddenError(message);
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function optionalUuid(value: string | undefined, field: string): string | null {
  if (!value) return null;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError(`${field} must be a valid identifier`);
  return parsed.data;
}

function optionalDate(value: string | undefined, field: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
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

async function nextSaleNumber(tx: Parameters<Parameters<typeof withStaffActor>[1]>[0], tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx`select pg_advisory_xact_lock(hashtext(${`pharmacy:sale:${tenantId}:${year}`}))`;
  const [row] = await tx`select count(*)::int as n from pharmacy_sales where tenant_id = ${tenantId} and sale_number like ${`SALE-${year}-%`}`;
  return `SALE-${year}-${String(Number(row?.n ?? 0) + 1).padStart(5, "0")}`;
}

async function linkedPatient(tx: Parameters<Parameters<typeof withStaffActor>[1]>[0], tenantId: string, patientId: string): Promise<{ id: string; publicId: string; givenName: string; familyName: string }> {
  const rows = await tx`
    select p.id, p.public_id, p.given_name, p.family_name
      from tenant_patient_links l join patients p on p.id = l.patient_id
     where l.tenant_id = ${tenantId} and l.patient_id = ${patientId} and p.merged_into is null
  `;
  return requireRows(rows, "Patient is not linked to this facility") as never;
}

interface LoadedPrescription {
  id: string;
  patientId: string;
  status: string;
  version: number;
  expiresOn: string | null;
  items: Array<{ id: string; itemId: string; quantity: number; repeatsAllowed: number; repeatsUsed: number; dispensedQuantity: number }>;
}

async function loadPrescription(
  tx: Parameters<Parameters<typeof withStaffActor>[1]>[0],
  tenantId: string,
  id: string,
  lock = false,
): Promise<LoadedPrescription> {
  const rows = lock
    ? await tx`select id, patient_id, status, version, to_char(expires_on, 'YYYY-MM-DD') as expires_on from pharmacy_prescriptions where id = ${id} and tenant_id = ${tenantId} for update`
    : await tx`select id, patient_id, status, version, to_char(expires_on, 'YYYY-MM-DD') as expires_on from pharmacy_prescriptions where id = ${id} and tenant_id = ${tenantId}`;
  const prescription = await requireRows(rows, "Prescription not found");
  const items = await tx`
    select id, item_id, quantity, repeats_allowed, repeats_used, dispensed_quantity
      from pharmacy_prescription_items where prescription_id = ${id} and tenant_id = ${tenantId}
  `;
  return {
    id: String(prescription.id),
    patientId: String(prescription.patientId),
    status: String(prescription.status),
    version: Number(prescription.version),
    expiresOn: prescription.expiresOn ? String(prescription.expiresOn) : null,
    items: items.map((item) => ({
      id: String(item.id),
      itemId: String(item.itemId),
      quantity: Number(item.quantity),
      repeatsAllowed: Number(item.repeatsAllowed),
      repeatsUsed: Number(item.repeatsUsed),
      dispensedQuantity: Number(item.dispensedQuantity),
    })),
  };
}

// ---------------------------------------------------------------- catalogue and patients

pharmacyPosRoutes.get("/pharmacy/pos/catalog", async (c) => {
  requireStaff(c);
  requireAnyRole(c, POS_ROLES, "Point-of-sale access is required");
  const auth = c.get("auth")!;
  const q = c.req.query("q")?.trim().toLowerCase();
  const locationId = optionalUuid(c.req.query("locationId"), "locationId");
  const items = await withStaffActor(c, async (tx) => {
    if (locationId) await assertLocationInScope(tx, c, locationId);
    return tx`
      select i.id, i.item_code, i.name, i.generic_name, i.brand_name, i.strength, i.form, i.category,
             i.subcategory, i.classification, i.base_unit, i.barcode, i.currency,
             i.selling_price::float8 as selling_price, i.tax_rate::float8 as tax_rate,
             i.prescription_only, i.lot_tracked, i.expiry_tracked, i.reorder_threshold::float8 as reorder_threshold,
             coalesce((
               select sum(b.on_hand - b.reserved - b.quarantined)
                 from inventory_balances b
                where b.tenant_id = i.tenant_id and b.item_id = i.id
                  and (${locationId ?? null}::uuid is null or b.location_id = ${locationId ?? null}::uuid)
                  and (not i.lot_tracked or exists (
                    select 1 from inventory_lots lt
                     where lt.id = b.lot_id and lt.status = 'available'
                       and (not i.expiry_tracked or lt.expires_on is null or lt.expires_on >= current_date)
                  ))
             ), 0)::float8 as available_quantity
        from inventory_items i
       where i.tenant_id = ${auth.activeTenant!.id} and i.status = 'active'
         ${q ? tx`and (lower(i.name) like ${`%${q}%`} or lower(coalesce(i.generic_name, '')) like ${`%${q}%`}
           or lower(i.item_code) like ${`%${q}%`} or lower(coalesce(i.barcode, '')) like ${`%${q}%`})` : tx``}
       order by i.name
       limit 500
    `;
  });
  return c.json({ items });
});

pharmacyPosRoutes.get("/pharmacy/pos/items/:id/lots", async (c) => {
  requireStaff(c);
  requireAnyRole(c, POS_ROLES, "Point-of-sale access is required");
  const auth = c.get("auth")!;
  const itemId = uuidSchema.parse(c.req.param("id"));
  const locationId = optionalUuid(c.req.query("locationId"), "locationId");
  if (!locationId) throw new ValidationError("A stock location is required");
  const lots = await withStaffActor(c, async (tx) => {
    await assertLocationInScope(tx, c, locationId);
    return tx`
      select lt.id, lt.lot_number, lt.expires_on, lt.status, lt.supplier, lt.receipt_reference,
             (b.on_hand - b.reserved - b.quarantined)::float8 as available
        from inventory_lots lt
        join inventory_balances b on b.lot_id = lt.id and b.tenant_id = lt.tenant_id
       where lt.tenant_id = ${auth.activeTenant!.id} and lt.item_id = ${itemId} and b.location_id = ${locationId}
         and lt.status = 'available' and (lt.expires_on is null or lt.expires_on >= current_date)
         and (b.on_hand - b.reserved - b.quarantined) > 0
       order by lt.expires_on asc nulls last, lt.created_at
    `;
  });
  return c.json({ lots });
});

pharmacyPosRoutes.get("/pharmacy/pos/patients", async (c) => {
  requireStaff(c);
  requireAnyRole(c, PATIENT_LOOKUP_ROLES, "Patient lookup is not permitted for this role");
  const auth = c.get("auth")!;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const term = `${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const patients = await withStaffActor(c, async (tx) => tx`
    select p.id, p.public_id, p.given_name, p.family_name, to_char(p.date_of_birth, 'YYYY-MM-DD') as date_of_birth,
           p.sex, l.local_mrn
      from tenant_patient_links l join patients p on p.id = l.patient_id
     where l.tenant_id = ${auth.activeTenant!.id} and p.merged_into is null
       ${q ? tx`and (p.family_name ilike ${term} or p.given_name ilike ${term} or p.public_id ilike ${term} or l.local_mrn ilike ${term})` : tx``}
     order by lower(p.family_name), lower(p.given_name)
     limit 25
  `);
  return c.json({ patients });
});

// ---------------------------------------------------------------- prescriptions

pharmacyPosRoutes.post("/pharmacy/prescriptions", async (c) => {
  requireStaff(c);
  requireAnyRole(c, [...PRESCRIBER_ROLES, "facility_admin", "owner"], "Only an authorized prescriber may issue a prescription");
  const auth = c.get("auth")!;
  const body = await parseJson(c, prescriptionSchema);
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      await linkedPatient(tx, auth.activeTenant!.id, body.patientId);
      if (body.encounterId) {
        const encounter = await tx`
          select id, patient_id from encounters where id = ${body.encounterId} and tenant_id = ${auth.activeTenant!.id}
        `;
        if (!encounter[0]) throw new ValidationError("The consultation was not found in this workspace");
        if (String(encounter[0].patientId) !== body.patientId) throw new ValidationError("The consultation does not belong to the selected patient");
      }
      const seen = new Set<string>();
      for (const item of body.items) {
        if (seen.has(item.itemId)) throw new ValidationError("The same product appears more than once on the prescription");
        seen.add(item.itemId);
        const product = await tx`
          select id, name, prescription_only from inventory_items
           where id = ${item.itemId} and tenant_id = ${auth.activeTenant!.id} and status = 'active'
        `;
        if (!product[0]) throw new ValidationError("A prescribed product does not exist in this workspace");
      }
      const issuedOn = body.issuedOn ?? new Date().toISOString().slice(0, 10);
      if (body.expiresOn && body.expiresOn < issuedOn) throw new ValidationError("The prescription expiry cannot be before it was issued");
      await tx`
        insert into pharmacy_prescriptions (id, tenant_id, patient_id, encounter_id, prescriber_id, reference, issued_on, expires_on, notes, created_by)
        values (${id}, ${auth.activeTenant!.id}, ${body.patientId}, ${body.encounterId ?? null}, ${auth.user.id},
          ${body.reference}, ${issuedOn}, ${body.expiresOn ?? null}, ${body.notes || null}, ${auth.user.id})
      `;
      for (const item of body.items) {
        await tx`
          insert into pharmacy_prescription_items (id, tenant_id, prescription_id, item_id, dose_text, route, frequency,
            quantity, repeats_allowed, directions, prescription_only)
          values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${item.itemId}, ${item.doseText}, ${item.route},
            ${item.frequency}, ${item.quantity}, ${item.repeatsAllowed}, ${item.directions || null}, ${item.prescriptionOnly})
        `;
      }
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "pharmacy.prescription.create", {
        subjectPatientId: body.patientId, resourceType: "PharmacyPrescription", resourceId: id,
        metadata: { reference: body.reference, items: body.items.length, encounterId: body.encounterId ?? null },
      }));
      await writeOutbox(tx, { tenantId: auth.activeTenant!.id, eventType: "pharmacy.prescription.issued", aggregateId: id, payload: { patientId: body.patientId } });
    });
  } catch (error) {
    if (uniqueViolation(error) === "pharmacy_prescriptions_tenant_id_reference_key") {
      throw new ConflictError(`Prescription reference ${body.reference} is already used in this workspace`);
    }
    throw error;
  }
  return c.json({ ok: true, prescription: { id, reference: body.reference } }, 201);
});

pharmacyPosRoutes.get("/pharmacy/prescriptions", async (c) => {
  requireStaff(c);
  requireAnyRole(c, [...POS_ROLES, ...PRESCRIBER_ROLES, "auditor"], "Prescription access is not permitted for this role");
  const auth = c.get("auth")!;
  const patientId = optionalUuid(c.req.query("patientId"), "patientId");
  const status = c.req.query("status");
  const q = c.req.query("q")?.trim().toLowerCase();
  const prescriptions = await withStaffActor(c, async (tx) => tx`
    select pr.id, pr.reference, pr.status, pr.issued_on, pr.expires_on, pr.notes, pr.version, pr.created_at,
           p.id as patient_id, p.public_id, p.given_name, p.family_name,
           u.display_name as prescriber_name,
           (select json_agg(json_build_object(
              'id', pi.id, 'itemId', pi.item_id, 'name', i.name, 'doseText', pi.dose_text,
              'route', pi.route, 'frequency', pi.frequency, 'quantity', pi.quantity::float8,
              'repeatsAllowed', pi.repeats_allowed, 'repeatsUsed', pi.repeats_used,
              'directions', pi.directions, 'prescriptionOnly', pi.prescription_only,
              'dispensedQuantity', pi.dispensed_quantity::float8) order by i.name)
              from pharmacy_prescription_items pi join inventory_items i on i.id = pi.item_id
             where pi.prescription_id = pr.id) as items
      from pharmacy_prescriptions pr
      join patients p on p.id = pr.patient_id
      join users u on u.id = pr.prescriber_id
     where pr.tenant_id = ${auth.activeTenant!.id}
       ${patientId ? tx`and pr.patient_id = ${patientId}` : tx``}
       ${status ? tx`and pr.status = ${status}` : tx``}
       ${q ? tx`and (lower(pr.reference) like ${`%${q}%`} or lower(p.family_name) like ${`%${q}%`} or lower(p.given_name) like ${`%${q}%`})` : tx``}
     order by pr.created_at desc limit 100
  `);
  return c.json({ prescriptions });
});

pharmacyPosRoutes.get("/pharmacy/prescriptions/:id", async (c) => {
  requireStaff(c);
  requireAnyRole(c, [...POS_ROLES, ...PRESCRIBER_ROLES, "auditor"], "Prescription access is not permitted for this role");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const prescription = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select pr.*, p.public_id, p.given_name, p.family_name, u.display_name as prescriber_name
        from pharmacy_prescriptions pr join patients p on p.id = pr.patient_id join users u on u.id = pr.prescriber_id
       where pr.id = ${id} and pr.tenant_id = ${auth.activeTenant!.id}
    `;
    const loaded = await requireRows(rows, "Prescription not found");
    const items = await tx`
      select pi.*, i.name as item_name, i.strength, i.form
        from pharmacy_prescription_items pi join inventory_items i on i.id = pi.item_id
       where pi.prescription_id = ${id} order by i.name
    `;
    return { ...loaded, items };
  });
  return c.json({ prescription });
});

pharmacyPosRoutes.post("/pharmacy/prescriptions/:id/cancel", async (c) => {
  requireStaff(c);
  requireAnyRole(c, [...PRESCRIBER_ROLES, "pharmacist", "facility_admin", "owner"], "Only a prescriber or pharmacist may cancel a prescription");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, prescriptionCancelSchema);
  await withStaffActor(c, async (tx) => {
    const prescription = await requireRows(await tx`
      select id, patient_id, status, version from pharmacy_prescriptions
       where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Prescription not found");
    ensureMatch(body.expectedVersion, Number(prescription.version));
    if (!["issued", "partially-dispensed"].includes(String(prescription.status))) {
      throw new ConflictError("Only an issued prescription can be cancelled");
    }
    await tx`
      update pharmacy_prescriptions set status = 'cancelled', version = version + 1, updated_at = now() where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "pharmacy.prescription.cancel", {
      subjectPatientId: String(prescription.patientId), resourceType: "PharmacyPrescription", resourceId: id,
      metadata: { reason: body.reason, previousVersion: prescription.version },
    }));
  });
  return c.json({ ok: true });
});

function ensureDispensable(prescription: LoadedPrescription): void {
  if (!["issued", "partially-dispensed"].includes(prescription.status)) {
    throw new ConflictError("This prescription is not available for dispensing");
  }
  if (prescription.expiresOn && prescription.expiresOn < new Date().toISOString().slice(0, 10)) {
    throw new ConflictError("This prescription has expired");
  }
}

// ---------------------------------------------------------------- point of sale

pharmacyPosRoutes.post("/pharmacy/sales", async (c) => {
  requireStaff(c);
  requireAnyRole(c, POS_ROLES, "Point-of-sale access is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, pharmacySaleSchema);
  const key = idempotencyKey(c);
  const tenantId = auth.activeTenant!.id;

  const replay = async () => {
    if (!key) return null;
    const [existing] = await withStaffActor(c, async (tx) => tx`
      select id, sale_number, total::float8 as total, status from pharmacy_sales
       where tenant_id = ${tenantId} and idempotency_key = ${key}
    `);
    if (!existing) return null;
    return c.json({ ok: true, sale: existing, replayed: true }, 200);
  };
  const replayed = await replay();
  if (replayed) return replayed;

  const saleId = crypto.randomUUID();
  try {
    const result = await withStaffActor(c, async (tx) => {
      const location = await requireRows(await tx`
        select id, name from inventory_locations where id = ${body.locationId} and tenant_id = ${tenantId} and status = 'active'
      `, "The selling location was not found");
      await assertLocationInScope(tx, c, body.locationId);

      if (body.patientId) await linkedPatient(tx, tenantId, body.patientId);

      let prescription: LoadedPrescription | null = null;
      if (body.prescriptionId) {
        prescription = await loadPrescription(tx, tenantId, body.prescriptionId, true);
        ensureDispensable(prescription);
        if (body.patientId && prescription.patientId !== body.patientId) {
          throw new ValidationError("The prescription belongs to a different patient");
        }
        if (!body.patientId) body.patientId = prescription.patientId;
      } else if (body.prescriptionReference) {
        const rows = await tx`
          select id from pharmacy_prescriptions where tenant_id = ${tenantId} and reference = ${body.prescriptionReference}
        `;
        if (!rows[0]) throw new ValidationError("The prescription reference was not found in this workspace");
        prescription = await loadPrescription(tx, tenantId, String(rows[0].id), true);
        ensureDispensable(prescription);
        if (body.patientId && prescription.patientId !== body.patientId) {
          throw new ValidationError("The prescription belongs to a different patient");
        }
        if (!body.patientId) body.patientId = prescription.patientId;
      }

      const saleNumber = await nextSaleNumber(tx, tenantId);
      await tx`
        insert into pharmacy_sales (id, tenant_id, location_id, sale_number, patient_id, prescription_id, cashier_id, currency,
          payment_method, payment_reference, idempotency_key)
        values (${saleId}, ${tenantId}, ${body.locationId}, ${saleNumber}, ${body.patientId ?? null},
          ${prescription?.id ?? null}, ${auth.user.id}, ${body.currency}, ${body.paymentMethod},
          ${body.paymentReference || null}, ${key})
      `;

      let subtotal = 0;
      let taxTotal = 0;

      for (const line of body.lines) {
        const item = await requireRows(await tx`
          select id, name, base_unit, selling_price::float8 as selling_price, tax_rate::float8 as tax_rate,
                 unit_cost::float8 as unit_cost, prescription_only, lot_tracked, expiry_tracked, status
            from inventory_items where id = ${line.itemId} and tenant_id = ${tenantId}
        `, "A product on this sale was not found");
        if (String(item.status) !== "active") throw new ValidationError(`${item.name} is not available for sale`);

        let prescriptionItemId: string | null = null;
        if (Boolean(item.prescriptionOnly)) {
          requireAnyRole(c, ["pharmacist", "facility_admin", "owner"], `${item.name} is prescription-only and must be dispensed by a pharmacist`);
          if (!prescription) throw new ValidationError(`${item.name} requires a valid prescription`);
          if (!body.patientId) throw new ValidationError("A patient is required for a prescription sale");
          const match = prescription.items.find((candidate) =>
            candidate.itemId === line.itemId && (!line.prescriptionItemId || candidate.id === line.prescriptionItemId));
          if (!match) throw new ValidationError(`${item.name} is not on the linked prescription`);
          const allowed = match.quantity * (match.repeatsAllowed + 1);
          const remaining = allowed - match.dispensedQuantity;
          if (line.quantity - remaining > 0.00005) {
            throw new ConflictError(`${item.name}: only ${Math.max(remaining, 0)} remain on this prescription`);
          }
          prescriptionItemId = match.id;
          await tx`
            update pharmacy_prescription_items
               set dispensed_quantity = dispensed_quantity + ${line.quantity}
             where id = ${match.id} and tenant_id = ${tenantId}
          `;
        }
        if (line.unitPrice !== undefined && Math.abs(line.unitPrice - Number(item.sellingPrice)) > 0.00005) {
          requireAnyRole(c, ["finance", "facility_admin", "owner"], `Only a cashier or owner may override the price of ${item.name}`);
        }

        const unitPrice = line.unitPrice ?? Number(item.sellingPrice);
        const lineBase = money(unitPrice * line.quantity - line.discount);
        if (lineBase < 0) throw new ValidationError(`The discount for ${item.name} exceeds its price`);
        const lineTax = money(lineBase * Number(item.taxRate) / 100);
        const lineTotal = money(lineBase + lineTax);
        subtotal = money(subtotal + lineBase);
        taxTotal = money(taxTotal + lineTax);

        const lineId = crypto.randomUUID();
        await tx`
          insert into pharmacy_sale_lines (id, tenant_id, sale_id, item_id, prescription_item_id, description,
            quantity, unit_price, discount, tax, line_total)
          values (${lineId}, ${tenantId}, ${saleId}, ${line.itemId}, ${prescriptionItemId}, ${item.name},
            ${line.quantity}, ${unitPrice}, ${line.discount}, ${lineTax}, ${lineTotal})
        `;

        // Lot-tracked products are allocated FEFO from available, unexpired lots. Products without
        // lot tracking are sold from the location's untracked balance.
        const allocations = Boolean(item.lotTracked)
          ? await tx`
              select b.id, b.lot_id, lt.expires_on, (b.on_hand - b.reserved - b.quarantined)::float8 as available
                from inventory_balances b
                join inventory_lots lt on lt.id = b.lot_id
               where b.tenant_id = ${tenantId} and b.location_id = ${body.locationId} and b.item_id = ${line.itemId}
                 and (b.on_hand - b.reserved - b.quarantined) > 0
                 and lt.status = 'available'
                 and (lt.expires_on is null or lt.expires_on >= current_date)
               order by lt.expires_on asc nulls last, b.updated_at asc
               for update of b
            `
          : await tx`
              select b.id, b.lot_id, null::date as expires_on, (b.on_hand - b.reserved - b.quarantined)::float8 as available
                from inventory_balances b
               where b.tenant_id = ${tenantId} and b.location_id = ${body.locationId} and b.item_id = ${line.itemId}
                 and b.lot_id is null and (b.on_hand - b.reserved - b.quarantined) > 0
               order by b.updated_at asc
               for update of b
            `;
        let remaining = line.quantity;
        for (const allocation of allocations) {
          if (remaining <= 0.00005) break;
          const take = Math.min(remaining, Number(allocation.available));
          if (take <= 0.00005) continue;
          const lotId = allocation.lotId ? String(allocation.lotId) : null;
          await postMovement(tx, tenantId, auth.user.id, {
            itemId: line.itemId,
            lotId,
            sourceLocationId: body.locationId,
            quantity: take,
            unit: String(item.baseUnit),
            movementType: "issue",
            reason: `Pharmacy sale ${saleNumber}`,
            referenceType: "pharmacy-sale",
            referenceId: saleNumber,
          });
          await tx`
            insert into pharmacy_sale_allocations (id, tenant_id, sale_line_id, lot_id, quantity, expires_on, unit_cost)
            values (${crypto.randomUUID()}, ${tenantId}, ${lineId}, ${lotId}, ${take},
              ${allocation.expiresOn ?? null}, ${Number(item.unitCost)})
          `;
          remaining = Math.round((remaining - take) * 10000) / 10000;
        }
        if (remaining > 0.00005) {
          throw new ConflictError(`Insufficient available stock for ${item.name}`, { requested: line.quantity, shortfall: remaining });
        }
      }

      const saleDiscount = money(body.discount);
      if (saleDiscount > subtotal + taxTotal) throw new ValidationError("The sale discount exceeds the sale total");
      const total = money(subtotal + taxTotal - saleDiscount);
      if (["mobile-money", "bank-transfer", "card"].includes(body.paymentMethod) && !body.paymentReference) {
        throw new ValidationError("A payment reference is required for this payment method");
      }
      await tx`
        update pharmacy_sales set subtotal = ${subtotal}, tax = ${taxTotal}, discount = ${saleDiscount}, total = ${total},
          updated_at = now()
         where id = ${saleId} and tenant_id = ${tenantId}
      `;

      if (prescription) {
        const remainingItems = await tx`
          select count(*)::int as n from pharmacy_prescription_items
           where prescription_id = ${prescription.id} and dispensed_quantity < quantity * (repeats_allowed + 1)
        `;
        const nextStatus = Number(remainingItems[0]?.n ?? 0) === 0 ? "dispensed" : "partially-dispensed";
        await tx`
          update pharmacy_prescriptions set status = ${nextStatus}, version = version + 1, updated_at = now()
           where id = ${prescription.id} and tenant_id = ${tenantId}
        `;
      }

      await writeAudit(tx, c.get("deps").config, requestAudit(c, "pharmacy.sale.complete", {
        subjectPatientId: body.patientId ?? null, resourceType: "PharmacySale", resourceId: saleId,
        metadata: {
          saleNumber, locationId: body.locationId, lines: body.lines.length, total,
          paymentMethod: body.paymentMethod, prescriptionId: prescription?.id ?? null,
        },
      }));
      await writeOutbox(tx, {
        tenantId, eventType: "pharmacy.sale.completed", aggregateId: saleId,
        payload: { saleNumber, patientId: body.patientId ?? null, total },
      });
      return { saleNumber, total, subtotal, tax: taxTotal, discount: saleDiscount, locationName: location.name };
    });
    return c.json({ ok: true, sale: { id: saleId, ...result, status: "completed" } }, 201);
  } catch (error) {
    if (uniqueViolation(error) === "pharmacy_sales_idempotency") {
      const raced = await replay();
      if (raced) return raced;
    }
    throw error;
  }
});

pharmacyPosRoutes.post("/pharmacy/sales/:id/void", async (c) => {
  requireStaff(c);
  requireAnyRole(c, VOID_ROLES, "Only a pharmacist or owner may void a completed sale");
  const auth = c.get("auth")!;
  const tenantId = auth.activeTenant!.id;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, pharmacySaleVoidSchema);
  await withStaffActor(c, async (tx) => {
    const sale = await requireRows(await tx`
      select id, sale_number, location_id, status, patient_id from pharmacy_sales
       where id = ${id} and tenant_id = ${tenantId} for update
    `, "Sale not found");
    if (String(sale.status) === "voided") throw new ConflictError("This sale has already been voided");
    const allocations = await tx`
      select a.lot_id, a.quantity, i.id as item_id, i.base_unit
        from pharmacy_sale_allocations a
        join pharmacy_sale_lines l on l.id = a.sale_line_id
        join inventory_items i on i.id = l.item_id
       where l.sale_id = ${id} and a.tenant_id = ${tenantId}
    `;
    for (const allocation of allocations) {
      await postMovement(tx, tenantId, auth.user.id, {
        itemId: String(allocation.itemId),
        lotId: allocation.lotId ? String(allocation.lotId) : null,
        destinationLocationId: String(sale.locationId),
        quantity: Number(allocation.quantity),
        unit: String(allocation.baseUnit),
        movementType: "return",
        reason: `Void sale ${sale.saleNumber}: ${body.reason}`,
        referenceType: "pharmacy-sale-void",
        referenceId: String(sale.saleNumber),
        allowIneligible: true,
      });
    }
    const dispensed = await tx`
      select l.prescription_item_id, l.quantity, s.prescription_id
        from pharmacy_sale_lines l join pharmacy_sales s on s.id = l.sale_id
       where l.sale_id = ${id} and l.tenant_id = ${tenantId} and l.prescription_item_id is not null
    `;
    const prescriptionIds = new Set<string>();
    for (const line of dispensed) {
      await tx`
        update pharmacy_prescription_items
           set dispensed_quantity = greatest(dispensed_quantity - ${Number(line.quantity)}, 0)
         where id = ${String(line.prescriptionItemId)} and tenant_id = ${tenantId}
      `;
      if (line.prescriptionId) prescriptionIds.add(String(line.prescriptionId));
    }
    for (const prescriptionId of prescriptionIds) {
      const [totals] = await tx`
        select (count(*) filter (where dispensed_quantity < quantity * (repeats_allowed + 1)))::int as outstanding,
               coalesce(sum(dispensed_quantity), 0)::float8 as dispensed
          from pharmacy_prescription_items where prescription_id = ${prescriptionId}
      `;
      const nextStatus = Number(totals?.outstanding ?? 0) === 0 ? "dispensed" : Number(totals?.dispensed ?? 0) > 0 ? "partially-dispensed" : "issued";
      await tx`
        update pharmacy_prescriptions set status = ${nextStatus}, version = version + 1, updated_at = now()
         where id = ${prescriptionId} and tenant_id = ${tenantId}
           and status in ('dispensed','partially-dispensed')
      `;
    }
    await tx`
      update pharmacy_sales set status = 'voided', voided_by = ${auth.user.id}, voided_at = now(),
        void_reason = ${body.reason}, updated_at = now()
       where id = ${id} and tenant_id = ${tenantId}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "pharmacy.sale.void", {
      subjectPatientId: sale.patientId ? String(sale.patientId) : null, resourceType: "PharmacySale", resourceId: id,
      metadata: { saleNumber: sale.saleNumber, reason: body.reason, allocations: allocations.length },
    }));
    await writeOutbox(tx, { tenantId, eventType: "pharmacy.sale.voided", aggregateId: id, payload: { saleNumber: sale.saleNumber } });
  });
  return c.json({ ok: true });
});

pharmacyPosRoutes.get("/pharmacy/sales", async (c) => {
  requireStaff(c);
  requireAnyRole(c, [...POS_ROLES, "auditor"], "Sales access is not permitted for this role");
  const auth = c.get("auth")!;
  const patientId = optionalUuid(c.req.query("patientId"), "patientId");
  const status = c.req.query("status");
  const from = optionalDate(c.req.query("from"), "from");
  const to = optionalDate(c.req.query("to"), "to");
  const sales = await withStaffActor(c, async (tx) => tx`
    select s.id, s.sale_number, s.status, s.currency, s.subtotal::float8 as subtotal, s.discount::float8 as discount,
           s.tax::float8 as tax, s.total::float8 as total, s.payment_method, s.payment_reference, s.created_at,
           s.voided_at, s.void_reason, p.id as patient_id, p.public_id, p.given_name, p.family_name,
           u.display_name as cashier_name, l.name as location_name,
           (select count(*)::int from pharmacy_sale_lines line where line.sale_id = s.id) as line_count
      from pharmacy_sales s
      left join patients p on p.id = s.patient_id
      join users u on u.id = s.cashier_id
      join inventory_locations l on l.id = s.location_id
     where s.tenant_id = ${auth.activeTenant!.id}
       ${patientId ? tx`and s.patient_id = ${patientId}` : tx``}
       ${status ? tx`and s.status = ${status}` : tx``}
       ${from ? tx`and s.created_at >= ${from}::date` : tx``}
       ${to ? tx`and s.created_at < (${to}::date + interval '1 day')` : tx``}
     order by s.created_at desc limit 200
  `);
  return c.json({ sales });
});

pharmacyPosRoutes.get("/pharmacy/sales/:id", async (c) => {
  requireStaff(c);
  requireAnyRole(c, [...POS_ROLES, "auditor"], "Sales access is not permitted for this role");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const sale = await withStaffActor(c, async (tx) => {
    const rows = await tx`
      select s.*, p.public_id, p.given_name, p.family_name, u.display_name as cashier_name, l.name as location_name
        from pharmacy_sales s left join patients p on p.id = s.patient_id
        join users u on u.id = s.cashier_id join inventory_locations l on l.id = s.location_id
       where s.id = ${id} and s.tenant_id = ${auth.activeTenant!.id}
    `;
    const loaded = await requireRows(rows, "Sale not found");
    const lines = await tx`
      select l.*, i.item_code, i.base_unit, i.prescription_only,
             (select json_agg(json_build_object('lotId', a.lot_id, 'lotNumber', lt.lot_number,
                'quantity', a.quantity::float8, 'expiresOn', a.expires_on, 'unitCost', a.unit_cost::float8)
                order by lt.expires_on asc nulls last)
                from pharmacy_sale_allocations a left join inventory_lots lt on lt.id = a.lot_id
               where a.sale_line_id = l.id) as allocations
        from pharmacy_sale_lines l join inventory_items i on i.id = l.item_id
       where l.sale_id = ${id} order by l.created_at, l.id
    `;
    return { ...loaded, lines };
  });
  return c.json({ sale });
});

// ---------------------------------------------------------------- reports

pharmacyPosRoutes.get("/pharmacy/reports/sales", async (c) => {
  requireStaff(c);
  requireAnyRole(c, REPORT_ROLES, "Sales reporting is not permitted for this role");
  const auth = c.get("auth")!;
  const from = optionalDate(c.req.query("from"), "from");
  const to = optionalDate(c.req.query("to"), "to");
  const data = await withStaffActor(c, async (tx) => {
    const summary = await tx`
      select date_trunc('day', s.created_at)::date as day,
             count(*)::int as sales,
             coalesce(sum(s.total), 0)::float8 as revenue,
             coalesce(sum(s.tax), 0)::float8 as tax,
             coalesce(sum(s.discount), 0)::float8 as discount
        from pharmacy_sales s
       where s.tenant_id = ${auth.activeTenant!.id} and s.status = 'completed'
         ${from ? tx`and s.created_at >= ${from}::date` : tx``}
         ${to ? tx`and s.created_at < (${to}::date + interval '1 day')` : tx``}
       group by day order by day
    `;
    const items = await tx`
      select i.id as item_id, i.item_code, i.name,
             coalesce(sum(l.quantity), 0)::float8 as quantity,
             coalesce(sum(l.line_total), 0)::float8 as revenue,
             coalesce(sum(a.cost), 0)::float8 as cost,
             coalesce(sum(l.line_total) - sum(a.cost), 0)::float8 as margin
        from pharmacy_sale_lines l
        join pharmacy_sales s on s.id = l.sale_id
        join inventory_items i on i.id = l.item_id
        left join (
          select sale_line_id, sum(quantity * unit_cost) as cost
            from pharmacy_sale_allocations group by sale_line_id
        ) a on a.sale_line_id = l.id
       where s.tenant_id = ${auth.activeTenant!.id} and s.status = 'completed'
         ${from ? tx`and s.created_at >= ${from}::date` : tx``}
         ${to ? tx`and s.created_at < (${to}::date + interval '1 day')` : tx``}
       group by i.id, i.item_code, i.name
       order by revenue desc
    `;
    return { summary, items };
  });
  if (c.req.query("format") === "csv") {
    await withStaffActor(c, async (tx) => {
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "pharmacy.report.export", {
        resourceType: "PharmacySalesReport", resourceId: null,
        metadata: { from: from ?? null, to: to ?? null, rows: data.items.length },
      }));
    });
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="pharmacy-sales.csv"');
    return c.body(toCsv(data.items as Record<string, unknown>[]));
  }
  return c.json(data);
});
