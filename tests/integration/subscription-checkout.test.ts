import { createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const yoPublicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function sign(data: string): string {
  const signer = createSign("RSA-SHA1");
  signer.update(data);
  return signer.sign(keys.privateKey).toString("base64");
}

const FX_RATE = 3800;
let transactions = 0;
const deposits: string[] = [];

/** Fake Yo! gateway: a deposit answers PENDING with a transaction reference, as the sandbox does. */
async function fakeYo(_url: string, init?: RequestInit): Promise<Response> {
  const body = String(init?.body ?? "");
  deposits.push(body);
  const reference = /<ExternalReference>([^<]+)</.exec(body)?.[1] ?? "";
  if (body.includes("<Method>acdepositfunds</Method>")) {
    transactions += 1;
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Response><Status>OK</Status><StatusCode>1</StatusCode><TransactionStatus>PENDING</TransactionStatus><TransactionReference>YOSUB-${transactions}-${reference.slice(-6)}</TransactionReference></Response></AutoCreate>`);
  }
  return new Response(`<AutoCreate><Response><Status>OK</Status><StatusCode>1</StatusCode><TransactionStatus>PENDING</TransactionStatus><TransactionReference>YOSUB-${transactions}</TransactionReference></Response></AutoCreate>`);
}

const h = createHarness("subscription-checkout", {
  env: {
    FEATURE_PAYMENTS: "true", YO_MODE: "sandbox",
    YO_API_USERNAME: "synthetic-yo-user", YO_API_PASSWORD: "synthetic-yo-password", YO_PUBLIC_KEY: yoPublicKey,
  },
  deps: () => ({
    yoTransport: fakeYo,
    fxProvider: {
      name: "test-fx",
      async rate() {
        return { base: "USD", quote: "UGX", rate: FX_RATE, provider: "test-fx", providerTimestamp: new Date(Date.now() - 60_000) };
      },
    },
  }),
});

let admin: Session;

beforeAll(async () => {
  admin = await h.login("admin@medveris.local");
  // A previous interrupted run can leave an unresolved prompt, which correctly blocks a new one.
  // Clear only this account's unresolved test checkouts so each run starts from the same state.
  const { withContext } = await import("@medveris/db");
  await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, async (tx) => {
    await tx`
      update subscription_checkouts set status = 'cancelled', status_detail = 'Cancelled by the test setup', completed_at = now(), updated_at = now()
       where status in ('pending','indeterminate')
         and billing_account_id in (select billing_account_id from tenants where id = ${KAMPALA_TENANT})
    `;
  });
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

interface Quote {
  interval: string;
  seats: number;
  unitPriceUsdMinor: number;
  amountUsdMinor: number;
  amountUgx: number;
  fx: { rate: number; source: string; providerTimestamp: string | null };
  periodStart: string;
  periodEnd: string;
  nextRenewalAt: string;
  renewalMode: string;
  disclosure: string;
}

interface Checkout {
  id: string;
  status: string;
  amountUgx: number;
  amountUsdMinor: number;
  periodEnd: string;
  nextRenewalAt: string;
  externalReference: string;
  canCancel: boolean;
  success?: boolean;
}

async function quote(interval: string): Promise<Quote> {
  const body = await h.expectOk(await h.call(admin, `/api/v1/billing/subscription-checkout/quote?interval=${interval}`));
  return body.quote as Quote;
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

async function paymentNotification(externalRef: string, amount: number, networkRef: string): Promise<Response> {
  const fields = {
    date_time: "2026-10-30 12:00:00", amount: String(amount), narrative: "Subscription", network_ref: networkRef,
    external_ref: externalRef, msisdn: "256772123456",
  };
  return h.app.fetch(new Request("http://localhost/api/v1/public/payments/yo/subscriptions", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...fields,
      signature: sign(fields.date_time + fields.amount + fields.narrative + fields.network_ref + fields.external_ref + fields.msisdn),
    }).toString(),
  }));
}

async function failureNotification(reference: string): Promise<Response> {
  const fields = { failed_transaction_reference: reference, transaction_init_date: "2026-10-30 12:00:00" };
  return h.app.fetch(new Request("http://localhost/api/v1/public/payments/yo/subscriptions/failures", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, verification: sign(fields.failed_transaction_reference + fields.transaction_init_date) }).toString(),
  }));
}

describe("subscription checkout", () => {
  it("quotes every interval at USD 0.50 per active user in UGX", async () => {
    for (const interval of ["daily", "weekly", "monthly", "quarterly", "annually"]) {
      const result = await quote(interval);
      expect(result.interval).toBe(interval);
      expect(result.seats).toBeGreaterThan(0);
      expect(result.unitPriceUsdMinor).toBe(50);
      expect(result.amountUsdMinor).toBe(result.seats * 50);
      expect(result.amountUgx).toBe(Math.ceil((result.amountUsdMinor / 100) * FX_RATE));
      expect(result.fx.rate).toBe(FX_RATE);
      expect(result.fx.source).toBe("test-fx");
      expect(new Date(result.periodEnd).getTime()).toBeGreaterThan(new Date(result.periodStart).getTime());
      expect(result.nextRenewalAt).toBe(result.periodEnd);
      expect(result.renewalMode).toBe("manual");
      expect(result.disclosure).toContain("Renewal is manual");
      expect(result.disclosure).toContain(`UGX ${result.amountUgx.toLocaleString("en-UG")}`);
    }
  });

  it("records one checkout, confirms it once from a signed Yo! notification, and extends the paid period", async () => {
    const price = await quote("monthly");
    const key = crypto.randomUUID();
    const created = await h.post(admin, "/api/v1/billing/subscription-checkout", {
      interval: "monthly", msisdn: "0772 123456", consent: true,
    }, 201, key) as { checkout: Checkout };
    expect(created.checkout.status).toBe("pending");
    expect(created.checkout.externalReference).toMatch(/^MS-/);
    expect(created.checkout.amountUgx).toBe(price.amountUgx);

    const replay = await h.post(admin, "/api/v1/billing/subscription-checkout", {
      interval: "monthly", msisdn: "0772 123456", consent: true,
    }, 200, key) as { checkout: Checkout; replayed: boolean };
    expect(replay.replayed).toBe(true);
    expect(replay.checkout.id).toBe(created.checkout.id);
    expect(deposits.filter((body) => body.includes(created.checkout.externalReference))).toHaveLength(1);

    const networkRef = `NET-${crypto.randomUUID()}`;
    const confirmed = await h.expectOk(await paymentNotification(created.checkout.externalReference, created.checkout.amountUgx, networkRef));
    expect(confirmed.status).toBe("succeeded");
    expect(confirmed.applied).toBe(true);

    const duplicate = await h.expectOk(await paymentNotification(created.checkout.externalReference, created.checkout.amountUgx, networkRef));
    expect(duplicate.duplicate).toBe(true);

    const data = await overview();
    expect(data.subscription.status).toBe("active");
    expect(new Date(data.subscription.currentPeriodEnd).toISOString()).toBe(new Date(created.checkout.periodEnd).toISOString());
    expect(data.notifications.some((row: { kind: string }) => row.kind === "payment-received")).toBe(true);
  });

  it("never treats a mismatched amount as payment", async () => {
    const before = await overview();
    const created = await startCheckout("weekly");
    const mismatched = await h.expectOk(await paymentNotification(created.externalReference, created.amountUgx + 1, `NET-${crypto.randomUUID()}`));
    expect(mismatched.status).toBe("indeterminate");
    expect(mismatched.applied).toBe(false);

    const status = await h.expectOk(await h.call(admin, `/api/v1/billing/subscription-checkout/${created.id}`));
    expect(status.checkout.status).toBe("indeterminate");
    expect(status.checkout.statusDetail).toContain("not applied");

    const after = await overview();
    expect(after.subscription.currentPeriodEnd).toBe(before.subscription.currentPeriodEnd);
    await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { reason: "Mismatched amount, no charge confirmed" }, 200);
  });

  it("marks a declined prompt failed and keeps the paid period unchanged", async () => {
    const before = await overview();
    const created = await startCheckout("daily");
    const failed = await h.expectOk(await failureNotification(created.externalReference));
    expect(failed.status).toBe("failed");
    const status = await h.expectOk(await h.call(admin, `/api/v1/billing/subscription-checkout/${created.id}`));
    expect(status.checkout.status).toBe("failed");
    const after = await overview();
    expect(after.subscription.currentPeriodEnd).toBe(before.subscription.currentPeriodEnd);
  });

  it("cancels an unresolved prompt without changing access", async () => {
    const created = await startCheckout("quarterly");
    expect(created.canCancel).toBe(true);
    const cancelled = await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { reason: "Payer changed their mind" }, 200);
    expect(cancelled.checkout.status).toBe("cancelled");
    const again = await h.call(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: "Second attempt" }) });
    expect(again.status).toBe(409);
  });

  it("reports manual renewal with no automatic charge", async () => {
    const body = await h.expectOk(await h.call(admin, "/api/v1/billing/subscription-renewal"));
    expect(body.renewal.renewalMode).toBe("manual");
    expect(body.renewal.automaticCharge).toBe(false);
    expect(body.renewal.amountUgx).toBeGreaterThan(0);
    expect(body.renewal.disclosure).toContain("Renewal is manual");
  });
});
