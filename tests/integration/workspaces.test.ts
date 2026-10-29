import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("workspaces");
const PASSWORD = "Synthetic-Workspace-2026!";
const run = crypto.randomUUID().slice(0, 8);
const email = (label: string) => `${label}.${run}.${crypto.randomUUID().slice(0, 6)}@example.test`;
const nhfr = (label: string) => `NHFR-${label}-${run}`;

function cookieFrom(response: Response): string {
  const match = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error("no session cookie");
  return match.split(";")[0]!;
}

async function anonymous(path: string, body: unknown): Promise<Response> {
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 20}` }, body: JSON.stringify(body),
  }));
}

function owner(label: string) {
  return { email: email(label), password: PASSWORD, givenName: "Synthetic", familyName: `Owner ${label}` };
}

async function register(body: unknown, status = 201): Promise<any> {
  const response = await anonymous("/api/v1/auth/register/workspace", body);
  const parsed = await h.json(response);
  expect(response.status, JSON.stringify(parsed)).toBe(status);
  return parsed;
}

/** Signs in a newly registered owner and enrols MFA, as the first sign-in does. */
async function signInOwner(address: string): Promise<Session> {
  const response = await anonymous("/api/v1/auth/login", { email: address, password: PASSWORD });
  const body = await h.json(response);
  expect(response.status, JSON.stringify(body)).toBe(200);
  const session = { cookie: cookieFrom(response), csrf: body.csrfToken };
  const started = await h.post(session, "/api/v1/auth/mfa/enroll/start", {}, 200);
  await h.post(session, "/api/v1/auth/mfa/enroll/verify", { code: await totpCode(started.secret) }, 200);
  return session;
}

async function useWorkspace(session: Session, tenantId: string): Promise<void> {
  await h.post(session, "/api/v1/me/context", { tenantId }, 200);
}

async function get(session: Session, path: string, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path), status);
}

async function put(session: Session, path: string, body: unknown, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path, { method: "PUT", body: JSON.stringify(body) }), status);
}

let admin: Session;

beforeAll(async () => {
  admin = await h.login("admin@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("onboarding keeps category, official level and Medveris equivalent apart", () => {
  it("refuses an inferred hospital level and a clinic equivalent above the suggestion without justification", async () => {
    const hospital = await register({
      path: "independent", owner: owner("hospital-guess"),
      workspace: { name: `Synthetic Guess Hospital ${run}`, serviceCategory: "hospital", ownership: "private-for-profit", levelStatus: "medveris-equivalent", equivalentLevel: "general-hospital" },
    }, 422);
    expect(hospital.error.message).toMatch(/never inferred/);
    await register({
      path: "independent", owner: owner("clinic-hc3"),
      workspace: { name: `Synthetic Scope Clinic ${run}`, serviceCategory: "clinic", serviceSubtype: "general-outpatient", ownership: "private-for-profit", levelStatus: "medveris-equivalent", equivalentLevel: "hc3" },
    }, 422);
  });

  it("creates a standalone drug shop with no care level and its licence kept as a registration", async () => {
    const shopOwner = owner("drugshop");
    const created = await register({
      path: "independent", owner: shopOwner,
      workspace: {
        name: `Synthetic Corner Drug Shop ${run}`, workspaceKind: "service-unit", serviceCategory: "drug-shop", ownership: "private-for-profit",
        levelStatus: "not-applicable", district: "Wakiso", registrations: [{ kind: "nda-drug-shop", identifier: `NDA-DS-${run}` }],
      },
    });
    expect(created.organization).toBeNull();
    const session = await signInOwner(shopOwner.email);
    const workspace = await get(session, "/api/v1/workspace");
    expect(workspace.workspace).toMatchObject({ serviceCategory: "drug-shop", levelStatus: "not-applicable", officialLevel: null, equivalentLevel: null, organizationId: null });
    expect(workspace.level.label).toBe("No standalone care level assigned");
    expect(workspace.registrations).toEqual([expect.objectContaining({ kind: "nda-drug-shop", identifier: `NDA-DS-${run}`, status: "recorded" })]);
    expect(workspace.recommendations.hmisCandidates).toEqual([]);
    expect(workspace.permissions).toMatchObject({ manage: true, link: true });
    const me = await get(session, "/api/v1/me");
    expect(me.activeTenant.roles).toEqual(expect.arrayContaining(["owner", "facility_admin"]));
  });

  it("records a clinic's HC II-equivalent and keeps the earlier value when an official level is confirmed", async () => {
    const clinicOwner = owner("clinic");
    const created = await register({
      path: "independent", owner: clinicOwner,
      workspace: { name: `Synthetic Hillside Clinic ${run}`, serviceCategory: "clinic", serviceSubtype: "general-outpatient", ownership: "private-not-for-profit", levelStatus: "medveris-equivalent", equivalentLevel: "hc2" },
    });
    const session = await signInOwner(clinicOwner.email);
    const before = await get(session, "/api/v1/workspace");
    expect(before.level).toMatchObject({ status: "medveris-equivalent", official: false });
    expect(before.level.label).toContain("Medveris equivalent — confirm service scope");
    await put(session, "/api/v1/workspace/profile", {
      name: `Synthetic Hillside Clinic ${run}`, serviceCategory: "clinic", serviceSubtype: "general-outpatient", ownership: "private-not-for-profit",
      levelStatus: "official", officialLevel: "hc3", officialLevelSource: "nhfr", officialLevelReference: nhfr("hillside"),
    });
    const after = await get(session, "/api/v1/workspace");
    expect(after.workspace).toMatchObject({ id: created.workspace.id, levelStatus: "official", officialLevel: "hc3", equivalentLevel: null });
    expect(after.level.official).toBe(true);
    expect(after.levelHistory.map((entry: any) => entry.levelStatus)).toEqual(["official", "medveris-equivalent"]);
    const downgrade = await h.call(session, "/api/v1/workspace/profile", { method: "PUT", body: JSON.stringify({
      name: `Synthetic Hillside Clinic ${run}`, serviceCategory: "clinic", ownership: "private-not-for-profit", levelStatus: "not-yet-assigned",
    }) });
    expect(downgrade.status).toBe(422);
  });

  it("refuses a second workspace for an NHFR ID that is already onboarded", async () => {
    const id = nhfr("dup");
    const workspace = { serviceCategory: "health-centre", ownership: "private-not-for-profit", levelStatus: "official", officialLevel: "hc3", officialLevelSource: "nhfr", officialLevelReference: id, registrations: [{ kind: "nhfr-id", identifier: id }] };
    await register({ path: "independent", owner: owner("hc-a"), workspace: { name: `Synthetic HC A ${run}`, ...workspace } });
    const duplicate = await register({ path: "independent", owner: owner("hc-b"), workspace: { name: `Synthetic HC B ${run}`, ...workspace } }, 409);
    expect(duplicate.error.message).toMatch(/already recorded/);
  });
});

describe("organizations, sites and explicit linking", () => {
  let orgOwner: Session;
  let organizationId = "";
  let hospitalId = "";
  let pharmacyUnitId = "";
  let clinicOwner: Session;
  let clinicId = "";
  const hospitalName = `Synthetic Lakeside Hospital ${run}`;

  it("creates an organization with its first hospital site and adds a pharmacy unit that inherits the hospital level for roll-ups", async () => {
    const ownerInput = owner("org");
    const created = await register({
      path: "organization", owner: ownerInput,
      organization: { name: `Synthetic Lakeside Health ${run}`, kind: "hospital", ownership: "private-not-for-profit" },
      workspace: { name: hospitalName, serviceCategory: "hospital", ownership: "private-not-for-profit", levelStatus: "official", officialLevel: "general-hospital", officialLevelSource: "nhfr", officialLevelReference: nhfr("lakeside") },
    });
    organizationId = created.organization.id;
    hospitalId = created.workspace.id;
    orgOwner = await signInOwner(ownerInput.email);
    const list = await get(orgOwner, "/api/v1/organizations");
    expect(list.organizations).toEqual([expect.objectContaining({ id: organizationId, role: "organization_owner", activeSites: 1 })]);

    const site = await h.post(orgOwner, `/api/v1/organizations/${organizationId}/sites`, {
      name: `Synthetic Lakeside Pharmacy ${run}`, workspaceKind: "service-unit", serviceCategory: "pharmacy", ownership: "private-not-for-profit",
      levelStatus: "not-applicable", hostTenantId: hospitalId,
    });
    pharmacyUnitId = site.site.id;
    const detail = await get(orgOwner, `/api/v1/organizations/${organizationId}`);
    const pharmacy = detail.sites.find((entry: any) => entry.tenantId === pharmacyUnitId);
    expect(pharmacy.level.label).toBe("No standalone care level assigned");
    expect(pharmacy.rollUpLevel).toMatchObject({ hostName: hospitalName, inherited: true });
    expect(pharmacy.rollUpLevel.label).toContain("General / District Hospital");
  });

  it("links an independent workspace only after administrator approval, from the approval date by default", async () => {
    const code = await h.post(orgOwner, `/api/v1/organizations/${organizationId}/join-codes`, { label: "Hillside clinic", maxUses: 1 });
    const clinicInput = owner("joiner");
    const created = await register({
      path: "independent", owner: clinicInput,
      workspace: { name: `Synthetic Joining Clinic ${run}`, serviceCategory: "clinic", ownership: "private-for-profit", levelStatus: "not-yet-assigned" },
    });
    clinicId = created.workspace.id;
    clinicOwner = await signInOwner(clinicInput.email);
    const requested = await h.post(clinicOwner, "/api/v1/workspace/organization/link-request", { joinCode: code.joinCode.code });
    expect(requested.link.status).toBe("pending");
    const reused = await h.call(clinicOwner, "/api/v1/workspace/organization/link-request", { method: "POST", body: JSON.stringify({ joinCode: code.joinCode.code }) });
    expect(reused.status).toBe(409);

    const pendingReport = await get(orgOwner, `/api/v1/organizations/${organizationId}/reports/summary?from=2026-01-01&to=2026-01-31`);
    expect(pendingReport.sites.map((site: any) => site.tenantId)).not.toContain(clinicId);

    const detail = await get(orgOwner, `/api/v1/organizations/${organizationId}`);
    const pending = detail.sites.find((site: any) => site.tenantId === clinicId);
    expect(pending.status).toBe("pending");
    await h.post(orgOwner, `/api/v1/organizations/${organizationId}/links/${pending.linkId}/decision`, { decision: "approve", note: "Clinic contract signed" }, 200);

    const report = await get(orgOwner, `/api/v1/organizations/${organizationId}/reports/summary?from=2026-01-01&to=2026-12-31`);
    const linked = report.sites.find((site: any) => site.tenantId === clinicId);
    expect(linked).toMatchObject({ historyVisibility: "from-link-date" });
    expect(linked.visibleFrom).toBeTruthy();
    expect(report.notes.join(" ")).toMatch(/never opens patient-level records/);

    await h.post(clinicOwner, "/api/v1/workspace/organization/history", { reason: "Share last year's activity for the group report" }, 200);
    const shared = await get(orgOwner, `/api/v1/organizations/${organizationId}/reports/summary?from=2026-01-01&to=2026-12-31`);
    expect(shared.sites.find((site: any) => site.tenantId === clinicId)).toMatchObject({ historyVisibility: "full-history", visibleFrom: null });
  });

  it("does not give organization staff access to a linked workspace's records", async () => {
    const switched = await h.call(orgOwner, "/api/v1/me/context", { method: "POST", body: JSON.stringify({ tenantId: clinicId }) });
    expect([403, 404]).toContain(switched.status);
    const csv = await h.call(orgOwner, `/api/v1/organizations/${organizationId}/reports/summary?from=2026-01-01&to=2026-12-31&format=csv`);
    expect(csv.status).toBe(200);
    expect(await csv.text()).not.toMatch(/MV-[0-9A-Z]{4}-/);
    const outsider = await h.call(admin, `/api/v1/organizations/${organizationId}`);
    expect(outsider.status).toBe(404);
  });

  it("holds a possible duplicate site for an explicit resolution before approval", async () => {
    const code = await h.post(orgOwner, `/api/v1/organizations/${organizationId}/join-codes`, { label: "Possible duplicate" });
    const created = await register({
      path: "join", owner: owner("dup-site"), joinCode: code.joinCode.code,
      workspace: { name: hospitalName.toUpperCase(), serviceCategory: "hospital", ownership: "private-not-for-profit", levelStatus: "not-yet-assigned" },
    });
    expect(created.link).toMatchObject({ status: "pending" });
    const detail = await get(orgOwner, `/api/v1/organizations/${organizationId}`);
    const pending = detail.sites.find((site: any) => site.tenantId === created.workspace.id);
    expect(pending.duplicateFindings).toEqual([expect.objectContaining({ tenantId: hospitalId, reason: "same name" })]);
    const blocked = await h.call(orgOwner, `/api/v1/organizations/${organizationId}/links/${pending.linkId}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Looks right" }),
    });
    expect(blocked.status).toBe(422);
    await h.post(orgOwner, `/api/v1/organizations/${organizationId}/links/${pending.linkId}/decision`, { decision: "reject", note: "Same hospital registered twice" }, 200);
  });

  it("moves stock between sites only after both sites accept shared supply, posting to each site's own ledger", async () => {
    const detail = await get(orgOwner, `/api/v1/organizations/${organizationId}`);
    for (const tenantId of [hospitalId, pharmacyUnitId]) {
      const link = detail.sites.find((site: any) => site.tenantId === tenantId);
      await h.post(orgOwner, `/api/v1/organizations/${organizationId}/links/${link.linkId}/inventory-mode`, { mode: "shared-supply", note: "Central pharmacy supplies the hospital" }, 200);
    }
    await useWorkspace(orgOwner, hospitalId);
    const store = await h.post(orgOwner, "/api/v1/inventory/locations", { code: `HOSP-${run}`, name: "Hospital main store", locationType: "central-store" });
    const item = await h.post(orgOwner, "/api/v1/inventory/items", {
      itemCode: `GAU-${run}`, name: `Gauze swabs ${run}`, category: "Dressings", classification: "consumable", baseUnit: "pack", criticality: "high",
      units: [{ unit: "pack", conversionFactor: 1, isBase: true, purchasingUnit: true, issuingUnit: true }],
    });
    await h.post(orgOwner, "/api/v1/inventory/receipts", { locationId: store.location.id, itemId: item.item.id, quantity: 100, unit: "pack", reason: "Opening stock" }, 201, crypto.randomUUID());
    const early = await h.call(orgOwner, "/api/v1/workspace/shared-supply/transfers", { method: "POST", body: JSON.stringify({
      destinationTenantId: pharmacyUnitId, sourceLocationId: store.location.id, itemId: item.item.id, quantity: 10, unit: "pack", reason: "Top-up",
    }) });
    expect(early.status).toBe(409);

    await h.post(orgOwner, "/api/v1/workspace/organization/inventory-mode", { accept: true, note: "Hospital agrees" }, 200);
    await useWorkspace(orgOwner, pharmacyUnitId);
    await h.post(orgOwner, "/api/v1/workspace/organization/inventory-mode", { accept: true, note: "Pharmacy agrees" }, 200);
    const shelf = await h.post(orgOwner, "/api/v1/inventory/locations", { code: `PHA-${run}`, name: "Pharmacy shelf", locationType: "department-store" });
    const pharmacyItem = await h.post(orgOwner, "/api/v1/inventory/items", {
      itemCode: `GAU-${run}`, name: `Gauze swabs ${run}`, category: "Dressings", classification: "consumable", baseUnit: "pack", criticality: "high",
      units: [{ unit: "pack", conversionFactor: 1, isBase: true, purchasingUnit: true, issuingUnit: true }],
    });

    await useWorkspace(orgOwner, hospitalId);
    const dispatched = await h.post(orgOwner, "/api/v1/workspace/shared-supply/transfers", {
      destinationTenantId: pharmacyUnitId, sourceLocationId: store.location.id, itemId: item.item.id, quantity: 30, unit: "pack", reason: "Weekly top-up",
    });
    const hospitalStock = await get(orgOwner, `/api/v1/inventory/stock?locationId=${store.location.id}`);
    expect(Number(hospitalStock.stock[0].onHand)).toBe(70);

    await useWorkspace(orgOwner, pharmacyUnitId);
    await h.post(orgOwner, `/api/v1/workspace/shared-supply/transfers/${dispatched.transfer.id}/receive`, {
      destinationLocationId: shelf.location.id, destinationItemId: pharmacyItem.item.id, receivedQuantity: 30,
    }, 200);
    const pharmacyStock = await get(orgOwner, `/api/v1/inventory/stock?scope=all&locationId=${shelf.location.id}`);
    expect(Number(pharmacyStock.stock[0].onHand)).toBe(30);
    const supply = await get(orgOwner, "/api/v1/workspace/shared-supply");
    expect(supply.transfers.find((transfer: any) => transfer.id === dispatched.transfer.id)).toMatchObject({ status: "received", outgoing: false });
  });
});

