import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for inventory tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true", FEATURE_DEVICES: "true", FEATURE_AI: "false", FEATURE_TELEMEDICINE: "false",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-inventory-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-inventory-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

interface Session { cookie: string; csrf: string; userId: string }

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const match = cookies.find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error(`no session cookie in ${cookies.join(", ")}`);
  return match.split(";")[0]!;
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, received ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function login(email: string): Promise<Session> {
  const challenge = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Medveris!2026" }),
  }));
  expect(challenge.status).toBe(200);
  const body = await json(challenge);
  if (!body.mfaRequired) {
    const me = await json(await app.fetch(new Request("http://localhost/api/v1/me", { headers: { cookie: sessionCookie(challenge) } })));
    return { cookie: sessionCookie(challenge), csrf: body.csrfToken, userId: me.user.id };
  }
  const dev = await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  expect(dev.status).toBe(200);
  const { code } = await json(dev);
  const mfa = await app.fetch(new Request("http://localhost/api/v1/auth/login/mfa", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: body.challengeId, code }),
  }));
  expect(mfa.status).toBe(200);
  const verified = await json(mfa);
  const cookie = sessionCookie(mfa);
  const me = await json(await app.fetch(new Request("http://localhost/api/v1/me", { headers: { cookie } })));
  return { cookie, csrf: verified.csrfToken, userId: me.user.id };
}

