import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { withContext } from "@medveris/db";
import { createHarness, type Session } from "./support.js";

/**
 * A Drugshop registered through the real workspace flow: its interface, its licence gate, its
 * dispensing limits and its own price list, against the same API production runs.
 */
const h = createHarness("facility-experience");
const PASSWORD = "Synthetic-Drugshop-2026!";
const run = crypto.randomUUID().slice(0, 8);
const email = `drugshop.${run}@example.test`;
const future = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

let session: Session;
let tenantId = "";
let ownerId = "";
let licenceId = "";
let locationId = "";
let otcItemId = "";
let unclassifiedItemId = "";
let rxItemId = "";
let priceListId = "";

async function anonymous(path: string, body: unknown): Promise<Response> {
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 20}` },
    body: JSON.stringify(body),
  }));
}

function cookieFrom(response: Response): string {
  const match = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error("no session cookie");
  return match.split(";")[0]!;
}

async function signInOwner(address: string): Promise<Session> {
  const response = await anonymous("/api/v1/auth/login", { email: address, password: PASSWORD });
  const body = await h.json(response);
  expect(response.status, JSON.stringify(body)).toBe(200);
  const created = { cookie: cookieFrom(response), csrf: body.csrfToken };
  const started = await h.post(created, "/api/v1/auth/mfa/enroll/start", {}, 200);
  await h.post(created, "/api/v1/auth/mfa/enroll/verify", { code: await totpCode(started.secret) }, 200);
  return created;
}

async function get(path: string, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path), status);
}

async function post(path: string, body: unknown, status = 201): Promise<any> {
  return h.post(session, path, body, status);
}

async function patch(path: string, body: unknown, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path, { method: "PATCH", body: JSON.stringify(body) }), status);
}

async function auditActions(): Promise<string[]> {
  const rows = await withContext(h.sql, { tenantId, userId: ownerId, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => tx`
    select action from audit_events where tenant_id = ${tenantId} order by occurred_at
  `);
  return rows.map((row) => String(row.action));
}

/** Verifies the recorded licence as an administrative act; no API path lets a facility self-verify. */
async function verifyLicence(): Promise<void> {
  await withContext(h.sql, { tenantId, userId: ownerId, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => {
    await tx`
      update facility_registrations
         set status = 'verified', verified_by = ${ownerId}, verified_at = now(), updated_at = now()
       where id = ${licenceId} and tenant_id = ${tenantId}
    `;
  });
}

beforeAll(async () => {
  const registrationResponse = await anonymous("/api/v1/auth/register/workspace", {
    path: "independent",
    owner: { email, password: PASSWORD, givenName: "Synthetic", familyName: "Drugshop Owner" },
    workspace: {
      name: `Synthetic Corner Drugshop ${run}`,
      workspaceKind: "service-unit",
      serviceCategory: "drug-shop",
      ownership: "private-for-profit",
      levelStatus: "not-applicable",
      district: "Wakiso",
      registrations: [{ kind: "nda-drug-shop", identifier: `NDA-DS-${run}` }],
    },
    legal: await h.legalAcceptance(),
  });
  const registered = await h.json(registrationResponse);
  expect(registrationResponse.status, JSON.stringify(registered)).toBe(201);
  expect(registered.workspace).toBeTruthy();
  tenantId = registered.workspace.id;
  session = await signInOwner(email);
  const me = await get("/api/v1/me");
  ownerId = me.user.id;
  const workspace = await get("/api/v1/workspace");
  licenceId = workspace.registrations[0].id;
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("facility experience for a registered Drugshop", () => {
  it("resolves the Drugshop experience from the active facility and blocks it until the licence is verified", async () => {
    const view = await get("/api/v1/facility/experience");
    expect(view.experience).toBe("drugshop");
    expect(view.facility.id).toBe(tenantId);
    expect(view.access.status).toBe("restricted");
    expect(view.access.reasons[0]).toMatch(/not verified/i);
    expect(view.licence).toMatchObject({ kind: "nda-drug-shop", state: "unverified", identifier: `NDA-DS-${run}` });
    expect(view.requiredLicenceKinds).toEqual(["nda-drug-shop"]);
    expect(view.dispensing.catalogueVisibilityImpliesDispensing).toBe(false);
    expect(view.dispensing.unclassifiedItemsDispensable).toBe(false);
    expect(view.routes.home).toBe("/drugshop");
  });

  it("serves the dashboard from real facility data with honest zeros", async () => {
    const overview = await get("/api/v1/drugshop/overview");
    expect(overview.facility.id).toBe(tenantId);
    expect(overview.stock).toEqual({ stockedItems: 0, lowStock: 0, outOfStock: 0 });
    expect(overview.today.transactions).toBe(0);
    expect(overview.recentSales).toEqual([]);
    expect(overview.expiring).toEqual([]);
    expect(overview.activePriceList).toBeNull();
  });

  it("opens the experience once the licence is verified", async () => {
    await verifyLicence();
    const view = await get("/api/v1/facility/experience");
    expect(view.access.status).toBe("ready");
    expect(view.licence.state).toBe("verified");
  });

  it("refuses the Drugshop dashboard to a pharmacy workspace", async () => {
    const admin = await h.login("admin@medveris.local");
    const response = await h.call(admin, "/api/v1/drugshop/overview");
    expect(response.status).toBe(403);
  });
});

describe("Drugshop dispensing restrictions", () => {
  it("sells over-the-counter stock and refuses everything not explicitly classified for a shop", async () => {
    const location = await post("/api/v1/inventory/locations", { code: `DS-${run}`, name: "Shop counter", locationType: "department-store" });
    locationId = location.location.id;

    async function createItem(suffix: string, overrides: Record<string, unknown> = {}): Promise<string> {
      const created = await post("/api/v1/inventory/items", {
        itemCode: `DS-${suffix}-${run}`,
        name: `Shop item ${suffix} ${run}`,
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

    otcItemId = await createItem("OTC", { dispensingScope: "otc" });
    unclassifiedItemId = await createItem("UNKNOWN");
    rxItemId = await createItem("RX", { dispensingScope: "prescription-only", prescriptionOnly: true });

    const listed = await h.expectOk(await h.call(session, "/api/v1/inventory/items?classification=consumable"));
    expect(listed.items.find((item: any) => item.id === otcItemId)).toMatchObject({ dispensingScope: "otc" });
    expect(listed.items.find((item: any) => item.id === unclassifiedItemId)).toMatchObject({ dispensingScope: "unverified" });

    for (const [suffix, itemId] of [["OTC", otcItemId], ["UNKNOWN", unclassifiedItemId], ["RX", rxItemId]] as const) {
      await post("/api/v1/inventory/receipts", {
        locationId, itemId, lotNumber: `${suffix}-LOT-${run}`, expiresOn: future,
        supplier: "Synthetic wholesaler", receiptReference: `GRN-${suffix}-${run}`,
        quantity: 50, unit: "tablet", reason: "Synthetic Drugshop stock",
      });
    }

    const sold = await post("/api/v1/pharmacy/sales", {
      locationId, paymentMethod: "cash", currency: "UGX",
      lines: [{ itemId: otcItemId, quantity: 2 }],
    });
    expect(sold.sale).toMatchObject({ status: "completed" });

    const blocked = await h.call(session, "/api/v1/pharmacy/sales", {
      method: "POST",
      body: JSON.stringify({ locationId, paymentMethod: "cash", currency: "UGX", lines: [{ itemId: unclassifiedItemId, quantity: 1 }] }),
    });
    expect(blocked.status).toBe(403);
    const blockedBody = await h.json(blocked);
    expect(blockedBody.error.code).toBe("dispensing_not_permitted");
    expect(blockedBody.error.details.denials[0].code).toBe("classification-unverified");

    const rxBlocked = await h.call(session, "/api/v1/pharmacy/sales", {
      method: "POST",
      body: JSON.stringify({ locationId, paymentMethod: "cash", currency: "UGX", lines: [{ itemId: rxItemId, quantity: 1 }] }),
    });
    expect(rxBlocked.status).toBe(403);
    expect((await h.json(rxBlocked)).error.details.denials[0].code).toBe("prescription-only");

    const actions = await auditActions();
    expect(actions.filter((action) => action === "pharmacy.dispense.blocked").length).toBeGreaterThanOrEqual(2);
    expect(actions).toContain("pharmacy.sale.complete");

    const overview = await get("/api/v1/drugshop/overview");
    expect(overview.stock.stockedItems).toBe(3);
    expect(overview.today.transactions).toBe(1);
    expect(overview.today.total).toBe(1000);
  });

  it("cannot reach the clinical pharmacy dispensing workflow by calling it directly", async () => {
    // Give this Drugshop the pharmacist role so the only remaining reason to refuse is the facility type.
    await withContext(h.sql, { tenantId, userId: ownerId, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => {
      await tx`
        update memberships set roles = array['owner', 'facility_admin', 'pharmacist']::text[]
         where user_id = ${ownerId} and tenant_id = ${tenantId}
      `;
    });

    const blocked = await h.call(session, "/api/v1/dispenses", {
      method: "POST",
      body: JSON.stringify({ orderId: crypto.randomUUID(), lotId: crypto.randomUUID(), quantity: 1 }),
    });
    expect(blocked.status).toBe(403);
    expect((await h.json(blocked)).error.message).toMatch(/Drugshop dispenses retail stock/i);

    const actions = await auditActions();
    expect(actions).toContain("pharmacy.dispense.blocked");
  });
});

describe("facility price list by default", () => {
  it("creates, prices, submits, approves and publishes the shop's own list", async () => {
    const created = await post("/api/v1/global-catalogue/lists", {
      code: `DS-UGX-${run}`,
      name: `Drugshop counter prices ${run}`,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      items: [{ name: `Shop item OTC ${run}`, category: "Pharmacy", price: 600, currency: "UGX" }],
    }, 201);
    priceListId = created.list.id;
    expect(created.list.status).toBe("DRAFT");

    const detail = await get(`/api/v1/global-catalogue/lists/${priceListId}`);
    expect(detail.items).toHaveLength(1);
    expect(detail.editable).toBe(true);
    const itemId = detail.items[0].id;

    await patch(`/api/v1/global-catalogue/lists/${priceListId}/items/${itemId}`, { price: 700, note: "Counter price review" });
    const repriced = await get(`/api/v1/global-catalogue/lists/${priceListId}`);
    expect(Number(repriced.items[0].price)).toBe(700);

    for (const action of ["validate", "submit", "approve", "publish"] as const) {
      await post(`/api/v1/global-catalogue/lists/${priceListId}/transition`, { action }, 200);
    }
    const published = await get(`/api/v1/global-catalogue/lists/${priceListId}`);
    expect(published.list.status).toBe("PUBLISHED");
    expect(published.editable).toBe(false);

    const history = await get(`/api/v1/global-catalogue/lists/${priceListId}/history`);
    expect(history.prices.length).toBeGreaterThanOrEqual(2);
    expect(history.prices.map((row: any) => Number(row.newPrice))).toEqual(expect.arrayContaining([600, 700]));
    expect(history.events.map((event: any) => event.action)).toEqual(
      expect.arrayContaining(["price.list.create", "price.list.publish"]),
    );
  });

  it("keeps the global master catalogue unchanged and prices in their own currency", async () => {
    const catalogue = await h.expectOk(await h.call(session, "/api/v1/global-catalogue/items"));
    expect(catalogue.canManage).toBe(false);
    const detail = await get(`/api/v1/global-catalogue/lists/${priceListId}`);
    expect(detail.items[0].currency).toBe("UGX");

    const mixed = await h.call(session, "/api/v1/global-catalogue/lists", {
      method: "POST",
      body: JSON.stringify({
        code: `DS-MIX-${run}`,
        name: `Mixed currency ${run}`,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        items: [
          { name: "UGX item", category: "Pharmacy", price: 100, currency: "UGX" },
          { name: "KES item", category: "Pharmacy", price: 100, currency: "KES" },
        ],
      }),
    });
    expect(mixed.status).toBe(201);
    const mixedId = (await h.json(mixed)).list.id;
    const rejected = await h.call(session, `/api/v1/global-catalogue/lists/${mixedId}/transition`, {
      method: "POST", body: JSON.stringify({ action: "validate" }),
    });
    expect(rejected.status).toBe(422);
    expect(JSON.stringify(await h.json(rejected))).toMatch(/one currency/i);
  });

  it("refuses price fiction from a role without the facility price permission", async () => {
    const pharmacist = await h.login("pharmacist@medveris.local");
    const response = await h.call(pharmacist, "/api/v1/global-catalogue/lists", {
      method: "POST",
      body: JSON.stringify({ code: `NOPE-${run}`, name: "Should not exist", effectiveFrom: new Date().toISOString().slice(0, 10) }),
    });
    expect(response.status).toBe(403);
  });

  it("does not let this facility touch another facility's private price list", async () => {
    const admin = await h.login("admin@medveris.local");
    const other = await h.expectOk(await h.call(admin, "/api/v1/global-catalogue/lists", {
      method: "POST",
      body: JSON.stringify({ code: `KLA-${run}`, name: `Kampala list ${run}`, effectiveFrom: new Date().toISOString().slice(0, 10) }),
    }), 201);

    const read = await h.call(session, `/api/v1/global-catalogue/lists/${other.list.id}`);
    expect(read.status).toBe(404);
    const write = await h.call(session, `/api/v1/global-catalogue/lists/${other.list.id}`, {
      method: "PATCH", body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(write.status).toBe(404);
    const listed = await get("/api/v1/global-catalogue/lists");
    expect(listed.lists.map((list: any) => list.id)).not.toContain(other.list.id);
  });
});
