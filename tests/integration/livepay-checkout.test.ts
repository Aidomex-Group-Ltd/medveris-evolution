import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

/**
 * LivePay has no test mode: its public playground sends real collections. These tests therefore use
 * an injected transport and a self-signed webhook, and never call livepay.me. The adapter's status
 * and signature behaviour is checked against docs.livepay.me (reviewed 2026-11-08).
 */

const WEBHOOK_SECRET = "synthetic-livepay-webhook-secret";
const WEBHOOK_URL = "http://localhost:5173/api/v1/public/payments/livepay/webhook";
const FX_RATE = 3800;
const ACCOUNT = "LP0000000000";

interface LivePayStatus {
  status: string;
  amount?: number;
  currency?: string;
  internal_reference?: string;
}

const collectCalls: Array<Record<string, unknown>> = [];
const statusCalls: Array<URL> = [];
const statuses = new Map<string, LivePayStatus>();

async function fakeLivePay(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/collect-money")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    collectCalls.push(body);
    return Response.json({
      success: true,
      message: "Collection request sent successfully",
      reference: body.reference,
      internal_reference: `LP-${String(body.reference)}`,
      network: "MTN",
    });
  }
  if (parsed.pathname.endsWith("/transaction-status")) {
    statusCalls.push(parsed);
    const reference = parsed.searchParams.get("reference") ?? "";
    const configured = statuses.get(reference) ?? { status: "Pending" };
    return Response.json({
      success: true,
      status: configured.status,
      message: configured.status === "Success" ? "Payment completed" : "N/A",
      customer_reference: reference,
      internal_reference: configured.internal_reference ?? `LP-${reference}`,
      amount: configured.amount,
      currency: configured.currency ?? "UGX",
      provider: "MTN",
    });
  }
  return Response.json({ success: false, error: "unexpected path" }, { status: 404 });
}

const h = createHarness("livepay-checkout", {
  env: {
    FEATURE_PAYMENTS: "true",
    PAYMENT_PROVIDER: "livepay",
    LIVEPAY_API_KEY: "synthetic-livepay-key",
    LIVEPAY_ACCOUNT_NUMBER: ACCOUNT,
    LIVEPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    LIVEPAY_WEBHOOK_URL: WEBHOOK_URL,
    LIVEPAY_BASE_URL: "https://livepay.test/api",
  },
  deps: () => ({
    livepayTransport: fakeLivePay,
    fxProvider: {
      name: "test-fx",
      async rate() {
        return { base: "USD", quote: "UGX", rate: FX_RATE, provider: "test-fx", providerTimestamp: new Date(Date.now() - 60_000) };
      },
    },
  }),
});

let admin: Session;

interface Checkout {
  id: string;
  status: string;
  amountUgx: number;
  periodEnd: string;
  externalReference: string;
  provider: string;
  providerMode: string;
}

interface WebhookPayload {
  status: string;
  message: string;
  customer_reference: string;
  internal_reference: string;
  provider_transaction_id: string;
  msisdn: string;
  amount: number;
  currency: string;
  provider: string;
  charge: number;
  completed_at: string;
}

function signWebhook(payload: WebhookPayload, timestamp = Math.floor(Date.now() / 1000)): string {
  const params: Array<[string, string]> = [
    ["customer_reference", payload.customer_reference],
    ["internal_reference", payload.internal_reference],
    ["status", payload.status],
  ];
  params.sort((left, right) => left[0].localeCompare(right[0]));
  let signingString = `${WEBHOOK_URL}${timestamp}`;
  for (const [key, value] of params) signingString += `${key}${value}`;
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(signingString).digest("hex");
  return `t=${timestamp},v=${signature}`;
}

function payloadFor(checkout: Checkout, overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    status: "Success",
    message: "Payment completed successfully",
    customer_reference: checkout.externalReference,
    internal_reference: `LP-${checkout.externalReference}`,
    provider_transaction_id: `PT-${crypto.randomUUID()}`,
    msisdn: "+256777123456",
    amount: checkout.amountUgx,
    currency: "UGX",
    provider: "MTN",
    charge: 1500,
    completed_at: "2026-11-08 10:35:00",
    ...overrides,
  };
}

async function webhook(payload: WebhookPayload, signature?: string): Promise<Response> {
  return h.app.fetch(new Request(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signature ?? signWebhook(payload) },
    body: JSON.stringify(payload),
  }));
}

async function startCheckout(interval = "monthly"): Promise<Checkout> {
  const body = await h.post(admin, "/api/v1/billing/subscription-checkout", {
    interval, msisdn: "0772 123456", consent: true,
  }, 201, crypto.randomUUID());
  return body.checkout as Checkout;
}

async function overview(): Promise<any> {
  return h.expectOk(await h.call(admin, "/api/v1/billing/overview"));
}

beforeAll(async () => {
  admin = await h.login("admin@medveris.local");
  const { withContext } = await import("@medveris/db");
  await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, async (tx) => {
    await tx`
      update subscription_checkouts set status = 'cancelled', status_detail = 'Cancelled by the LivePay test setup', completed_at = now(), updated_at = now()
       where status in ('pending','indeterminate')
         and billing_account_id in (select billing_account_id from tenants where id = ${KAMPALA_TENANT})
    `;
  });
});

