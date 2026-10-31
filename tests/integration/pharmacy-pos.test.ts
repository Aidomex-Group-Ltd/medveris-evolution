import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Session } from "./support.js";

const h = createHarness("pharmacy-pos");

const stamp = Date.now();
const future = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

let admin: Session;
let pharmacist: Session;
let clinician: Session;
let reception: Session;
let finance: Session;

let locationId = "";
let otcItemId = "";
let rxItemId = "";
let patientId = "";
let prescriptionId = "";
let saleId = "";

beforeAll(async () => {
  [admin, pharmacist, clinician, reception, finance] = await Promise.all([
    h.login("admin@medveris.local"),
    h.login("pharmacist@medveris.local"),
    h.login("clinician@medveris.local"),
    h.login("reception@medveris.local"),
    h.login("finance@medveris.local"),
  ]);
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

async function createProduct(suffix: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await h.post(admin, "/api/v1/inventory/items", {
    itemCode: `POS-${suffix}-${stamp}`,
    name: `Pharmacy ${suffix} ${stamp}`,
    category: "Pharmacy",
    classification: "consumable",
    baseUnit: "tablet",
    criticality: "standard",
    lotTracked: true,
    expiryTracked: true,
    unitCost: 100,
    currency: "UGX",
    sellingPrice: 500,
    taxRate: 0,
    units: [{ unit: "tablet", conversionFactor: 1, isBase: true, purchasingUnit: true, issuingUnit: true }],
    ...overrides,
  });
  return created.item.id as string;
}

async function receive(itemId: string, lotNumber: string, quantity = 100): Promise<void> {
  await h.post(pharmacist, "/api/v1/inventory/receipts", {
    locationId,
    itemId,
    lotNumber,
    expiresOn: future,
    supplier: "Synthetic wholesaler",
    receiptReference: `GRN-${lotNumber}`,
    quantity,
    unit: "tablet",
    reason: "Synthetic pharmacy POS integration stock",
  });
}

describe("pharmacy point of sale", () => {
  it("creates a selling location and retail catalogue items with prices", async () => {
    const location = await h.post(admin, "/api/v1/inventory/locations", {
      code: `POS-${stamp}`,
      name: "Pharmacy counter",
      locationType: "department-store",
    });
    locationId = location.location.id;

    otcItemId = await createProduct("OTC");
    rxItemId = await createProduct("RX", { prescriptionOnly: true, sellingPrice: 1000, form: "tablet", strength: "500 mg" });

    const catalogue = await h.expectOk(await h.call(admin, "/api/v1/inventory/items?classification=consumable"));
    const otc = catalogue.items.find((item: any) => item.id === otcItemId);
    expect(otc).toMatchObject({ sellingPrice: 500, prescriptionOnly: false });
    const rx = catalogue.items.find((item: any) => item.id === rxItemId);
    expect(rx).toMatchObject({ sellingPrice: 1000, prescriptionOnly: true, strength: "500 mg" });

    await receive(otcItemId, `OTC-LOT-${stamp}`);
    await receive(rxItemId, `RX-LOT-${stamp}`);

    const pos = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/pos/catalog?locationId=${locationId}`));
    expect(pos.items.find((item: any) => item.id === otcItemId).availableQuantity).toBe(100);
    expect(pos.items.find((item: any) => item.id === rxItemId).availableQuantity).toBe(100);
  });

  it("issues a prescription and dispenses it from FEFO stock with the sale total", async () => {
    patientId = await h.registerPatient(reception, `Pharmacy${stamp}`);

    const prescription = await h.post(clinician, "/api/v1/pharmacy/prescriptions", {
      patientId,
      reference: `RX-${stamp}`,
      notes: "Synthetic prescription for the point-of-sale test",
      items: [{
        itemId: rxItemId,
        doseText: "1 tablet",
        route: "oral",
        frequency: "twice daily",
        quantity: 10,
        repeatsAllowed: 0,
        directions: "After food",
        prescriptionOnly: true,
      }],
    }, 201);
    prescriptionId = prescription.prescription.id;

    const sale = await h.post(pharmacist, "/api/v1/pharmacy/sales", {
      locationId,
      patientId,
      prescriptionId,
      currency: "UGX",
      discount: 0,
      paymentMethod: "cash",
      lines: [
        { itemId: otcItemId, quantity: 2, discount: 0 },
        { itemId: rxItemId, quantity: 3, discount: 0 },
      ],
    }, 201, `sale-${stamp}`);
    saleId = sale.sale.id;
    expect(sale.sale).toMatchObject({ saleNumber: expect.stringMatching(/^SALE-\d{4}-\d{5}$/), subtotal: 4000, total: 4000 });

    const detail = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/sales/${saleId}`));
    expect(detail.sale.lines).toHaveLength(2);
    for (const line of detail.sale.lines) {
      expect(line.allocations).toHaveLength(1);
      expect(Number(line.allocations[0].quantity)).toBe(Number(line.quantity));
      expect(line.allocations[0].unitCost).toBe(100);
    }

    const pos = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/pos/catalog?locationId=${locationId}`));
    expect(pos.items.find((item: any) => item.id === otcItemId).availableQuantity).toBe(98);
    expect(pos.items.find((item: any) => item.id === rxItemId).availableQuantity).toBe(97);

    const issued = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/prescriptions/${prescriptionId}`));
    expect(issued.prescription.status).toBe("partially-dispensed");
  });

  it("replays the same idempotency key without dispensing twice", async () => {
    const replay = await h.post(pharmacist, "/api/v1/pharmacy/sales", {
      locationId,
      patientId,
      prescriptionId,
      currency: "UGX",
      discount: 0,
      paymentMethod: "cash",
      lines: [
        { itemId: otcItemId, quantity: 2, discount: 0 },
        { itemId: rxItemId, quantity: 3, discount: 0 },
      ],
    }, 200, `sale-${stamp}`);
    expect(replay).toMatchObject({ replayed: true, sale: { id: saleId } });
  });

  it("refuses to dispense more than the prescription allows and lets only a pharmacist sell prescription-only items", async () => {
    const overDispense = await h.call(pharmacist, "/api/v1/pharmacy/sales", {
      method: "POST",
      headers: { "idempotency-key": `over-${stamp}` },
      body: JSON.stringify({
        locationId, patientId, prescriptionId, currency: "UGX", discount: 0, paymentMethod: "cash",
        lines: [{ itemId: rxItemId, quantity: 8, discount: 0 }],
      }),
    });
    expect(overDispense.status).toBe(409);

    const forbidden = await h.call(finance, "/api/v1/pharmacy/sales", {
      method: "POST",
      headers: { "idempotency-key": `cashier-${stamp}` },
      body: JSON.stringify({
        locationId, patientId, prescriptionId, currency: "UGX", discount: 0, paymentMethod: "cash",
        lines: [{ itemId: rxItemId, quantity: 1, discount: 0 }],
      }),
    });
    expect(forbidden.status).toBe(403);

    const still = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/pos/catalog?locationId=${locationId}`));
    expect(still.items.find((item: any) => item.id === rxItemId).availableQuantity).toBe(97);
  });

  it("voids a completed sale, returns its stock and reopens the prescription", async () => {
    await h.post(pharmacist, `/api/v1/pharmacy/sales/${saleId}/void`, { reason: "Synthetic void for the POS test" }, 200);

    const pos = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/pos/catalog?locationId=${locationId}`));
    expect(pos.items.find((item: any) => item.id === otcItemId).availableQuantity).toBe(100);
    expect(pos.items.find((item: any) => item.id === rxItemId).availableQuantity).toBe(100);

    const detail = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/sales/${saleId}`));
    expect(detail.sale.status).toBe("voided");
    expect(detail.sale.voidReason).toBe("Synthetic void for the POS test");

    const issued = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/prescriptions/${prescriptionId}`));
    expect(issued.prescription.status).toBe("issued");
    expect(Number(issued.prescription.items[0].dispensedQuantity)).toBe(0);
  });

  it("reports only completed sales and audits the CSV export", async () => {
    const completed = await h.expectOk(await h.call(admin, "/api/v1/pharmacy/sales?status=completed"));
    expect(completed.sales.find((sale: { id: string }) => sale.id === saleId)).toBeUndefined();

    const report = await h.expectOk(await h.call(admin, "/api/v1/pharmacy/reports/sales"));
    expect(Array.isArray(report.summary)).toBe(true);
    expect(Array.isArray(report.items)).toBe(true);

    const csv = await h.call(admin, "/api/v1/pharmacy/reports/sales?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
  });

  it("sells and voids a product that is not lot tracked", async () => {
    const untrackedItemId = await createProduct("NONLOT", { lotTracked: false, expiryTracked: false });
    await receive(untrackedItemId, `NONLOT-${stamp}`);

    const sale = await h.post(pharmacist, "/api/v1/pharmacy/sales", {
      locationId,
      patientId,
      currency: "UGX",
      discount: 0,
      paymentMethod: "cash",
      lines: [{ itemId: untrackedItemId, quantity: 4, discount: 0 }],
    }, 201, `untracked-${stamp}`);
    const detail = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/sales/${sale.sale.id}`));
    expect(detail.sale.lines[0].allocations).toHaveLength(1);
    expect(detail.sale.lines[0].allocations[0]).toMatchObject({ lotId: null, quantity: 4 });

    const afterSale = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/pos/catalog?locationId=${locationId}`));
    expect(afterSale.items.find((item: any) => item.id === untrackedItemId).availableQuantity).toBe(96);

    await h.post(pharmacist, `/api/v1/pharmacy/sales/${sale.sale.id}/void`, { reason: "Synthetic untracked void" }, 200);
    const afterVoid = await h.expectOk(await h.call(pharmacist, `/api/v1/pharmacy/pos/catalog?locationId=${locationId}`));
    expect(afterVoid.items.find((item: any) => item.id === untrackedItemId).availableQuantity).toBe(100);
  });
});
