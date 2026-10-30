import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, KAMPALA_TENANT } from "./support.js";

const h = createHarness("notifications");
const stamp = Date.now();

let admin: Awaited<ReturnType<typeof h.login>>;
let pharmacist: Awaited<ReturnType<typeof h.login>>;
let clinician: Awaited<ReturnType<typeof h.login>>;
let locationId = "";
let itemId = "";
let policyId = "";

beforeAll(async () => {
  [admin, pharmacist, clinician] = await Promise.all([
    h.login("admin@medveris.local"),
    h.login("pharmacist@medveris.local"),
    h.login("clinician@medveris.local"),
  ]);

  const location = await h.post(admin, "/api/v1/inventory/locations", {
    code: `NTF-LOC-${stamp}`, name: `Notification store ${stamp}`, locationType: "central-store",
  }, 201);
  locationId = location.location.id;

  const item = await h.post(admin, "/api/v1/inventory/items", {
    itemCode: `NTF-ITEM-${stamp}`, name: `Notification gloves ${stamp}`, category: "Ward consumables",
    classification: "consumable", baseUnit: "piece", criticality: "high", unitCost: 1000, currency: "UGX",
    units: [{ unit: "piece", conversionFactor: 1, isBase: true, purchasingUnit: false, issuingUnit: true }],
  }, 201);
  itemId = item.item.id;

  await h.expectOk(await h.call(admin, "/api/v1/inventory/policies", {
    method: "POST",
    body: JSON.stringify({ locationId, itemId, minimumQuantity: 25, maximumQuantity: 100, reorderQuantity: 25, criticality: "high" }),
  }));
  const policies = await h.expectOk(await h.call(admin, "/api/v1/inventory/policies"));
  policyId = policies.policies.find((row: { itemId: string; locationId: string }) => row.itemId === itemId && row.locationId === locationId)?.id ?? "";
  expect(policyId).not.toBe("");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

async function scan(): Promise<number> {
  const rows = await h.sql`select app.enqueue_inventory_notifications() as inserted`;
  return Number(rows[0]?.inserted ?? 0);
}

async function inbox(session: typeof admin): Promise<any[]> {
  const body = await h.expectOk(await h.call(session, "/api/v1/notifications?limit=100"));
  return body.notifications as any[];
}

describe("operational notification inbox", () => {
  it("enqueues low-stock notifications for inventory managers only", async () => {
    await scan();

    const adminInbox = await inbox(admin);
    const lowStock = adminInbox.find((row) => row.resourceId === policyId && row.kind === "low-stock");
    expect(lowStock, JSON.stringify(adminInbox)).toBeTruthy();
    expect(lowStock.title).toContain(`Notification gloves ${stamp}`);

    const pharmacistInbox = await inbox(pharmacist);
    expect(pharmacistInbox.some((row) => row.resourceId === policyId)).toBe(true);

    const clinicianInbox = await inbox(clinician);
    expect(clinicianInbox.some((row) => row.resourceId === policyId)).toBe(false);
  });

  it("is idempotent for a given day", async () => {
    await scan();
    const rows = (await inbox(admin)).filter((row) => row.resourceId === policyId && row.kind === "low-stock");
    expect(rows).toHaveLength(1);
  });

  it("acknowledges a notification and audits the read", async () => {
    const unread = await h.expectOk(await h.call(admin, "/api/v1/notifications?unread=true&limit=100"));
    const target = unread.notifications.find((row: any) => row.resourceId === policyId);
    expect(target).toBeTruthy();

    const read = await h.expectOk(await h.call(admin, `/api/v1/notifications/${target.id}/read`, { method: "POST" }));
    expect(read.notification.readAt).not.toBeNull();

    const after = await h.expectOk(await h.call(admin, "/api/v1/notifications?unread=true&limit=100"));
    expect(after.notifications.some((row: any) => row.id === target.id)).toBe(false);

    const me = await h.expectOk(await h.call(admin, "/api/v1/me"));
    const audit = await h.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${KAMPALA_TENANT}, true),
                      set_config('app.user_id', ${me.user.id}, true),
                      set_config('app.actor_kind', 'staff', true),
                      set_config('app.roles', 'facility_admin', true)`;
      return tx`
        select action, resource_id from audit_events
         where action = 'notification.read' and resource_id = ${target.id}`;
    });
    expect(audit).toHaveLength(1);
  });

  it("hides another recipient's notification from reads and acknowledgements", async () => {
    const adminInbox = await inbox(admin);
    const target = adminInbox.find((row) => row.resourceId === policyId);
    expect(target).toBeTruthy();

    const otherInbox = await inbox(clinician);
    expect(otherInbox.some((row) => row.id === target.id)).toBe(false);

    const response = await h.call(clinician, `/api/v1/notifications/${target.id}/read`, { method: "POST" });
    expect(response.status).toBe(404);
  });
});