describe("autonomous department operations", () => {
  it("requires a department scope for a department administrator invitation", async () => {
    const departments = await get(admin, "/api/v1/organization/departments");
    const department = departments.departments[0];
    const unscoped = await h.call(admin, "/api/v1/admin/invitations", { method: "POST", body: JSON.stringify({ email: email("dept"), roles: ["department_admin"] }) });
    expect(unscoped.status).toBe(422);
    await h.post(admin, "/api/v1/admin/invitations", { email: email("dept"), roles: ["department_admin"], scopeDepartmentId: department.id });
  });

  it("runs purchasing from supplier to stock receipt inside one workspace", async () => {
    await useWorkspace(admin, KAMPALA_TENANT);
    const departments = await get(admin, "/api/v1/organization/departments");
    const departmentId = departments.departments[0].id;
    const location = await h.post(admin, "/api/v1/inventory/locations", { code: `PO-${run}`, name: "Procurement receiving store", locationType: "department-store", departmentId });
    const item = await h.post(admin, "/api/v1/inventory/items", {
      itemCode: `GLV-${run}`, name: `Examination gloves ${run}`, category: "Consumables", classification: "consumable", baseUnit: "piece", criticality: "medium",
      lotTracked: true, expiryTracked: true,
      units: [
        { unit: "piece", conversionFactor: 1, isBase: true, purchasingUnit: false, issuingUnit: true },
        { unit: "box", conversionFactor: 100, isBase: false, purchasingUnit: true, issuingUnit: false },
      ],
    });
    const supplier = await h.post(admin, "/api/v1/procurement/suppliers", { code: `SUP-${run.toUpperCase()}`, name: "Synthetic Medical Supplies Ltd" });
    const order = await h.post(admin, "/api/v1/procurement/purchase-orders", {
      supplierId: supplier.id, destinationLocationId: location.location.id, departmentId,
      lines: [{ itemId: item.item.id, unit: "box", quantity: 3, unitPrice: 25000 }],
    });
    const early = await h.call(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}/receive`, {
      method: "POST", body: JSON.stringify({ expectedVersion: 1, lines: [{ lineId: crypto.randomUUID(), quantity: 1 }] }),
    });
    expect(early.status).toBe(409);
    await h.post(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}/action`, { action: "submit", expectedVersion: 1 }, 200);
    await h.post(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}/action`, { action: "approve", expectedVersion: 2 }, 200);
    const detail = await get(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}`);
    const lineId = detail.lines[0].id;
    const missingLot = await h.call(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}/receive`, {
      method: "POST", body: JSON.stringify({ expectedVersion: 3, lines: [{ lineId, quantity: 2 }] }),
    });
    expect(missingLot.status).toBe(422);
    const partial = await h.post(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}/receive`, {
      expectedVersion: 3, lines: [{ lineId, quantity: 2, lotNumber: `LOT-${run}`, expiresOn: "2028-12-31" }],
    }, 200);
    expect(partial.status).toBe("partially-received");
    const over = await h.call(admin, `/api/v1/procurement/purchase-orders/${order.purchaseOrder.id}/receive`, {
      method: "POST", body: JSON.stringify({ expectedVersion: 4, lines: [{ lineId, quantity: 2, lotNumber: `LOT-${run}`, expiresOn: "2028-12-31" }] }),
    });
    expect(over.status).toBe(409);
    const stock = await get(admin, `/api/v1/inventory/stock?scope=all&locationId=${location.location.id}`);
    expect(Number(stock.stock[0].onHand)).toBe(200);

    const today = new Date().toISOString().slice(0, 10);
    const report = await get(admin, `/api/v1/reports/department-operations?from=${today}&to=${today}&departmentId=${departmentId}`);
    expect(report.rows.length).toBeGreaterThan(0);
  });
});
