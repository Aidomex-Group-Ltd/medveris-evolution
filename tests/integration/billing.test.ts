import { beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { createSql } from "@medveris/db";
import { createHarness, type Session } from "./support.js";

const h = createHarness("billing", { env: { BILLING_ENFORCEMENT: "enforce", USAGE_METERING: "true" } });
const run = crypto.randomUUID().slice(0, 8);
const PASSWORD = "Synthetic-Billing-2026!";
const BASIC_PLAN_ID = "c0000000-0000-4000-8000-000000000002";
const TRIAL_PLAN_ID = "c0000000-0000-4000-8000-000000000001";

function address(): string {
  return `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
}

async function anonymous(path: string, body: unknown): Promise<Response> {
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": address() }, body: JSON.stringify(body),
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

let owner: Session;
let ownerEmail: string;
let workspaceId: string;
let billingAccountId: string;
let operator: Session;
let advancedPlanId: string;
let approvedPlanId: string;

beforeAll(async () => {
  ownerEmail = `billing.owner.${run}@example.test`;
  const response = await anonymous("/api/v1/auth/register/workspace", {
    path: "independent",
    owner: { email: ownerEmail, password: PASSWORD, givenName: "Synthetic", familyName: "BillOwner" },
    workspace: {
      name: `Synthetic Billing Clinic ${run}`, workspaceKind: "facility", serviceCategory: "clinic",
      ownership: "private-for-profit", levelStatus: "not-yet-assigned", registrations: [],
    },
  });
  const body = await h.json(response);
  expect(response.status, JSON.stringify(body)).toBe(201);
  workspaceId = body.workspace.id;
  owner = { cookie: cookieFrom(response), csrf: body.session.csrfToken as string };
  const started = await h.post(owner, "/api/v1/auth/mfa/enroll/start", {}, 200);
  await h.post(owner, "/api/v1/auth/mfa/enroll/verify", { code: await totpCode(started.secret) }, 200);
  operator = await h.login("reviewer@medveris.local");

  const overview = await get(owner, "/api/v1/billing/overview");
  billingAccountId = overview.account.id;
});

describe("trial and subscription lifecycle", () => {
  it("provisions a seven-day trial for a new independent workspace", async () => {
    const status = await get(owner, "/api/v1/billing/status");
    expect(status.enforcement).toBe("enforce");
    expect(status.accessMode).toBe("full");
    expect(status.billing).toMatchObject({ status: "trialing", canManage: true, accountKind: "independent-facility" });

    const overview = await get(owner, "/api/v1/billing/overview");
    expect(overview.account).toMatchObject({ id: billingAccountId, kind: "independent-facility", canManage: true });
    expect(overview.account.workspaces.map((row: any) => row.id)).toEqual([workspaceId]);
    expect(overview.subscription).toMatchObject({ status: "trialing", plan: { code: "trial", monthlyPriceMinor: 0 } });
    expect(overview.subscription.trialDaysRemaining).toBe(7);
  });

  it("drafts and approves a plan version before it can be chosen", async () => {
    const draft = await h.post(operator, "/api/v1/platform/billing/plans", {
      code: "advanced", name: "Advanced", description: "Synthetic advanced plan for tests",
      monthlyPrice: "20.00", maxMonthlyCharge: "30.00", usageOverages: true,
      features: ["core-clinical", "point-of-sale", "price-list"], contractRequired: false,
      rules: [
        { resource: "compute.request_ms", treatment: "included", includedQuantity: null, limitQuantity: null, unitRateMinor: null, rateUnitQuantity: 1 },
        { resource: "network.egress_bytes", treatment: "included", includedQuantity: null, limitQuantity: null, unitRateMinor: null, rateUnitQuantity: 1 },
      ],
    }, 201);
    advancedPlanId = draft.plan.id;

    const rejected = await h.call(owner, "/api/v1/billing/subscription/quote", { method: "POST", body: JSON.stringify({ planId: advancedPlanId }) });
    expect(rejected.status).toBe(422);
    expect((await h.json(rejected)).error.code).toBe("plan_not_approved");

    await h.post(operator, `/api/v1/platform/billing/plans/${advancedPlanId}/approve`, { approvalReference: "Synthetic pricing approval 2026" }, 200);
    const quoted = await h.post(owner, "/api/v1/billing/subscription/quote", { planId: advancedPlanId }, 200);
    approvedPlanId = quoted.quote.plan.id;
    expect(quoted.quote).toMatchObject({ change: "start", effective: "trial-end", firstChargeMinor: 2000, prorationMinor: 0, plan: { code: "advanced", monthlyPriceMinor: 2000 } });
    expect(quoted.quote.disclosure).toContain("Advanced");

    const plans = await get(operator, "/api/v1/platform/billing/plans");
    expect(plans.plans.filter((plan: any) => plan.code === "advanced").map((plan: any) => plan.status)).toContain("approved");
    expect(approvedPlanId).toBe(advancedPlanId);
  });

  it("restricts growth features after the trial is cancelled, without touching care", async () => {
    const cancelled = await h.post(owner, "/api/v1/billing/subscription/cancel", { reason: "Synthetic cancellation before choosing a plan" }, 200);
    expect(cancelled.cancellation.effective).toBe("now");

    const report = await get(owner, "/api/v1/reports/any-report", 402);
    expect(report.error.code).toBe("subscription_restricted");
    expect((await get(owner, "/api/v1/billing/status")).billing.status).toBe("cancelled");
    // The signed-in workspace and its billing screens keep working while the subscription is restricted.
    expect((await get(owner, "/api/v1/me")).activeTenant.id).toBe(workspaceId);
  });

  it("starts the Basic plan, invoices a month and activates it on payment", async () => {
    const quoted = await h.post(owner, "/api/v1/billing/subscription/quote", { planId: BASIC_PLAN_ID }, 200);
    expect(quoted.quote).toMatchObject({ change: "start", effective: "now", firstChargeMinor: 1500, plan: { code: "basic", monthlyPriceMinor: 1500 } });

    const stale = await h.call(owner, "/api/v1/billing/subscription/accept", {
      method: "POST", body: JSON.stringify({ planId: BASIC_PLAN_ID, disclosureDigest: "0".repeat(64), accept: true }),
    });
    expect(stale.status).toBe(409);

    const accepted = await h.post(owner, "/api/v1/billing/subscription/accept", {
      planId: BASIC_PLAN_ID, disclosureDigest: quoted.quote.disclosureDigest, accept: true,
    }, 201);
    expect(accepted.invoice).toMatchObject({ totalMinor: 1500 });
    expect((await get(owner, "/api/v1/billing/status")).billing.status).toBe("pending_payment");

    const invoiceId = accepted.invoice.id;
    const invoice = await get(operator, `/api/v1/platform/billing/invoices/${invoiceId}`);
    expect(invoice.invoice).toMatchObject({ status: "open" });
    expect(Number(invoice.invoice.totalMinor)).toBe(1500);
    const payment = await h.post(operator, `/api/v1/platform/billing/invoices/${invoiceId}/payments`, {
      amount: "15.00", method: "bank-transfer", status: "succeeded", reference: `BANK-${run}`,
    }, 201, `sub-payment-${run}`);
    expect(payment.settlement).toMatchObject({ status: "paid", paidMinor: 1500 });

    const status = await get(owner, "/api/v1/billing/status");
    expect(status.billing.status).toBe("active");
    expect(status.accessMode).toBe("full");
  });

  it("records a subscription refund and can suspend and reinstate the account", async () => {
    const accounts = await get(operator, "/api/v1/platform/billing/accounts");
    const account = accounts.accounts.find((row: any) => row.id === billingAccountId);
    expect(account).toMatchObject({ kind: "independent-facility", status: "active" });
    const invoices = await get(operator, `/api/v1/platform/billing/accounts/${billingAccountId}/invoices`);
    const invoiceId = invoices.invoices[0].id;
    const detail = await get(operator, `/api/v1/platform/billing/invoices/${invoiceId}`);
    const paymentId = detail.payments[0].id;

    const refund = await h.post(operator, `/api/v1/platform/billing/payments/${paymentId}/refund`, { amount: "5.00", reason: "Synthetic billing correction" }, 200);
    expect(refund.invoice).toMatchObject({ status: "open", paidMinor: 1000 });
    const overRefund = await h.call(operator, `/api/v1/platform/billing/payments/${paymentId}/refund`, {
      method: "POST", body: JSON.stringify({ amount: "11.00", reason: "Synthetic over-refund attempt" }),
    });
    expect(overRefund.status).toBe(422);

    const subscriptions = await get(operator, `/api/v1/platform/billing/accounts?status=active`);
    expect(subscriptions.accounts.map((row: any) => row.id)).toContain(billingAccountId);
    const subscriptionId = account.subscriptionId;
    expect(await h.post(operator, `/api/v1/platform/billing/subscriptions/${subscriptionId}/status`, { action: "suspend", reason: "Synthetic support suspension" }, 200)).toMatchObject({ status: "suspended" });
    expect(await h.post(operator, `/api/v1/platform/billing/subscriptions/${subscriptionId}/status`, { action: "reinstate", reason: "Synthetic support reinstatement" }, 200)).toMatchObject({ status: "active" });

    const cancellation = await h.post(owner, "/api/v1/billing/subscription/cancel", { reason: "Synthetic end-of-month cancellation" }, 200);
    expect(cancellation.cancellation.effective).toBe("period-end");
    expect((await get(owner, "/api/v1/billing/overview")).subscription.cancelAtPeriodEnd).toBe(true);
    await h.post(owner, "/api/v1/billing/subscription/resume", {}, 200);
    expect((await get(owner, "/api/v1/billing/overview")).subscription.cancelAtPeriodEnd).toBe(false);
  });

  it("measures authenticated request usage for the workspace", async () => {
    const overview = await get(owner, "/api/v1/billing/overview");
    expect(overview.usage.periodStart).toBeTruthy();
    expect(overview.usage.unverifiedEvents).toBe(0);
    const jobs = createSql(process.env.JOBS_DATABASE_URL ?? process.env.DATABASE_URL!, { max: 1 });
    try {
      const [measured] = await jobs`
        select coalesce(sum(quantity), 0)::int as quantity from usage_events
         where tenant_id = ${workspaceId} and resource = 'compute.request_ms' and source = 'api-request'`;
      expect(Number(measured?.quantity ?? 0)).toBeGreaterThan(0);
    } finally {
      await jobs.end({ timeout: 5 });
    }
  });

  it("rejects plan changes from staff without billing management access", async () => {
    const clinician = await h.login("clinician@medveris.local");
    expect((await h.call(clinician, "/api/v1/billing/overview")).status).toBe(403);
    expect((await h.call(clinician, "/api/v1/billing/subscription/quote", { method: "POST", body: JSON.stringify({ planId: BASIC_PLAN_ID }) })).status).toBe(403);
    expect((await get(clinician, "/api/v1/billing/status")).billing.canManage).toBe(false);
  });
});

describe("price governance, refunds and voiding", () => {
  let patientId: string;
  let usdItemId: string;

  it("enforces facility currency, precision, zero-price and confirmation rules", async () => {
    const settings = await h.expectOk(await h.call(owner, "/api/v1/billing-settings", {
      method: "PUT",
      body: JSON.stringify({ expectedVersion: 0, allowedCurrencies: ["UGX", "USD"], allowZeroPrices: false, allowManualCharges: true, significantChangePercent: 20 }),
    }));
    expect(settings.settings).toMatchObject({ allowedCurrencies: ["UGX", "USD"], allowZeroPrices: false, version: 1 });

    const zero = await h.call(owner, "/api/v1/service-catalog", {
      method: "POST", body: JSON.stringify({ code: `ZERO-${run}`, name: "Zero priced item", category: "other", price: 0, currency: "UGX" }),
    });
    expect(zero.status).toBe(422);
    const decimalUgx = await h.call(owner, "/api/v1/service-catalog", {
      method: "POST", body: JSON.stringify({ code: `DEC-${run}`, name: "Decimal shilling item", category: "other", price: 100.5, currency: "UGX" }),
    });
    expect(decimalUgx.status).toBe(422);

    const created = await h.post(owner, "/api/v1/service-catalog", {
      code: `USD-${run}`, name: "USD consultation", category: "consultation", price: 12.34, currency: "USD",
    }, 201);
    usdItemId = created.service.id;
    const listed = await get(owner, "/api/v1/service-catalog?active=true");
    expect(listed.services.find((row: any) => row.id === usdItemId)).toMatchObject({ price: "12.34", currency: "USD", priceStatus: "approved", version: 1 });

    const needsConfirmation = await h.call(owner, `/api/v1/service-catalog/${usdItemId}`, {
      method: "PATCH", body: JSON.stringify({ expectedVersion: 1, price: 20, reason: "Synthetic significant change" }),
    });
    expect(needsConfirmation.status).toBe(409);
    expect((await h.json(needsConfirmation)).error.code).toBe("confirmation_required");
    const updated = await patch(owner, `/api/v1/service-catalog/${usdItemId}`, { expectedVersion: 1, price: 20, reason: "Synthetic significant change", confirm: true });
    expect(updated.service.version).toBe(2);

    const testItem = await h.post(owner, "/api/v1/service-catalog", {
      code: `TEST-${run}`, name: "Training price", category: "other", price: 500, currency: "UGX", priceStatus: "test",
    }, 201);
    patientId = await h.registerPatient(owner, `Billing${run}`);
    const testInvoice = await h.call(owner, "/api/v1/invoices", {
      method: "POST", body: JSON.stringify({ patientId, items: [{ serviceId: testItem.service.id, description: "Training price", quantity: 1 }] }),
    });
    expect(testInvoice.status).toBe(422);
    const stillNeedsConfirmation = await h.call(owner, `/api/v1/service-catalog/${testItem.service.id}`, {
      method: "PATCH", body: JSON.stringify({ expectedVersion: 1, priceStatus: "approved" }),
    });
    expect(stillNeedsConfirmation.status).toBe(409);
    await patch(owner, `/api/v1/service-catalog/${testItem.service.id}`, { expectedVersion: 1, priceStatus: "approved", confirm: true });
    const history = await get(owner, `/api/v1/service-catalog/${testItem.service.id}/history`);
    expect(history.history.map((row: any) => row.change)).toEqual(expect.arrayContaining(["created", "status-changed"]));
  });

  it("keeps payments and refunds in the bill's currency without changing the original payment", async () => {
    const invoice = await h.post(owner, "/api/v1/invoices", {
      patientId, items: [{ serviceId: usdItemId, description: "USD consultation", quantity: 2 }],
    }, 201);
    const paid = await h.post(owner, `/api/v1/invoices/${invoice.invoice.id}/cash`, { amount: 40, amountTendered: 50 }, 201, `usd-cash-${run}`);
    expect(paid.payment.change).toBe(10);
    const refund = await h.post(owner, `/api/v1/payments/${paid.payment.id}/refunds`, {
      amount: 5.5, method: "cash", reason: "Synthetic partial refund",
    }, 201, `usd-refund-${run}`);
    const replay = await h.post(owner, `/api/v1/payments/${paid.payment.id}/refunds`, {
      amount: 5.5, method: "cash", reason: "Synthetic partial refund",
    }, 200, `usd-refund-${run}`);
    expect(replay.refund.id).toBe(refund.refund.id);
    const detail = await get(owner, `/api/v1/invoices/${invoice.invoice.id}`);
    expect(detail.totals).toMatchObject({ currency: "USD", total: 40, paid: 34.5, refunded: 5.5, balance: 5.5, status: "part-paid" });
    expect(detail.payments[0]).toMatchObject({ currency: "USD" });
    expect(Number(detail.payments[0].amount)).toBe(40);
    expect(Number(detail.refunds[0].amount)).toBe(5.5);
    expect(detail.refunds[0]).toMatchObject({ currency: "USD", reason: "Synthetic partial refund" });
    const over = await h.call(owner, `/api/v1/payments/${paid.payment.id}/refunds`, {
      method: "POST", body: JSON.stringify({ amount: 40, method: "cash", reason: "Synthetic over refund" }),
    });
    expect(over.status).toBe(422);
  });

  it("voids an unpaid bill, releases its lines and refuses further payments", async () => {
    const invoice = await h.post(owner, "/api/v1/invoices", {
      patientId, items: [{ description: "Manual charge to void", quantity: 1, unitPrice: 700 }],
    }, 201);
    expect((await h.call(owner, `/api/v1/invoices/${invoice.invoice.id}/cash`, { method: "POST", body: JSON.stringify({ amount: 700 }), idempotencyKey: `void-cash-${run}` })).status).toBe(201);
    expect((await h.call(owner, `/api/v1/invoices/${invoice.invoice.id}/void`, { method: "POST", body: JSON.stringify({ reason: "Synthetic paid bill cannot be voided" }) })).status).toBe(409);

    const unpaid = await h.post(owner, "/api/v1/invoices", {
      patientId, items: [{ description: "Manual charge to release", quantity: 1, unitPrice: 700 }],
    }, 201);
    await h.post(owner, `/api/v1/invoices/${unpaid.invoice.id}/void`, { reason: "Synthetic duplicate bill" }, 200);
    const detail = await get(owner, `/api/v1/invoices/${unpaid.invoice.id}`);
    expect(detail.invoice.status).toBe("void");
    expect(detail.items.every((item: any) => item.releasedAt)).toBe(true);
    expect((await h.call(owner, `/api/v1/invoices/${unpaid.invoice.id}/cash`, { method: "POST", body: JSON.stringify({ amount: 100 }), idempotencyKey: `void-rejected-${run}` })).status).toBe(409);
    expect((await h.call(owner, `/api/v1/invoices/${unpaid.invoice.id}/void`, { method: "POST", body: JSON.stringify({ reason: "Synthetic second void" }) })).status).toBe(409);
  });

  it("waives unbilled visit work with a reason instead of losing it", async () => {
    const [finance, reception, nurse] = await Promise.all([
      h.login("finance@medveris.local"), h.login("reception@medveris.local"), h.login("nurse@medveris.local"),
    ]);
    const supply = await h.post(finance, "/api/v1/service-catalog", {
      code: `WAIVE-${run}`, name: "Waivable dressing", category: "supply", itemType: "supply", price: 2000, currency: "UGX", unitOfMeasure: "piece",
    }, 201);
    const patient = await h.registerPatient(reception, `Waive${run}`);
    const encounter = await h.post(reception, "/api/v1/encounters", { patientId: patient, type: "walk-in", reason: "Dressing change" });
    const usage = await h.post(nurse, `/api/v1/encounters/${encounter.encounterId}/supplies`, { catalogItemId: supply.service.id, quantity: 1 }, 201);
    const waived = await h.post(finance, `/api/v1/encounters/${encounter.encounterId}/waive`, {
      supplyUsageIds: [usage.supply.id], reason: "Synthetic compassionate waiver",
    }, 200);
    expect(waived).toMatchObject({ supplies: 1, requests: 0 });
    const billable = await get(finance, `/api/v1/encounters/${encounter.encounterId}/billable`);
    expect(billable.supplies.find((row: any) => row.id === usage.supply.id)).toMatchObject({ billingStatus: "waived" });
    expect(billable.checkout.waived).toBe(1);
    expect((await h.call(finance, `/api/v1/encounters/${encounter.encounterId}/waive`, {
      method: "POST", body: JSON.stringify({ supplyUsageIds: [usage.supply.id], reason: "Synthetic repeat waiver" }),
    })).status).toBe(409);
  });
});

describe("plan catalogue", () => {
  it("trial and Basic keep their published prices and Basic forbids usage overages", async () => {
    const plans = await get(operator, "/api/v1/platform/billing/plans");
    const trial = plans.plans.find((plan: any) => plan.id === TRIAL_PLAN_ID);
    const basic = plans.plans.find((plan: any) => plan.id === BASIC_PLAN_ID);
    expect(trial).toMatchObject({ code: "trial", monthlyPriceMinor: 0, usageOverages: false });
    expect(basic).toMatchObject({ code: "basic", monthlyPriceMinor: 1500, maxMonthlyChargeMinor: 1500, usageOverages: false });
    const rejected = await h.call(operator, "/api/v1/platform/billing/plans", {
      method: "POST",
      body: JSON.stringify({
        code: "basic", name: "Basic", description: "Invalid overage basic", monthlyPrice: "15.00", usageOverages: true,
        features: ["core-clinical"], rules: [{ resource: "compute.request_ms", treatment: "billable", includedQuantity: 0, limitQuantity: null, unitRateMinor: 1, rateUnitQuantity: 1 }],
      }),
    });
    expect(rejected.status).toBe(422);
  });
});
