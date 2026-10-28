import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@medveris/db";
import { csvCell } from "../../apps/api/src/routes/reports.js";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("reports");
const TZ = "Africa/Kampala";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

let reception: Session;
let clinician: Session;
let pharmacist: Session;
let finance: Session;
let admin: Session;
let privacy: Session;

beforeAll(async () => {
  reception = await h.login("reception@medveris.local");
  clinician = await h.login("clinician@medveris.local");
  pharmacist = await h.login("pharmacist@medveris.local");
  finance = await h.login("finance@medveris.local");
  admin = await h.login("admin@medveris.local");
  await h.post(admin, "/api/v1/me/context", { tenantId: KAMPALA_TENANT }, 200);
  privacy = await h.login("privacy@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

async function report(session: Session, id: string, extra = "") {
  return h.expectOk(await h.call(session, `/api/v1/reports/${id}?from=${today}&to=${today}&timeZone=${TZ}${extra}`));
}

describe("reporting catalogue and access", () => {
  it("lists only reports the active role may run", async () => {
    const forReception = await h.expectOk(await h.call(reception, "/api/v1/reports"));
    const ids = forReception.reports.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining(["daily-activity", "appointments", "waiting-times"]));
    expect(ids).not.toContain("lab-turnaround");
    expect(ids).not.toContain("financial-reconciliation");
  });

  it("refuses a report whose source records the role cannot see, instead of returning zeros", async () => {
    expect((await h.call(admin, `/api/v1/reports/lab-turnaround?from=${today}&to=${today}`)).status).toBe(403);
    expect((await h.call(reception, `/api/v1/reports/audit-security?from=${today}&to=${today}`)).status).toBe(403);
  });

  it("validates the period and time zone", async () => {
    expect((await h.call(reception, "/api/v1/reports/daily-activity?from=2026-01-01&to=2027-06-01")).status).toBe(422);
    expect((await h.call(reception, `/api/v1/reports/daily-activity?from=${today}&to=2026-01-01`)).status).toBe(422);
    expect((await h.call(reception, `/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=Mars/Olympus`)).status).toBe(422);
  });
});

describe("reports match the records they are derived from", () => {
  it("counts registrations and walk-in encounters on the local day", async () => {
    const before = (await report(reception, "daily-activity")).rows[0];
    const patientA = await h.registerPatient(reception);
    await h.registerPatient(reception);
    await h.post(reception, "/api/v1/encounters", { patientId: patientA, type: "walk-in", reason: "Synthetic report fixture" });
    const after = await report(reception, "daily-activity");
    expect(after.metadata).toMatchObject({ report: "daily-activity", from: today, to: today, timeZone: TZ, facility: expect.stringContaining("Kampala") });
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].registrations - before.registrations).toBe(2);
    expect(after.rows[0].walkIns - before.walkIns).toBe(1);
    expect(after.rows[0].encountersOpened - before.encountersOpened).toBe(1);
  });

  it("reports a genuine zero for an empty period rather than an unavailable state", async () => {
    const empty = await h.expectOk(await h.call(reception, `/api/v1/reports/appointments?from=2001-01-01&to=2001-01-31&timeZone=${TZ}`));
    expect(empty.state).toBe("ok");
    expect(empty.rows[0]).toMatchObject({ total: 0, noShow: 0, noShowRatePercent: null });
  });

  it("aggregates staff workload across records the administrator cannot read", async () => {
    const workload = async () => (await report(admin, "staff-workload")).rows.find((row: { displayName: string }) => row.displayName === "Paul Pharmacist");
    const before = await workload();
    const medicineName = `Report medicine ${Date.now()}`;
    const medicine = await h.post(pharmacist, "/api/v1/medicines", { name: medicineName, strength: "5 mg", form: "tablet", route: "oral" });
    const lot = await h.post(pharmacist, "/api/v1/stock/lots", {
      medicineId: medicine.medicine.id, lotNumber: `RPT-${Date.now()}`, expiresOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), quantity: 20, location: "Pharmacy main",
    });
    const patientId = await h.registerPatient(reception);
    const encounter = await h.post(reception, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Synthetic" });
    const order = await h.post(clinician, "/api/v1/medication-orders", {
      patientId, encounterId: encounter.encounterId, medicineId: medicine.medicine.id, doseText: "5 mg", route: "oral", frequency: "once daily", durationDays: 3,
    });
    await h.post(pharmacist, `/api/v1/medication-orders/${order.order.id}/review`, { decision: "approved", note: "Synthetic review" }, 200);
    await h.post(pharmacist, "/api/v1/dispenses", { orderId: order.order.id, lotId: lot.lot.id, quantity: 6 });
    const after = await workload();
    expect(after.dispenses - before.dispenses).toBe(1);

    const stock = await report(pharmacist, "pharmacy-stock", "&expiryWindowDays=60");
    const row = stock.rows.find((item: { medicine: string }) => item.medicine === `${medicineName} 5 mg`);
    expect(row).toMatchObject({ lotsInStock: 1 });
    expect(Number(row.onHand)).toBe(14);
    expect(Number(row.dispensedInPeriod)).toBe(6);
    expect(Number(row.expiringQuantity)).toBe(14);
    expect(stock.notes).toContain("Expiry window: 60 days");
  });

  it("reconciles billed and paid amounts and states that payments are not provider-confirmed", async () => {
    const before = (await report(finance, "financial-reconciliation")).rows.find((row: { currency: string }) => row.currency === "UGX") ?? { billed: "0", paid: "0", invoices: 0 };
    const patientId = await h.registerPatient(reception);
    const encounter = await h.post(reception, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Synthetic billing" });
    const invoice = await h.post(finance, "/api/v1/invoices", { patientId, encounterId: encounter.encounterId, items: [{ description: "=HYPERLINK(\"x\")", quantity: 2, unitPrice: 10000 }] });
    await h.post(finance, `/api/v1/invoices/${invoice.invoice.id}/payments`, { invoiceId: invoice.invoice.id, amount: 5000, method: "cash", reference: "SYNTH-RPT" });
    const after = await report(finance, "financial-reconciliation");
    const ugx = after.rows.find((row: { currency: string }) => row.currency === "UGX");
    expect(ugx.invoices - before.invoices).toBe(1);
    expect(Number(ugx.billed) - Number(before.billed)).toBe(20000);
    expect(Number(ugx.paid) - Number(before.paid)).toBe(5000);
    expect(after.summary[0]).toMatchObject({ label: "Provider-confirmed payments", value: "unavailable" });
  });

  it("lets the privacy officer review audit counts and audits CSV exports", async () => {
    const audit = await report(privacy, "audit-security");
    expect(audit.rows.length).toBeGreaterThan(0);
    const csv = await h.call(finance, `/api/v1/reports/financial-reconciliation?from=${today}&to=${today}&timeZone=${TZ}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\r\n")[1]).toBe("Currency,Invoices,Voided,Billed,Recorded payments,Reversed payments,Outstanding,Invoices paid above total");
    const exports = await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actorKind: "staff", roles: ["facility_admin"] },
      async (tx) => tx`select count(*)::int as count from audit_events where action = 'report.export' and metadata->>'report' = 'financial-reconciliation'`);
    expect(exports[0]!.count).toBeGreaterThan(0);
  });

  it("guards CSV cells against spreadsheet formula injection", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });
});
