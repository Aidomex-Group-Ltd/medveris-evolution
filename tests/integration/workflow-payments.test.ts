import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const yoPublicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function yoSign(data: string): string {
  const signer = createSign("RSA-SHA1");
  signer.update(data);
  return signer.sign(keys.privateKey).toString("base64");
}

/** Fake Yo! gateway: deposits answer PENDING; status checks answer whatever the test sets for the reference. */
const yoRequests: string[] = [];
const statusByReference = new Map<string, string>();
let transactionCounter = 0;

async function fakeYo(_url: string, init?: RequestInit): Promise<Response> {
  const body = String(init?.body ?? "");
  yoRequests.push(body);
  const reference = /<(?:ExternalReference|PrivateTransactionReference)>([^<]+)</.exec(body)?.[1] ?? "";
  if (body.includes("<Method>acdepositfunds</Method>")) {
    transactionCounter += 1;
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Response><Status>OK</Status><StatusCode>1</StatusCode><TransactionStatus>PENDING</TransactionStatus><TransactionReference>YO-TX-${transactionCounter}-${reference.slice(-6)}</TransactionReference></Response></AutoCreate>`);
  }
  const status = statusByReference.get(reference) ?? "PENDING";
  return new Response(`<AutoCreate><Response><Status>OK</Status><StatusCode>${status === "PENDING" ? 1 : 0}</StatusCode><TransactionStatus>${status}</TransactionStatus></Response></AutoCreate>`);
}

const h = createHarness("workflow", {
  env: { FEATURE_PAYMENTS: "true", YO_MODE: "sandbox", YO_API_USERNAME: "synthetic-yo-user", YO_API_PASSWORD: "synthetic-yo-password", YO_PUBLIC_KEY: yoPublicKey },
  deps: () => ({ yoTransport: fakeYo }),
});
const run = crypto.randomUUID().slice(0, 8);
const PASSWORD = "Synthetic-Workflow-2026!";

function address(): string {
  return `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
}

async function anonymous(path: string, init: { body: string; contentType?: string }): Promise<Response> {
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": init.contentType ?? "application/json", "x-forwarded-for": address() }, body: init.body,
  }));
}

function cookieFrom(response: Response): string {
  const match = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error("no session cookie");
  return match.split(";")[0]!;
}

async function get(session: Session, path: string, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path), status);
}

async function patch(session: Session, path: string, body: unknown, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path, { method: "PATCH", body: JSON.stringify(body) }), status);
}

async function notify(path: string, fields: Record<string, string>): Promise<Response> {
  return anonymous(path, { body: new URLSearchParams(fields).toString(), contentType: "application/x-www-form-urlencoded" });
}

async function ipn(externalRef: string, amount: string, networkRef: string, signature?: string): Promise<Response> {
  const fields = { date_time: "2026-10-29 12:00:00", amount, narrative: "Payment", network_ref: networkRef, external_ref: externalRef, msisdn: "256772123456" };
  return notify("/api/v1/public/payments/yo/notifications", {
    ...fields, signature: signature ?? yoSign(fields.date_time + fields.amount + fields.narrative + fields.network_ref + fields.external_ref + fields.msisdn),
  });
}

async function externalReference(requestId: string): Promise<string> {
  const rows = await h.sql`select app.mobile_money_request_tenant(${"x"}) as probe`;
  expect(rows[0]!.probe).toBeNull();
  const lastDeposit = [...yoRequests].reverse().find((body) => body.includes("acdepositfunds"))!;
  const reference = /<ExternalReference>([^<]+)</.exec(lastDeposit)![1]!;
  expect(reference).toBe(`MV-${requestId.replace(/-/g, "").toUpperCase()}`);
  return reference;
}

let finance: Session;
let reception: Session;
let clinician: Session;
let lab: Session;
let labItem: string;
let supplyItem: string;

