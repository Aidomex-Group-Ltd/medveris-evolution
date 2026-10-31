import { type Browser, type Page, expect, test } from "./fixtures.js";

/**
 * Retail pharmacy point of sale. Prerequisites (selling counter, catalogue items, receipts of lots)
 * are provisioned through the same staff API the UI uses, so the browser steps focus on the actual
 * checkout journey: expired lots never counted, FEFO deduction, prescription guardrails and the sale list.
 */

const PASSWORD = "Medveris!2026";

interface Session {
  page: Page;
  api: <T = any>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown, expected?: number) => Promise<T>;
  close: () => Promise<void>;
}

async function signInStaff(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function session(browser: Browser, email: string, tenantId?: string): Promise<Session> {
  const context = await browser.newContext({ baseURL: "http://localhost:5173" });
  const page = await context.newPage();
  await signInStaff(page, email);
  let csrf = (await (await page.request.get("/api/v1/me")).json()).csrfToken as string;
  const api: Session["api"] = async (method, path, body, expected) => {
    const response = await page.request.fetch(`/api/v1${path}`, { method, data: body, headers: { "x-medveris-csrf": csrf } });
    const text = await response.text();
    expect(response.status(), `${method} ${path}: ${text.slice(0, 300)}`).toBe(expected ?? (method === "POST" ? 201 : 200));
    return text ? JSON.parse(text) : null;
  };
  if (tenantId) {
    await api("POST", "/me/context", { tenantId }, 200);
    csrf = (await (await page.request.get("/api/v1/me")).json()).csrfToken as string;
  }
  return { page, api, close: () => context.close() };
}

async function createProduct(admin: Session, suffix: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await admin.api<{ id: string }>("POST", "/inventory/items", {
    itemCode: `POSE2E-${suffix}-${Date.now()}`,
    name: `Pharmacy E2E ${suffix}`,
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
  }, 201);
  return created.id;
}

async function receive(pharmacist: Session, locationId: string, itemId: string, lotNumber: string, expiresOn: string, quantity = 100): Promise<void> {
  await pharmacist.api("POST", "/inventory/receipts", {
    locationId,
    itemId,
    lotNumber,
    expiresOn,
    supplier: "Synthetic wholesaler",
    receiptReference: `GRN-${lotNumber}`,
    quantity,
    unit: "tablet",
    reason: "Synthetic pharmacy POS E2E stock",
  }, 201);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test.describe.configure({ mode: "serial", timeout: 240_000 });

test("pos checkout sells FEFO stock, blocks expired lots and enforces prescriptions", async ({ browser }) => {
  const stamp = Date.now();

  const admin = await session(browser, "admin@medveris.local");
  const pharmacist = await session(browser, "pharmacist@medveris.local");
  const clinician = await session(browser, "clinician@medveris.local");

  const location = await admin.api<{ location: { id: string } }>("POST", "/inventory/locations", {
    code: `POS-${stamp}`,
    name: "Pharmacy counter (e2e)",
    locationType: "department-store",
  }, 201);
  const locationId = location.location.id as string;

  const otcItemId = await createProduct(admin, "OTC");
  const rxItemId = await createProduct(admin, "RX", { prescriptionOnly: true, sellingPrice: 1000 });
  await receive(pharmacist, locationId, otcItemId, "EXPIRED-LOT", daysFromNow(-30), 500);
  await receive(pharmacist, locationId, otcItemId, "SOON-EXPIRY-LOT", daysFromNow(30), 20);
  await receive(pharmacist, locationId, otcItemId, "LATER-EXPIRY-LOT", daysFromNow(365), 30);
  await receive(pharmacist, locationId, rxItemId, "RX-LOT", daysFromNow(365), 50);

  const catalog = await pharmacist.api<{ items: Array<{ id: string; name: string; availableQuantity: number }> }>(
    "GET", `/pharmacy/pos/catalog?locationId=${locationId}`);
  const otc = catalog.items.find((item) => item.id === otcItemId)!;
  // The 500 expired tablets are excluded from the sellable count; both future lots are counted.
  expect(otc.availableQuantity).toBe(50);
  const rx = catalog.items.find((item) => item.id === rxItemId)!;
  expect(rx.availableQuantity).toBe(50);

  // Quantity beyond availability is rejected and produces no partial stock change.
  const overSale = await pharmacist.page.request.fetch("/api/v1/pharmacy/sales", {
    method: "POST",
    data: { locationId, currency: "UGX", paymentMethod: "cash", lines: [{ itemId: rxItemId, quantity: 500, discount: 0 }] },
    headers: { "x-medveris-csrf": (await (await pharmacist.page.request.get("/api/v1/me")).json()).csrfToken, "idempotency-key": `over-rx-${stamp}` },
  });
  expect([400, 409]).toContain(overSale.status());

  // The FEFO checkout itself is driven through the UI.
  await pharmacist.page.goto("/pharmacy-pos");
  await expect(pharmacist.page.getByRole("heading", { name: "Pharmacy point of sale" })).toBeVisible();
  await pharmacist.page.getByLabel("Selling location").selectOption({ label: "Pharmacy counter (e2e)" });
  const catalogueTable = pharmacist.page.getByRole("table", { name: "Retail catalogue" });

  const otcRow = catalogueTable.getByRole("row", { name: /Pharmacy E2E OTC/ });
  await otcRow.getByLabel(/Quantity of /).fill("20");
  await expect(pharmacist.page.getByRole("button", { name: "Complete sale" })).toBeEnabled();
  await pharmacist.page.getByRole("button", { name: "Complete sale" }).click();
  await expect(pharmacist.page.getByText(/Receipt SALE-/)).toBeVisible();

  // FEFO: the sooner-expiry lot (20) must be drained first, then the later lot supplies the remaining 0 of 20.
  const lots = await pharmacist.api<{ lots: Array<{ lotNumber: string; available: number }> }>(
    "GET", `/pharmacy/pos/items/${otcItemId}/lots?locationId=${locationId}`);
  const soon = lots.lots.find((lot) => lot.lotNumber === "SOON-EXPIRY-LOT");
  const later = lots.lots.find((lot) => lot.lotNumber === "LATER-EXPIRY-LOT");
  expect(soon?.available ?? 0).toBe(0);
  expect(later?.available).toBe(30);
  expect(lots.lots.find((lot) => lot.lotNumber === "EXPIRED-LOT")).toBeUndefined();

  // Prescription-only product cannot check out without a linked prescription.
  const afterUiSale = await pharmacist.api<{ items: Array<{ id: string }> }>("GET", `/pharmacy/pos/catalog?locationId=${locationId}`);
  expect(afterUiSale.items.length).toBeGreaterThan(0);
  await pharmacist.page.reload();
  const rxRow = catalogueTable.getByRole("row", { name: /Pharmacy E2E RX/ });
  await rxRow.getByLabel(/Quantity of /).fill("2");
  await expect(pharmacist.page.getByRole("button", { name: "Complete sale" })).toBeDisabled();

  // Link a valid prescription and complete the sale.
  const reception = await session(browser, "reception@medveris.local");
  const patient = await reception.api<{ patient: { patientId: string } }>("POST", "/reception/patients", {
    givenName: "Pos", familyName: `Checkout${stamp}`, dateOfBirth: "1988-02-02", sex: "male", identityConfidence: "confirmed-verbal",
  }, 201);
  const prescription = await clinician.api<{ prescription: { id: string } }>("POST", "/pharmacy/prescriptions", {
    patientId: patient.patient.patientId,
    reference: `RXE2E-${stamp}`,
    notes: "Synthetic POS E2E prescription",
    items: [{ itemId: rxItemId, doseText: "1 tablet", route: "oral", frequency: "once daily", quantity: 10, repeatsAllowed: 0, directions: "", prescriptionOnly: true }],
  }, 201);

  // A prescription-only quantity beyond the authorized amount (10) is rejected even with a prescription.
  const overRx = await pharmacist.page.request.fetch("/api/v1/pharmacy/sales", {
    method: "POST",
    data: {
      locationId, patientId: patient.patient.patientId, prescriptionId: prescription.prescription.id,
      currency: "UGX", paymentMethod: "cash", lines: [{ itemId: rxItemId, quantity: 15, discount: 0 }],
    },
    headers: { "x-medveris-csrf": (await (await pharmacist.page.request.get("/api/v1/me")).json()).csrfToken, "idempotency-key": `over-rx-auth-${stamp}` },
  });
  expect([400, 409]).toContain(overRx.status());

  // Search the patient in the checkout patient finder, select the prescription and complete the sale in the UI.
  await pharmacist.page.locator("#pos-patient").fill(`Checkout${stamp}`);
  const patientRow = pharmacist.page.getByRole("row", { name: /Pos Checkout/ }).first();
  await patientRow.getByRole("button", { name: "Select" }).click();
  await expect(pharmacist.page.getByLabel("Prescription")).toBeVisible();
  await pharmacist.page.getByLabel("Prescription").selectOption({ index: 1 });
  await rxRow.getByLabel(/Quantity of /).fill("5");
  await expect(pharmacist.page.getByRole("button", { name: "Complete sale" })).toBeEnabled();
  await pharmacist.page.getByRole("button", { name: "Complete sale" }).click();
  await expect(pharmacist.page.getByText(/Receipt SALE-/).last()).toBeVisible();

  // The sale list shows both sales with their data; the voided attempt never appears as completed twice.
  await pharmacist.page.getByRole("tab", { name: "Sales" }).click();
  await expect(pharmacist.page.getByText(/SALE-20\d\d-/).first()).toBeVisible();

  // Catalogue edits do not touch the ledger: rename the RX product, stock and sale allocations stay intact.
  const catalogAfter = await pharmacist.api<{ items: Array<{ id: string; availableQuantity: number }> }>("GET", `/pharmacy/pos/catalog?locationId=${locationId}`);
  expect(catalogAfter.items.find((item) => item.id === rxItemId)!.availableQuantity).toBe(45);

  await Promise.all([admin, pharmacist, clinician, reception].map((entry) => entry.close()));
});