afterAll(async () => {
  const { withContext } = await import("@medveris/db");
  await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, async (tx) => {
    await tx`
      update subscription_checkouts set status = 'cancelled', status_detail = 'Cancelled at the end of the LivePay test', completed_at = now(), updated_at = now()
       where status in ('pending','indeterminate')
         and billing_account_id in (select billing_account_id from tenants where id = ${KAMPALA_TENANT})
    `;
  }).catch(() => undefined);
  await h.sql.end({ timeout: 5 });
});

describe("LivePay subscription checkout", () => {
  it("sends a compliant collect request without marking the checkout paid", async () => {
    const before = collectCalls.length;
    const created = await startCheckout("monthly");
    expect(created.provider).toBe("livepay");
    expect(created.providerMode).toBe("live");
    expect(created.status).toBe("pending");
    // LivePay rejects references longer than 30 characters or containing spaces.
    expect(created.externalReference).toMatch(/^MS[0-9A-F]+$/);
    expect(created.externalReference.length).toBeLessThanOrEqual(30);

    const sent = collectCalls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      accountNumber: ACCOUNT,
      currency: "UGX",
      amount: created.amountUgx,
      reference: created.externalReference,
    });

    const status = await h.expectOk(await h.call(admin, `/api/v1/billing/subscription-checkout/${created.id}`));
    expect(status.checkout.status).toBe("pending");
    await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { reason: "Test cleanup" }, 200);
  });

  it("settles only when a status check reports the exact UGX amount", async () => {
    const created = await startCheckout("weekly");
    const before = await overview();
    statuses.set(created.externalReference, {
      status: "Success",
      amount: created.amountUgx,
      currency: "UGX",
    });
    const checked = await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/check`, {}, 200);
    expect(checked.checkout.status).toBe("succeeded");
    // The status request must include the currency parameter LivePay documents as required.
    const call = statusCalls.at(-1)!;
    expect(call.searchParams.get("currency")).toBe("UGX");
    expect(call.searchParams.get("accountNumber")).toBe(ACCOUNT);

    const after = await overview();
    expect(new Date(after.subscription.currentPeriodEnd).toISOString()).toBe(new Date(created.periodEnd).toISOString());
    expect(new Date(after.subscription.currentPeriodEnd).getTime()).toBeGreaterThan(new Date(before.subscription.currentPeriodEnd).getTime());

    // A repeated check is a no-op, not a second paid period.
    await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/check`, {}, 200);
    const again = await overview();
    expect(again.subscription.currentPeriodEnd).toBe(after.subscription.currentPeriodEnd);
  });

  it("rejects unsigned, malformed and stale webhooks", async () => {
    const created = await startCheckout("daily");
    const payload = payloadFor(created);
    const body = JSON.stringify(payload);
    const unsigned = await h.app.fetch(new Request(WEBHOOK_URL, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));
    expect(unsigned.status).toBe(403);

    const malformed = await h.app.fetch(new Request(WEBHOOK_URL, {
      method: "POST", headers: { "content-type": "application/json", "x-webhook-signature": "t=abc,v=xyz" }, body,
    }));
    expect(malformed.status).toBe(403);

    const staleTimestamp = Math.floor(Date.now() / 1000) - 3_600;
    const stale = await webhook(payload, signWebhook(payload, staleTimestamp));
    expect(stale.status).toBe(403);

    const forged = signWebhook(payload).replace(/v=[0-9a-f]/, (match) => (match.endsWith("0") ? "v=1" : "v=0"));
    const forgedResponse = await webhook(payload, forged);
    expect(forgedResponse.status).toBe(403);
    await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { reason: "Test cleanup" }, 200);
  });

  it("applies a valid webhook once and ignores the replay", async () => {
    const created = await startCheckout("quarterly");
    const payload = payloadFor(created);
    const signature = signWebhook(payload);
    const first = await webhook(payload, signature);
    expect(first.status).toBe(200);
    const applied = await first.json() as { status: string; duplicate: boolean };
    expect(applied).toMatchObject({ status: "succeeded", duplicate: false });

    const replay = await webhook(payload, signature);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { duplicate: boolean }).duplicate).toBe(true);

    const checked = await h.expectOk(await h.call(admin, `/api/v1/billing/subscription-checkout/${created.id}`));
    expect(checked.checkout.status).toBe("succeeded");
  });

  it("refuses a webhook whose amount or currency does not match the checkout", async () => {
    const created = await startCheckout("annually");
    const mismatched = await webhook(payloadFor(created, { amount: created.amountUgx + 1 }));
    expect(mismatched.status).toBe(200);
    expect((await mismatched.json() as { status: string }).status).toBe("indeterminate");

    const afterMismatch = await h.expectOk(await h.call(admin, `/api/v1/billing/subscription-checkout/${created.id}`));
    expect(afterMismatch.checkout.status).toBe("indeterminate");
    expect(afterMismatch.checkout.statusDetail).toContain("not applied");
    await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { reason: "Mismatched webhook, no charge confirmed" }, 200);

    const foreign = await startCheckout("monthly");
    const wrongCurrency = await webhook(payloadFor(foreign, { currency: "USD" }));
    expect(wrongCurrency.status).toBe(200);
    const wrongBody = await wrongCurrency.json() as { status: string; duplicate: boolean };
    expect(wrongBody.duplicate).toBe(false);
    expect(wrongBody.status).toBe("indeterminate");
    await h.post(admin, `/api/v1/billing/subscription-checkout/${foreign.id}/cancel`, { reason: "Non-UGX webhook", }, 200);
  });
});
