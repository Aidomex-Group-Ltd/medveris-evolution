import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@medveris/db";
import { CLINICIAN_ID, KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("reliability");
const asStaff = { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff" as const, roles: ["clinician" as const] };

let reception: Session;
let clinician: Session;
let pharmacist: Session;

beforeAll(async () => {
  reception = await h.login("reception@medveris.local");
  clinician = await h.login("clinician@medveris.local");
  pharmacist = await h.login("pharmacist@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

async function encounterCount(patientId: string): Promise<number> {
  const rows = await withContext(h.sql, asStaff, async (tx) => tx`select count(*)::int as count from encounters where patient_id = ${patientId}`);
  return rows[0]!.count as number;
}

describe("duplicate submissions do not duplicate encounters", () => {
  it("replays a retried walk-in with the same idempotency key", async () => {
    const patientId = await h.registerPatient(reception);
    const key = `walk-in-${crypto.randomUUID()}`;
    const body = { patientId, type: "walk-in", reason: "Synthetic retry check" };
    const first = await h.post(reception, "/api/v1/encounters", body, 201, key);
    const retry = await h.post(reception, "/api/v1/encounters", body, 200, key);
    expect(retry.encounterId).toBe(first.encounterId);
    expect(retry.replayed).toBe(true);
    expect(await encounterCount(patientId)).toBe(1);
  });

  it("creates one encounter when the same submission arrives concurrently", async () => {
    const patientId = await h.registerPatient(reception);
    const key = `double-click-${crypto.randomUUID()}`;
    const body = JSON.stringify({ patientId, type: "walk-in", reason: "Synthetic double click" });
    const responses = await Promise.all([1, 2, 3].map(() => h.call(reception, "/api/v1/encounters", { method: "POST", body, idempotencyKey: key })));
    const payloads = await Promise.all(responses.map((response) => h.json(response)));
    expect(responses.every((response) => [200, 201].includes(response.status)), JSON.stringify(payloads)).toBe(true);
    expect(new Set(payloads.map((payload) => payload.encounterId)).size).toBe(1);
    expect(await encounterCount(patientId)).toBe(1);
  });

  it("refuses a second open encounter for the same appointment", async () => {
    const patientId = await h.registerPatient(reception);
    const appointment = await h.post(reception, "/api/v1/appointments", {
      patientId, startAt: new Date(Date.now() + 3_600_000).toISOString(), durationMinutes: 15, reason: "Synthetic check-in",
    });
    const appointmentId = appointment.appointment?.id ?? appointment.appointmentId;
    await h.post(reception, "/api/v1/encounters", { patientId, appointmentId, type: "scheduled", reason: "Check-in" });
    const second = await h.call(reception, "/api/v1/encounters", {
      method: "POST", body: JSON.stringify({ patientId, appointmentId, type: "scheduled", reason: "Check-in again" }),
    });
    expect(second.status).toBe(409);
    expect((await h.json(second)).error.details.encounterId).toBeTruthy();
    expect(await encounterCount(patientId)).toBe(1);
  });
});

describe("bed allocation is transactional", () => {
  it("lets only one of two concurrent admissions take the same available bed", async () => {
    const wards = await h.expectOk(await h.call(clinician, "/api/v1/wards"));
    const wardId = wards.wards[0].id;
    const bed = await h.post(clinician, `/api/v1/wards/${wardId}/beds`, { label: `RACE-${Date.now()}` });
    const admissions = await Promise.all([1, 2].map(async () => {
      const patientId = await h.registerPatient(reception);
      const encounter = await h.post(reception, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Synthetic admission race" });
      const admission = await h.post(clinician, "/api/v1/admissions", {
        patientId, encounterId: encounter.encounterId, wardType: "general", reason: "Synthetic concurrent bed request",
      });
      return admission.admission.id as string;
    }));
    const results = await Promise.all(admissions.map((admissionId) => h.call(clinician, `/api/v1/admissions/${admissionId}/bed`, {
      method: "POST", body: JSON.stringify({ bedId: bed.bed.id, expectedVersion: 1, reason: "Initial allocation" }),
    })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const active = await withContext(h.sql, asStaff, async (tx) => tx`
      select count(*)::int as count from bed_assignments where bed_id = ${bed.bed.id} and released_at is null
    `);
    expect(active[0]!.count).toBe(1);
  });
});

describe("dispensing never decrements stock unless the dispense is recorded", () => {
  async function prepare(quantity: number) {
    const medicine = await h.post(pharmacist, "/api/v1/medicines", {
      name: `Synthetic reliability medicine ${crypto.randomUUID().slice(0, 8)}`, strength: "5 mg", form: "tablet", route: "oral",
    });
    const lot = await h.post(pharmacist, "/api/v1/stock/lots", {
      medicineId: medicine.medicine.id, lotNumber: `REL-${Date.now()}`,
      expiresOn: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10), quantity, location: "Pharmacy main",
    });
    const patientId = await h.registerPatient(reception);
    const encounter = await h.post(reception, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Synthetic pharmacy" });
    const order = await h.post(clinician, "/api/v1/medication-orders", {
      patientId, encounterId: encounter.encounterId, medicineId: medicine.medicine.id, doseText: "5 mg", route: "oral", frequency: "once daily", durationDays: 5,
    });
    await h.post(pharmacist, `/api/v1/medication-orders/${order.order.id}/review`, { decision: "approved", note: "Synthetic review" }, 200);
    return { lotId: lot.lot.id as string, orderId: order.order.id as string };
  }

  async function ledger(lotId: string) {
    return withContext(h.sql, asStaff, async (tx) => {
      const [lot] = await tx`select quantity::numeric as quantity from stock_lots where id = ${lotId}`;
      const [movements] = await tx`select count(*)::int as count from stock_movements where lot_id = ${lotId} and delta < 0`;
      const [dispenses] = await tx`select count(*)::int as count from dispenses where lot_id = ${lotId}`;
      return { quantity: Number(lot!.quantity), movements: movements!.count as number, dispenses: dispenses!.count as number };
    });
  }

  it("leaves stock, movements and dispense records unchanged when the lot is insufficient", async () => {
    const { lotId, orderId } = await prepare(4);
    const response = await h.call(pharmacist, "/api/v1/dispenses", { method: "POST", body: JSON.stringify({ orderId, lotId, quantity: 5 }) });
    expect(response.status).toBe(409);
    expect(await ledger(lotId)).toEqual({ quantity: 4, movements: 0, dispenses: 0 });
  });

  it("serialises concurrent dispenses so stock never goes negative", async () => {
    const { lotId, orderId } = await prepare(50);
    const results = await Promise.all([1, 2].map(() => h.call(pharmacist, "/api/v1/dispenses", {
      method: "POST", body: JSON.stringify({ orderId, lotId, quantity: 30 }),
    })));
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await ledger(lotId)).toEqual({ quantity: 20, movements: 1, dispenses: 1 });
  });

  it("dispenses once when a submission is retried with the same idempotency key", async () => {
    const { lotId, orderId } = await prepare(50);
    const key = `dispense-${crypto.randomUUID()}`;
    const first = await h.post(pharmacist, "/api/v1/dispenses", { orderId, lotId, quantity: 10 }, 201, key);
    const retry = await h.post(pharmacist, "/api/v1/dispenses", { orderId, lotId, quantity: 10 }, 200, key);
    expect(retry.dispense.id).toBe(first.dispense.id);
    expect(await ledger(lotId)).toEqual({ quantity: 40, movements: 1, dispenses: 1 });
  });
});
