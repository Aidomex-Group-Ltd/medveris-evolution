import { createSign, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FxUnavailableError } from "../../apps/api/src/integrations/fx.js";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const yoPublicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

function sign(data: string): string {
  const signer = createSign("RSA-SHA1");
  signer.update(data);
  return signer.sign(keys.privateKey).toString("base64");
}

const FX_RATE = 3800;
/** Mutable so a test can change the provider rate after a checkout was created. */
let fxRate = FX_RATE;
/** Set to simulate the provider being unreachable, which is when the manual fallback applies. */
let fxDown = false;
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
        if (fxDown) throw new FxUnavailableError("The exchange rate provider could not be reached");
        return { base: "USD", quote: "UGX", rate: fxRate, provider: "test-fx", providerTimestamp: new Date(Date.now() - 60_000) };
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

  it("keeps displayed and charged UGX amount equal (single rounding, quote lock)", async () => {
    const { withContext } = await import("@medveris/db");
    const price = await quote("monthly");
    const created = await startCheckout("monthly");
    expect(created.amountUgx).toBe(price.amountUgx);
    // Change provider rate after checkout is created; stored quote/amount must remain unchanged.
    fxRate = FX_RATE + 777;
    const [row] = await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, (tx) =>
      tx`select amount_ugx, fx_rate from subscription_checkouts where id = ${created.id}`);
    expect(Number(row?.amountUgx)).toBe(price.amountUgx);
    expect(Number(row?.fxRate)).toBe(FX_RATE);
    fxRate = FX_RATE;
    await h.post(admin, `/api/v1/billing/subscription-checkout/${created.id}/cancel`, { reason: "quote lock verification cleanup" }, 200);
  });

  it("refreshes the shared rate cache as the system actor, not the requesting staff actor", async () => {
    const { withContext } = await import("@medveris/db");
    // A staff member asking for a quote triggers the provider fetch and the cache write.
    const result = await quote("monthly");
    expect(result.fx.source).toBe("test-fx");
    const [cached] = await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, (tx) =>
      tx`select rate, provider from subscription_fx_rates where base = 'USD' and quote = 'UGX'`);
    expect(cached, "the quote should have persisted the provider rate").toBeDefined();
    expect(Number(cached?.rate)).toBe(FX_RATE);
    expect(cached?.provider).toBe("test-fx");
    // The same table refuses the write when it is attempted as the requesting staff actor,
    // because the rate is shared pricing state rather than tenant data (migration 136).
    await expect(withContext(h.sql, { actorKind: "staff", tenantId: KAMPALA_TENANT }, (tx) =>
      tx`insert into subscription_fx_rates (base, quote, rate, provider, provider_timestamp, fetched_at)
         values ('EUR', 'UGX', 1, 'test-eur', now(), now())`,
    )).rejects.toThrow(/row-level security|permission denied/i);
  });

  it("uses the most recently set manual rate when more than one is valid", async () => {
    const { withContext } = await import("@medveris/db");
    // Manual rates only apply when the provider is unreachable and the cached rate is stale.
    fxDown = true;
    await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, async (tx) => {
      await tx`update subscription_fx_rates set provider_timestamp = now() - interval '30 days', fetched_at = now() - interval '30 days'
                where base = 'USD' and quote = 'UGX'`;
      // Rows are retired by expiry, not deletion: migration 136 grants no DELETE policy on either
      // table (a break-glass rate lapses; it is never removed).
      await tx`update subscription_fx_manual_rates set expires_at = now() - interval '1 second'
                where base = 'USD' and quote = 'UGX'`;
      // Both rows are valid (non-expired, set within FX_MAX_AGE_HOURS), but the older rate has the
      // longer window. The operator's latest correction must win, not the longest expiry.
      await tx`insert into subscription_fx_manual_rates (id, base, quote, rate, set_at, expires_at, note) values
        (gen_random_uuid(), 'USD', 'UGX', 3900, now() - interval '20 hours', now() + interval '8 days', 'older rate, longer window'),
        (gen_random_uuid(), 'USD', 'UGX', 3950, now() - interval '1 hour',  now() + interval '2 hours', 'newer correction, shorter window')`;
    });
    try {
      const result = await quote("monthly");
      expect(result.fx.source).toBe("manual");
      expect(result.fx.rate).toBe(3950);
    } finally {
      fxDown = false;
      await withContext(h.sql, { actorKind: "system", tenantId: KAMPALA_TENANT }, async (tx) => {
        await tx`update subscription_fx_manual_rates set expires_at = now() - interval '1 second'
                  where base = 'USD' and quote = 'UGX' and expires_at > now()`;
        await tx`update subscription_fx_rates set rate = ${FX_RATE}, provider = 'test-fx', provider_timestamp = now(), fetched_at = now()
                  where base = 'USD' and quote = 'UGX'`;
      });
    }
  });
});