async function call(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", session.cookie);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(init.method ?? "GET")) headers.set("x-medveris-csrf", session.csrf);
  if (init.body) headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

async function expectOk(response: Response, status = 200): Promise<any> {
  const body = await json(response);
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

const stamp = Date.now();
const today = new Date().toISOString().slice(0, 10);
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

let admin: Session;
let pharmacist: Session;
let nurse: Session;
let biomedical: Session;
let finance: Session;

let centralId = "";
let wardId = "";
let itemId = "";
let lotItemId = "";
let policyId = "";
let requisitionId = "";
let requisitionLineId = "";
let transferId = "";
let countId = "";
let adjustmentId = "";
let assetId = "";

beforeAll(async () => {
  [admin, pharmacist, nurse, biomedical, finance] = await Promise.all([
    login("admin@medveris.local"),
    login("pharmacist@medveris.local"),
    login("nurse@medveris.local"),
    login("biomedical@medveris.local"),
    login("finance@medveris.local"),
  ]);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("departmental inventory, stock ledger and fixed assets", () => {
  it("creates the location hierarchy, catalogue items and replenishment policy", async () => {
    const central = await expectOk(await call(admin, "/api/v1/inventory/locations", {
      method: "POST",
      body: JSON.stringify({ code: `CTR-${stamp}`, name: "Main central store", locationType: "central-store" }),
    }), 201);
    centralId = central.location.id;

    const ward = await expectOk(await call(admin, "/api/v1/inventory/locations", {
      method: "POST",
      body: JSON.stringify({
        code: `WARD-${stamp}`, name: "Ward store", locationType: "ward-store",
        parentId: centralId, custodianUserId: nurse.userId,
      }),
    }), 201);
    wardId = ward.location.id;

    const item = await expectOk(await call(admin, "/api/v1/inventory/items", {
      method: "POST",
      body: JSON.stringify({
        itemCode: `CON-${stamp}`, name: `Sterile gloves ${stamp}`, category: "Ward consumables",
        classification: "consumable", baseUnit: "piece", criticality: "high", unitCost: 2500, currency: "UGX",
        units: [
          { unit: "piece", conversionFactor: 1, isBase: true, purchasingUnit: false, issuingUnit: true },
          { unit: "box", conversionFactor: 24, isBase: false, purchasingUnit: true, issuingUnit: false },
        ],
      }),
    }), 201);
    itemId = item.item.id;

    const lotItem = await expectOk(await call(admin, "/api/v1/inventory/items", {
      method: "POST",
      body: JSON.stringify({
        itemCode: `LOT-${stamp}`, name: `Test vaccine ${stamp}`, category: "Vaccines",
        classification: "consumable", baseUnit: "vial", criticality: "critical",
        lotTracked: true, expiryTracked: true, unitCost: 12000, currency: "UGX",
        units: [{ unit: "vial", conversionFactor: 1, isBase: true, purchasingUnit: false, issuingUnit: true }],
      }),
    }), 201);
    lotItemId = lotItem.item.id;

    const policy = await expectOk(await call(admin, "/api/v1/inventory/policies", {
      method: "POST",
      body: JSON.stringify({ locationId: centralId, itemId, minimumQuantity: 100, maximumQuantity: 500, reorderQuantity: 100, criticality: "high" }),
    }), 200);
    expect(policy.ok).toBe(true);
    const policies = await expectOk(await call(admin, "/api/v1/inventory/policies"));
    policyId = policies.policies.find((row: any) => row.itemId === itemId && row.locationId === centralId)?.id ?? "";
    expect(policyId).not.toBe("");
  });

  it("receives stock idempotently and shows live balances", async () => {
    const payload = {
      locationId: centralId, itemId, quantity: 100, unit: "piece", reason: "Opening stock for inventory integration test",
      receiptReference: `GRN-${stamp}`, supplier: "Synthetic Supplier",
    };
    const body = JSON.stringify(payload);
    const first = await expectOk(await call(pharmacist, "/api/v1/inventory/receipts", {
      method: "POST", headers: { "idempotency-key": `receipt-${stamp}` }, body,
    }), 201);
    expect(first.movement.movementType).toBe("receipt");
    const replay = await expectOk(await call(pharmacist, "/api/v1/inventory/receipts", {
      method: "POST", headers: { "idempotency-key": `receipt-${stamp}` }, body,
    }), 201);
    expect(replay.replayed).toBe(true);

    const stock = await expectOk(await call(nurse, "/api/v1/inventory/stock"));
    const row = stock.stock.find((candidate: any) => candidate.itemId === itemId && candidate.locationId === centralId);
    expect(row.onHand).toBe(100);
    expect(row.available).toBe(100);
  });

  it("issues stock, prevents overselling and keeps the ledger immutable", async () => {
    await expectOk(await call(nurse, "/api/v1/inventory/issues", {
      method: "POST", headers: { "idempotency-key": `issue-${stamp}` },
      body: JSON.stringify({
        locationId: centralId, itemId, quantity: 10, unit: "piece", destinationLocationId: wardId,
        movementType: "issue", reason: "Ward replenishment for integration test",
      }),
    }), 201);

    const oversell = await call(nurse, "/api/v1/inventory/issues", {
      method: "POST", headers: { "idempotency-key": `oversell-${stamp}` },
      body: JSON.stringify({
        locationId: centralId, itemId, quantity: 1000, unit: "piece", movementType: "issue",
        reason: "Deliberate oversell should fail",
      }),
    });
    expect(oversell.status).toBe(409);

    const invalidUnit = await call(nurse, "/api/v1/inventory/issues", {
      method: "POST", headers: { "idempotency-key": `badunit-${stamp}` },
      body: JSON.stringify({
        locationId: centralId, itemId, quantity: 1, unit: "crate", movementType: "issue",
        reason: "Unknown unit should fail validation",
      }),
    });
    expect(invalidUnit.status).toBe(422);

    const movements = await expectOk(await call(nurse, "/api/v1/inventory/movements"));
    expect(movements.movements.some((row: any) => row.itemId === itemId && row.movementType === "issue")).toBe(true);

    await expect(sql`update inventory_movements set reason = 'tampered' where item_id = ${itemId}`)
      .rejects.toThrow(/immutable_inventory_movement|permission denied/);
  });

  it("runs a requisition through separation of duties, approval and issue", async () => {
    const created = await expectOk(await call(nurse, "/api/v1/inventory/requisitions", {
      method: "POST",
      body: JSON.stringify({
        requestingLocationId: wardId, fulfillingLocationId: centralId,
        reason: "Ward request for integration-test gloves",
        lines: [{ itemId, quantity: 2, unit: "box" }],
      }),
    }), 201);
    requisitionId = created.requisition.id;

    await expectOk(await call(nurse, `/api/v1/inventory/requisitions/${requisitionId}/submit`, { method: "POST" }));

    const forbidden = await call(nurse, `/api/v1/inventory/requisitions/${requisitionId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Requester must not approve their own request", expectedVersion: 2 }),
    });
    expect(forbidden.status).toBe(403);

    const detail = await expectOk(await call(admin, `/api/v1/inventory/requisitions/${requisitionId}`));
    requisitionLineId = detail.lines[0].id;
    expect(detail.lines[0].requestedQuantity).toBe(2);

    await expectOk(await call(admin, `/api/v1/inventory/requisitions/${requisitionId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Approved for ward stock", expectedVersion: detail.requisition.version }),
    }));

    await expectOk(await call(pharmacist, `/api/v1/inventory/requisitions/${requisitionId}/issue`, {
      method: "POST", headers: { "idempotency-key": `req-issue-${stamp}` },
      body: JSON.stringify({ lineId: requisitionLineId, quantity: 1, unit: "box", expectedVersion: detail.requisition.version + 1 }),
    }), 201);

    const after = await expectOk(await call(admin, `/api/v1/inventory/requisitions/${requisitionId}`));
    expect(after.requisition.status).toBe("partially-issued");
    expect(after.lines[0].issuedQuantity).toBe(1);
  });

  it("dispatches and receives a transfer with receiver separation", async () => {
    const created = await expectOk(await call(admin, "/api/v1/inventory/transfers", {
      method: "POST",
      body: JSON.stringify({
        sourceLocationId: centralId, destinationLocationId: wardId,
        note: "Integration transfer", lines: [{ itemId, quantity: 10, unit: "piece" }],
      }),
    }), 201);
    transferId = created.transfer.id;

    const detail = await expectOk(await call(admin, `/api/v1/inventory/transfers/${transferId}`));
    await expectOk(await call(admin, `/api/v1/inventory/transfers/${transferId}/dispatch`, {
      method: "POST", body: JSON.stringify({ expectedVersion: detail.transfer.version }),
    }));

    const selfReceive = await call(admin, `/api/v1/inventory/transfers/${transferId}/receive`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ lineId: detail.lines[0].id, receivedQuantity: 10, rejectedQuantity: 0 }], expectedVersion: detail.transfer.version + 1 }),
    });
    expect(selfReceive.status).toBe(403);

    await expectOk(await call(pharmacist, `/api/v1/inventory/transfers/${transferId}/receive`, {
      method: "POST",
      body: JSON.stringify({ lines: [{ lineId: detail.lines[0].id, receivedQuantity: 10, rejectedQuantity: 0 }], expectedVersion: detail.transfer.version + 1 }),
    }));

    const received = await expectOk(await call(admin, `/api/v1/inventory/transfers/${transferId}`));
    expect(received.transfer.status).toBe("received");
    expect(received.lines[0].receivedQuantity).toBe(10);
  });

  it("posts a blind count variance and a separately approved adjustment", async () => {
    const stock = await expectOk(await call(admin, "/api/v1/inventory/stock?scope=all"));
    const central = stock.stock.find((row: any) => row.itemId === itemId && row.locationId === centralId);
    const counted = central.onHand - 2;

    const count = await expectOk(await call(admin, "/api/v1/inventory/counts", {
      method: "POST",
      body: JSON.stringify({ locationId: centralId, blind: true, note: "Cycle count", lines: [{ itemId, countedQuantity: counted, reasonCode: "miscount" }] }),
    }), 201);
    countId = count.count.id;

    const detail = await expectOk(await call(admin, `/api/v1/inventory/counts`));
    const countRow = detail.counts.find((row: any) => row.id === countId);
    expect(countRow.status).toBe("submitted");

    await expectOk(await call(pharmacist, `/api/v1/inventory/counts/${countId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Count evidence reviewed and accepted", expectedVersion: countRow.version }),
    }));

    const afterCount = await expectOk(await call(admin, "/api/v1/inventory/stock?scope=all"));
    const rowAfterCount = afterCount.stock.find((row: any) => row.itemId === itemId && row.locationId === centralId);
    expect(rowAfterCount.onHand).toBe(counted);

    const adjustment = await expectOk(await call(admin, "/api/v1/inventory/adjustments", {
      method: "POST",
      body: JSON.stringify({ locationId: centralId, itemId, quantityDelta: 7, unit: "piece", reasonCode: "correction", reason: "Correct delivered quantity after supplier note" }),
    }), 201);
    adjustmentId = adjustment.adjustment.id;

    const pending = await expectOk(await call(admin, "/api/v1/inventory/adjustments"));
    const adjustmentRow = pending.adjustments.find((row: any) => row.id === adjustmentId);
    await expectOk(await call(pharmacist, `/api/v1/inventory/adjustments/${adjustmentId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Supplier evidence verified", expectedVersion: adjustmentRow.version }),
    }));

    const afterAdjustment = await expectOk(await call(admin, "/api/v1/inventory/stock?scope=all"));
    const rowAfterAdjustment = afterAdjustment.stock.find((row: any) => row.itemId === itemId && row.locationId === centralId);
    expect(rowAfterAdjustment.onHand).toBe(counted + 7);
  });

  it("uses FEFO lot selection and supports recall acknowledgement", async () => {
    await expectOk(await call(pharmacist, "/api/v1/inventory/receipts", {
      method: "POST", headers: { "idempotency-key": `lot-a-${stamp}` },
      body: JSON.stringify({ locationId: centralId, itemId: lotItemId, lotNumber: `LOT-A-${stamp}`, expiresOn: future(20), quantity: 10, unit: "vial", reason: "Receive later-expiring vaccine lot" }),
    }), 201);
    await expectOk(await call(pharmacist, "/api/v1/inventory/receipts", {
      method: "POST", headers: { "idempotency-key": `lot-b-${stamp}` },
      body: JSON.stringify({ locationId: centralId, itemId: lotItemId, lotNumber: `LOT-B-${stamp}`, expiresOn: future(5), quantity: 10, unit: "vial", reason: "Receive earlier-expiring vaccine lot" }),
    }), 201);

    const lots = await expectOk(await call(admin, "/api/v1/inventory/lots"));
    const early = lots.lots.find((lot: any) => lot.lotNumber === `LOT-B-${stamp}`);
    expect(early).toBeTruthy();

    const issued = await expectOk(await call(nurse, "/api/v1/inventory/issues", {
      method: "POST", headers: { "idempotency-key": `fefo-${stamp}` },
      body: JSON.stringify({ locationId: centralId, itemId: lotItemId, quantity: 2, unit: "vial", movementType: "issue", reason: "FEFO should choose the earliest expiring lot" }),
    }), 201);
    expect(issued.movement.lotId).toBe(early.id);

    const recall = await expectOk(await call(pharmacist, "/api/v1/inventory/recalls", {
      method: "POST",
      body: JSON.stringify({ itemId: lotItemId, lotId: early.id, reason: "Cold-chain excursion identified in synthetic batch" }),
    }), 201);
    const recallId = recall.recall.id;
    await expectOk(await call(nurse, `/api/v1/inventory/recalls/${recallId}/acknowledge`, { method: "POST" }));

    const recalls = await expectOk(await call(admin, "/api/v1/inventory/recalls"));
    expect(recalls.recalls.find((row: any) => row.id === recallId).status).toBe("acknowledged");

    const updatedLots = await expectOk(await call(admin, "/api/v1/inventory/lots?status=recalled"));
    expect(updatedLots.lots.some((lot: any) => lot.id === early.id)).toBe(true);

    await expectOk(await call(admin, `/api/v1/inventory/recalls/${recallId}/close`, { method: "POST" }));
  });

  it("registers a fixed asset and enforces technical service release", async () => {
    const created = await expectOk(await call(admin, "/api/v1/inventory/assets", {
      method: "POST",
      body: JSON.stringify({
        assetTag: `AST-${stamp}`, name: "Synthetic infusion pump", manufacturer: "Medveris Labs", model: "IP-1",
        serialNumber: `SN-${stamp}`, locationId: centralId, acquisitionCost: 4500000, currency: "UGX",
        nextMaintenanceOn: today, maintenanceIntervalDays: 180,
      }),
    }), 201);
    assetId = created.asset.id;

    const initial = await expectOk(await call(admin, `/api/v1/inventory/assets/${assetId}`));
    await expectOk(await call(biomedical, `/api/v1/inventory/assets/${assetId}/events`, {
      method: "POST",
      body: JSON.stringify({ eventType: "commission", note: "Commissioned after incoming inspection", toStatus: "in-service", toCustody: "in-use", expectedVersion: initial.asset.version }),
    }));

    const forbidden = await call(nurse, `/api/v1/inventory/assets/${assetId}/events`, {
      method: "POST",
      body: JSON.stringify({ eventType: "fault", note: "Nurse should not change asset status", toStatus: "out-of-service", expectedVersion: initial.asset.version + 1 }),
    });
    expect(forbidden.status).toBe(403);

    const inService = await expectOk(await call(admin, `/api/v1/inventory/assets/${assetId}`));
    await expectOk(await call(biomedical, `/api/v1/inventory/assets/${assetId}/events`, {
      method: "POST",
      body: JSON.stringify({ eventType: "fault", note: "Reported occlusion alarm during synthetic test", toStatus: "out-of-service", toCustody: "maintenance", expectedVersion: inService.asset.version }),
    }));

    const broken = await expectOk(await call(admin, `/api/v1/inventory/assets/${assetId}`));
    await expectOk(await call(biomedical, `/api/v1/inventory/assets/${assetId}/events`, {
      method: "POST",
      body: JSON.stringify({ eventType: "service-release", note: "Repair verified by biomedical engineering", toStatus: "in-service", toCustody: "in-use", nextMaintenanceOn: today, expectedVersion: broken.asset.version }),
    }));

    const events = await expectOk(await call(admin, `/api/v1/inventory/assets/${assetId}`));
    expect(events.events.map((event: any) => event.eventType)).toEqual(expect.arrayContaining(["commission", "fault", "service-release"]));
  });

  it("serves role-scoped reports, audited CSV export and low-stock alerts", async () => {
    const denied = await call(nurse, "/api/v1/inventory/reports/valuation?scope=all");
    expect(denied.status).toBe(403);

    const valuation = await expectOk(await call(finance, "/api/v1/inventory/reports/valuation?scope=all"));
    expect(valuation.report.length).toBeGreaterThan(0);

    const csv = await call(finance, "/api/v1/inventory/reports/stock-on-hand?scope=all&format=csv");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).split("\n").length).toBeGreaterThan(1);

    const lowStock = await expectOk(await call(admin, "/api/v1/inventory/reports/low-stock?scope=all"));
    expect(lowStock.report.some((row: any) => row.itemCode === `CON-${stamp}`)).toBe(true);

    const maintenance = await expectOk(await call(admin, "/api/v1/inventory/reports/maintenance-due?scope=all"));
    expect(maintenance.report.some((row: any) => row.assetTag === `AST-${stamp}`)).toBe(true);

    const recalls = await expectOk(await call(admin, "/api/v1/inventory/reports/recall-status"));
    expect(recalls.report).toEqual([]);
  });
});