beforeAll(async () => {
  [finance, reception, clinician, lab] = await Promise.all([
    h.login("finance@medveris.local"), h.login("reception@medveris.local"), h.login("clinician@medveris.local"), h.login("lab@medveris.local"),
  ]);
  labItem = (await h.post(finance, "/api/v1/service-catalog", { code: `CBC-${run}`, name: `Full blood count ${run}`, category: "laboratory", itemType: "service", price: 15000, currency: "UGX" })).service.id;
  supplyItem = (await h.post(finance, "/api/v1/service-catalog", { code: `GLV-${run}`, name: `Gloves pair ${run}`, category: "supply", itemType: "supply", price: 2000, currency: "UGX", unitOfMeasure: "pair" })).service.id;
});

async function openVisit(): Promise<{ patientId: string; encounterId: string }> {
  const patientId = await h.registerPatient(reception, `Workflow${run}${Math.floor(Math.random() * 1e6)}`);
  const encounter = await h.post(reception, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Fever for three days" });
  return { patientId, encounterId: encounter.encounterId };
}

describe("onboarding and workspace restore", () => {
  it("lands an independent laboratory owner in their own unit with its working roles", async () => {
    const email = `lab.owner.${run}@example.test`;
    const response = await anonymous("/api/v1/auth/register/workspace", {
      body: JSON.stringify({
        path: "independent",
        owner: { email, password: PASSWORD, givenName: "Synthetic", familyName: "LabOwner" },
        workspace: { name: `Synthetic Diagnostic Laboratory ${run}`, workspaceKind: "service-unit", serviceCategory: "laboratory", ownership: "private-for-profit", levelStatus: "not-applicable", registrations: [] },
      }),
    });
    const body = await h.json(response);
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.session.next).toBe("/mfa-setup");
    const session = { cookie: cookieFrom(response), csrf: body.session.csrfToken as string };
    const me = await get(session, "/api/v1/me");
    expect(me.activeTenant.id).toBe(body.workspace.id);
    expect(me.activeTenant.workspace).toMatchObject({ serviceCategory: "laboratory", workspaceKind: "service-unit", organizationId: null });
    expect(me.activeTenant.workspace.enabledModules).toEqual(expect.arrayContaining(["laboratory", "finance", "reception"]));
    expect(me.activeTenant.roles).toEqual(expect.arrayContaining(["owner", "facility_admin", "receptionist", "finance", "laboratory"]));
    expect(me.activeTenant.roles).not.toContain("clinician");
    expect(me.organizations).toEqual([]);

    const started = await h.post(session, "/api/v1/auth/mfa/enroll/start", {}, 200);
    await h.post(session, "/api/v1/auth/mfa/enroll/verify", { code: await totpCode(started.secret) }, 200);

    // The front desk of a standalone laboratory logs a walk-in request for its own bench.
    const patientId = await h.registerPatient(session, `LabWalkIn${run}`);
    const encounter = await h.post(session, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Laboratory visit" });
    const workflow = await get(session, `/api/v1/encounters/${encounter.encounterId}/workflow`);
    expect(workflow.permissions.recommend).toBe(false);
    expect(workflow.permissions.directRequestDepartments).toContain("laboratory");
    const request = await h.post(session, `/api/v1/encounters/${encounter.encounterId}/recommendations`, {
      department: "laboratory", description: "Malaria rapid test", priority: "urgent", externalReferrer: "Dr Outside Clinic",
    });
    expect(request.recommendation).toMatchObject({ source: "direct-request", status: "requested", externalReferrer: "Dr Outside Clinic" });
    expect((await h.call(session, `/api/v1/encounters/${encounter.encounterId}/recommendations`, { method: "POST", body: JSON.stringify({ department: "imaging", description: "Chest X-ray" }) })).status).toBe(403);
    const queue = await get(session, "/api/v1/work-queues/laboratory");
    expect(queue.items.map((item: any) => item.id)).toContain(request.recommendation.id);

    const login = await h.json(await anonymous("/api/v1/auth/login", { body: JSON.stringify({ email, password: PASSWORD }) }));
    expect(login.mfaRequired).toBe(true);
  });

  it("finds organizations by name and confirms join codes without using them", async () => {
    const search = await h.app.fetch(new Request("http://localhost/api/v1/auth/organizations/search?q=xx", { headers: { "x-forwarded-for": address() } }));
    expect(search.status).toBe(422);
    const found = await h.json(await h.app.fetch(new Request(`http://localhost/api/v1/auth/organizations/search?q=${encodeURIComponent("%%%")}`, { headers: { "x-forwarded-for": address() } })));
    expect(found.organizations).toEqual([]);
    const lookup = await anonymous("/api/v1/auth/join-codes/lookup", { body: JSON.stringify({ joinCode: "not-a-real-code-123" }) });
    expect(lookup.status).toBe(404);
    expect((await h.json(lookup)).error.code).toBe("join_code_invalid");
  });

  it("reopens the workspace a user last worked in at their next sign-in", async () => {
    const admin = await h.login("admin@medveris.local");
    const facilities = await get(admin, "/api/v1/me/facilities");
    const other = facilities.facilities.find((facility: any) => facility.tenantId !== KAMPALA_TENANT);
    expect(other).toBeTruthy();
    await h.post(admin, "/api/v1/me/context", { tenantId: other.tenantId }, 200);
    const challenge = await h.json(await anonymous("/api/v1/auth/login", { body: JSON.stringify({ email: "admin@medveris.local", password: "Medveris!2026" }) }));
    const { code } = await h.json(await h.app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent("admin@medveris.local")}`)));
    const verified = await h.json(await anonymous("/api/v1/auth/login/mfa", { body: JSON.stringify({ challengeId: challenge.challengeId, code }) }));
    expect(verified.activeTenantId).toBe(other.tenantId);
    await h.post(admin, "/api/v1/me/context", { tenantId: KAMPALA_TENANT }, 200);
  });
});

describe("organization patient workflow", () => {
  let visit: { patientId: string; encounterId: string };
  let recommendationId: string;
  let imagingId: string;
  let invoiceId: string;

  it("lets a clinician recommend priced and unpriced work, once per open item", async () => {
    visit = await openVisit();
    const workflow = await get(clinician, `/api/v1/encounters/${visit.encounterId}/workflow`);
    expect(workflow.permissions.recommend).toBe(true);
    const key = `rec-${crypto.randomUUID()}`;
    const created = await h.post(clinician, `/api/v1/encounters/${visit.encounterId}/recommendations`, {
      department: "laboratory", catalogItemId: labItem, priority: "urgent", instructions: "Fasting sample; query malaria",
    }, 201, key);
    recommendationId = created.recommendation.id;
    expect(created.recommendation).toMatchObject({ status: "requested", billingStatus: "unbilled", source: "consultation", description: `Full blood count ${run}` });
    const replay = await h.post(clinician, `/api/v1/encounters/${visit.encounterId}/recommendations`, { department: "laboratory", catalogItemId: labItem }, 200, key);
    expect(replay.recommendation.id).toBe(recommendationId);
    const duplicate = await h.call(clinician, `/api/v1/encounters/${visit.encounterId}/recommendations`, { method: "POST", body: JSON.stringify({ department: "laboratory", catalogItemId: labItem }) });
    expect(duplicate.status).toBe(409);
    const wrongDepartment = await h.call(clinician, `/api/v1/encounters/${visit.encounterId}/recommendations`, { method: "POST", body: JSON.stringify({ department: "imaging", catalogItemId: labItem }) });
    expect(wrongDepartment.status).toBe(422);
    imagingId = (await h.post(clinician, `/api/v1/encounters/${visit.encounterId}/recommendations`, { department: "imaging", description: "Abdominal ultrasound" })).recommendation.id;
    const edited = await patch(clinician, `/api/v1/recommendations/${imagingId}`, { expectedVersion: 1, priority: "emergency", instructions: "Suspected appendicitis" });
    expect(edited.recommendation).toMatchObject({ priority: "emergency", version: 2 });
    expect((await h.call(reception, `/api/v1/encounters/${visit.encounterId}/recommendations`, { method: "POST", body: JSON.stringify({ department: "laboratory", description: "Something" }) })).status).toBe(403);
  });

  it("shows each role what it needs: reception sees status, the department sees instructions", async () => {
    const asReception = await get(reception, `/api/v1/encounters/${visit.encounterId}/workflow`);
    const forReception = asReception.recommendations.find((row: any) => row.id === recommendationId);
    expect(forReception).toMatchObject({ status: "requested", instructions: null, instructionsRestricted: true, unitPrice: null, canProgress: false });
    const queue = await get(lab, "/api/v1/work-queues/laboratory");
    const item = queue.items.find((row: any) => row.id === recommendationId);
    expect(item).toMatchObject({ instructions: "Fasting sample; query malaria", priority: "urgent", canProgress: true });
    expect(item.patient.id).toBe(visit.patientId);
    expect(item.visit.id).toBe(visit.encounterId);
    expect((await h.call(lab, "/api/v1/work-queues/imaging")).status).toBe(403);
    const summary = await get(lab, "/api/v1/work-queues");
    expect(summary.departments.map((row: any) => row.department)).toEqual(["laboratory"]);
    const asLab = await get(lab, `/api/v1/encounters/${visit.encounterId}/workflow`);
    expect(asLab.recommendations.map((row: any) => row.department)).toEqual(["laboratory"]);

    // A department with no work on this visit does not see it.
    const pharmacist = await h.login("pharmacist@medveris.local");
    expect((await h.call(pharmacist, `/api/v1/encounters/${visit.encounterId}/workflow`)).status).toBe(404);
    expect((await get(pharmacist, "/api/v1/visits/board")).visits.map((row: any) => row.id)).not.toContain(visit.encounterId);
    expect((await h.call(pharmacist, `/api/v1/encounters/${visit.encounterId}/supplies`, { method: "POST", body: JSON.stringify({ catalogItemId: supplyItem, quantity: 1 }) })).status).toBe(404);
  });

  it("lets the department progress the work and keeps who did what and when", async () => {
    expect((await h.call(lab, `/api/v1/recommendations/${recommendationId}/transitions`, { method: "POST", body: JSON.stringify({ status: "cancelled", expectedVersion: 1, note: "no" }) })).status).toBe(403);
    expect((await h.call(clinician, `/api/v1/recommendations/${recommendationId}/transitions`, { method: "POST", body: JSON.stringify({ status: "accepted", expectedVersion: 1 }) })).status).toBe(403);
    await h.post(lab, `/api/v1/recommendations/${recommendationId}/transitions`, { status: "accepted", expectedVersion: 1 }, 200);
    const stale = await h.call(lab, `/api/v1/recommendations/${recommendationId}/transitions`, { method: "POST", body: JSON.stringify({ status: "in-progress", expectedVersion: 1 }) });
    expect(stale.status).toBe(409);
    await h.post(lab, `/api/v1/recommendations/${recommendationId}/transitions`, { status: "in-progress", expectedVersion: 2 }, 200);
    const done = await h.post(lab, `/api/v1/recommendations/${recommendationId}/transitions`, { status: "completed", expectedVersion: 3, note: "Sample analysed" }, 200);
    expect(done.recommendation).toMatchObject({ status: "completed", completedByName: "Lydia Laboratory" });
    expect((await h.call(lab, `/api/v1/recommendations/${recommendationId}/transitions`, { method: "POST", body: JSON.stringify({ status: "accepted", expectedVersion: 4 }) })).status).toBe(422);

    const supply = await h.post(lab, `/api/v1/encounters/${visit.encounterId}/supplies`, { catalogItemId: supplyItem, quantity: 1, recommendationId }, 201, `supply-${run}`);
    const supplyReplay = await h.post(lab, `/api/v1/encounters/${visit.encounterId}/supplies`, { catalogItemId: supplyItem, quantity: 1, recommendationId }, 200, `supply-${run}`);
    expect(supplyReplay.supply.id).toBe(supply.supply.id);

    const history = await get(clinician, `/api/v1/recommendations/${recommendationId}`);
    expect(history.events.map((event: any) => [event.event, event.toStatus])).toEqual([
      ["created", "requested"], ["status-changed", "accepted"], ["status-changed", "in-progress"], ["status-changed", "completed"],
    ]);
    expect(history.events[1].actorName).toBe("Lydia Laboratory");
    const asReception = await get(reception, `/api/v1/encounters/${visit.encounterId}/workflow`);
    expect(asReception.recommendations.find((row: any) => row.id === recommendationId).status).toBe("completed");
    const board = await get(reception, "/api/v1/visits/board");
    const row = board.visits.find((entry: any) => entry.id === visit.encounterId);
    expect(row.requests).toMatchObject({ requested: 1, completed: 1 });
    expect(row.billing).toMatchObject({ unbilledRequests: 2, unbilledSupplies: 1, total: null });
  });

  it("bills recommended and supplied work once and links each line to its source", async () => {
    const billable = await get(finance, `/api/v1/encounters/${visit.encounterId}/billable`);
    expect(billable.recommendations.map((line: any) => [line.id, line.priced])).toEqual(expect.arrayContaining([[recommendationId, true], [imagingId, false]]));
    const supplyId = billable.supplies[0].id;
    const bill = await h.post(finance, `/api/v1/encounters/${visit.encounterId}/bill`, { recommendationIds: [recommendationId, imagingId], supplyUsageIds: [supplyId] });
    expect(bill.added).toBe(2);
    expect(bill.skipped).toEqual([expect.objectContaining({ id: imagingId, reason: expect.stringContaining("no price-list item") })]);
    invoiceId = bill.invoice.id;
    const again = await h.post(finance, `/api/v1/encounters/${visit.encounterId}/bill`, { recommendationIds: [recommendationId], supplyUsageIds: [supplyId] }, 200);
    expect(again.added).toBe(0);
    expect(again.skipped.map((row: any) => row.reason)).toEqual(["already on a bill", "already on a bill"]);
    const invoice = await get(finance, `/api/v1/invoices/${invoiceId}`);
    expect(invoice.totals).toMatchObject({ total: 17000, paid: 0, balance: 17000, status: "open" });
    expect(invoice.items.map((item: any) => item.source).sort()).toEqual(["recommendation", "supply"]);
    expect(invoice.paymentOptions.mobileMoney).toBe(true);
    const cancelBilled = await h.call(clinician, `/api/v1/recommendations/${imagingId}/transitions`, { method: "POST", body: JSON.stringify({ status: "cancelled", expectedVersion: 2, note: "Not needed after review" }) });
    expect(cancelBilled.status).toBe(200);
    expect((await h.call(reception, `/api/v1/encounters/${visit.encounterId}/bill`, { method: "POST", body: JSON.stringify({ recommendationIds: [recommendationId] }) })).status).toBe(403);
  });

  it("takes cash idempotently, gives change, refuses overpayment and issues a receipt", async () => {
    const over = await h.call(finance, `/api/v1/invoices/${invoiceId}/cash`, { method: "POST", body: JSON.stringify({ amount: 20000 }), idempotencyKey: `cash-over-${run}` });
    expect(over.status).toBe(422);
    const key = `cash-${run}`;
    const paid = await h.post(finance, `/api/v1/invoices/${invoiceId}/cash`, { amount: 7000, amountTendered: 10000 }, 201, key);
    expect(paid.payment.change).toBe(3000);
    expect(paid.invoice).toMatchObject({ balance: 10000, status: "part-paid" });
    const replay = await h.post(finance, `/api/v1/invoices/${invoiceId}/cash`, { amount: 7000, amountTendered: 10000 }, 200, key);
    expect(replay.payment.id).toBe(paid.payment.id);
    const receipt = await get(finance, `/api/v1/payments/${paid.payment.id}/receipt`);
    expect(receipt.receipt).toMatchObject({ amount: 7000, change: 3000, amountTendered: 10000, balanceAfter: 10000, total: 17000, method: "cash" });
    expect(receipt.receipt.number).toMatch(/^RCT-\d{8}-[0-9A-F]{8}$/);
    const queue = await get(lab, "/api/v1/work-queues/laboratory?status=completed");
    expect(queue.items.find((row: any) => row.id === recommendationId).billingStatus).toBe("part-paid");
    const remove = await h.call(finance, `/api/v1/invoices/${invoiceId}/items/${(await get(finance, `/api/v1/invoices/${invoiceId}`)).items[0].id}/remove`, { method: "POST", body: JSON.stringify({ reason: "Testing removal after payment" }) });
    expect(remove.status).toBe(409);
  });

  it("collects the balance by Yo! mobile money and reconciles verified notifications once", async () => {
    const key = `momo-${run}`;
    const sent = await h.post(finance, `/api/v1/invoices/${invoiceId}/mobile-money`, { msisdn: "0772 123456", amount: 10000 }, 201, key);
    expect(sent.request).toMatchObject({ status: "pending", amount: 10000, msisdn: "2567•••••456", mode: "sandbox" });
    const deposit = yoRequests.at(-1)!;
    expect(deposit).toContain("<Method>acdepositfunds</Method>");
    expect(deposit).toContain("<NonBlocking>TRUE</NonBlocking>");
    expect(deposit).toContain("<Account>256772123456</Account>");
    expect(deposit).toContain("<Amount>10000</Amount>");
    expect(deposit).toContain("/api/v1/public/payments/yo/notifications</InstantNotificationUrl>");
    expect(deposit).not.toMatch(/Workflow|Fever/);
    const reference = await externalReference(sent.request.id);
    const calls = yoRequests.length;
    const replay = await h.post(finance, `/api/v1/invoices/${invoiceId}/mobile-money`, { msisdn: "0772 123456", amount: 10000 }, 200, key);
    expect(replay.request.id).toBe(sent.request.id);
    expect(yoRequests.length).toBe(calls);
    const second = await h.call(finance, `/api/v1/invoices/${invoiceId}/mobile-money`, { method: "POST", body: JSON.stringify({ msisdn: "0772123456", amount: 10000 }), idempotencyKey: `momo-2-${run}` });
    expect(second.status).toBe(409);

    expect((await ipn(reference, "10000", `NR-${run}`, yoSign("tampered"))).status).toBe(403);
    const confirmed = await ipn(reference, "10000", `NR-${run}`);
    expect(confirmed.status).toBe(200);
    expect(await h.json(confirmed)).toMatchObject({ status: "succeeded", duplicate: false });
    const retried = await h.json(await ipn(reference, "10000", `NR-${run}`));
    expect(retried).toMatchObject({ status: "succeeded", duplicate: true });
    const failure = await notify("/api/v1/public/payments/yo/failures", { failed_transaction_reference: reference, transaction_init_date: "2026-10-29 12:00:00", verification: yoSign(`${reference}2026-10-29 12:00:00`) });
    expect(await h.json(failure)).toMatchObject({ status: "succeeded" });

    const invoice = await get(finance, `/api/v1/invoices/${invoiceId}`);
    expect(invoice.totals).toMatchObject({ total: 17000, paid: 17000, balance: 0, status: "paid" });
    const mobile = invoice.payments.filter((payment: any) => payment.method === "mobile-money");
    expect(mobile).toHaveLength(1);
    expect(mobile[0].reference).toBe(`NR-${run}`);
    const receipt = await get(finance, `/api/v1/payments/${mobile[0].id}/receipt`);
    expect(receipt.receipt).toMatchObject({ method: "mobile-money", balanceAfter: 0, mobileMoney: { msisdn: "2567•••••456", mode: "sandbox" } });
    const asLab = await get(lab, `/api/v1/encounters/${visit.encounterId}/workflow`);
    expect(asLab.recommendations.find((row: any) => row.id === recommendationId).billingStatus).toBe("paid");
  });

  it("marks a declined prompt failed after a status check and allows a new attempt", async () => {
    const other = await openVisit();
    const nurse = await h.login("nurse@medveris.local");
    await h.post(nurse, `/api/v1/encounters/${other.encounterId}/supplies`, { catalogItemId: supplyItem, quantity: 2 });
    const billable = await get(finance, `/api/v1/encounters/${other.encounterId}/billable`);
    const bill = await h.post(finance, `/api/v1/encounters/${other.encounterId}/bill`, { supplyUsageIds: billable.supplies.map((line: any) => line.id) });
    const sent = await h.post(finance, `/api/v1/invoices/${bill.invoice.id}/mobile-money`, { msisdn: "256701234567", amount: 4000 }, 201, `momo-fail-${run}`);
    const reference = await externalReference(sent.request.id);
    statusByReference.set(reference, "FAILED");
    const checked = await h.post(finance, `/api/v1/mobile-money/${sent.request.id}/check`, {}, 200);
    expect(checked.request.status).toBe("failed");
    const lateAmount = await ipn(reference, "9999", `NR-late-${run}`);
    expect(await h.json(lateAmount)).toMatchObject({ status: "failed" });
    const retry = await h.post(finance, `/api/v1/invoices/${bill.invoice.id}/mobile-money`, { msisdn: "256701234567", amount: 4000 }, 201, `momo-retry-${run}`);
    expect(retry.request.status).toBe("pending");
    const invoice = await get(finance, `/api/v1/invoices/${bill.invoice.id}`);
    expect(invoice.totals.paid).toBe(0);
  });

  it("rejects callbacks without a verifiable signature or a known reference", async () => {
    expect((await notify("/api/v1/public/payments/yo/notifications", { external_ref: "MV-UNKNOWN" })).status).toBe(400);
    expect((await ipn("MV-UNKNOWN", "100", "NR-unknown")).status).toBe(404);
  });
});

describe("consultation note integrity", () => {
  it("recomputes a signed note's digests and its signed Merkle checkpoint", async () => {
    const consult = await openVisit();
    await h.post(clinician, `/api/v1/encounters/${consult.encounterId}/triage`, { complaint: "Fever (synthetic)", urgency: "routine", notes: "", allergyState: "none" }, 200);
    const draft = await h.post(clinician, `/api/v1/encounters/${consult.encounterId}/entries`, {
      title: "Consultation", subjective: "Fever", objective: "Temp 38.5", assessment: "Possible malaria", plan: "Malaria RDT",
      clinicalOccurredAt: new Date().toISOString(), changeNote: "Initial consultation note",
    });
    await h.post(clinician, `/api/v1/entries/${draft.entryId}/sign`, { expectedVersion: 1 }, 200);
    const before = await get(clinician, `/api/v1/entries/${draft.entryId}/integrity`);
    expect(before.summary.contentIntact).toBe(true);
    expect(before.events.map((event: any) => event.action)).toEqual(expect.arrayContaining(["clinical.entry.draft.create", "clinical.entry.sign"]));
    expect(before.summary.eventsAwaitingCheckpoint).toBeGreaterThan(0);
    expect((await h.call(reception, `/api/v1/entries/${draft.entryId}/integrity`)).status).toBe(403);

    const { maybeCreateCheckpoint } = await import("../../apps/jobs/src/integrity.js");
    const { createSql } = await import("@medveris/db");
    const jobs = createSql(process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL!, { max: 1 });
    try {
      await maybeCreateCheckpoint(jobs, KAMPALA_TENANT, h.config.auditSigningKey, h.config.auditSigningKeyId);
    } finally {
      await jobs.end({ timeout: 5 });
    }
    const after = await get(clinician, `/api/v1/entries/${draft.entryId}/integrity`);
    expect(after.summary).toMatchObject({ contentIntact: true, checkpointsVerified: true, externallyAnchored: false });
    expect(after.summary.eventsCheckpointed).toBeGreaterThanOrEqual(2);
    expect(after.checkpoints.at(-1)).toMatchObject({ rootMatches: true, signatureValid: true, ledgerState: "not-requested" });
  });
});

describe("price list", () => {
  it("lets finance change prices with version checks while other staff only read them", async () => {
    const list = await get(clinician, "/api/v1/service-catalog?active=true");
    const item = list.services.find((row: any) => row.id === labItem);
    expect(item).toMatchObject({ itemType: "service", category: "laboratory", currency: "UGX" });
    expect(list.canManage).toBe(false);
    expect((await h.call(clinician, `/api/v1/service-catalog/${labItem}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: item.version, price: 1 }) })).status).toBe(403);
    const updated = await patch(finance, `/api/v1/service-catalog/${labItem}`, { expectedVersion: item.version, price: 16000, reason: "New reagent costs" });
    expect(updated.service.version).toBe(item.version + 1);
    expect((await h.call(finance, `/api/v1/service-catalog/${labItem}`, { method: "PATCH", body: JSON.stringify({ expectedVersion: item.version, active: false }) })).status).toBe(409);
    const duplicate = await h.call(finance, "/api/v1/service-catalog", { method: "POST", body: JSON.stringify({ code: `CBC-${run}`, name: "Duplicate", category: "laboratory", price: 1, currency: "UGX" }) });
    expect(duplicate.status).toBe(409);
  });
});
