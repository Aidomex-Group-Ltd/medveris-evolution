import { Hono } from "hono";
import { billingIntervalSchema, subscriptionCheckoutCancelSchema, subscriptionCheckoutSchema } from "@medveris/contracts";
import { maskMsisdn, normalizeUgandaMsisdn } from "@medveris/domain";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { assertIntegrationAvailable } from "../integrations/registry.js";
import { createYoClient, YoTransportError, yoOutcome } from "../integrations/yo.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import { parseJson } from "../lib/http.js";
import { idempotencyKey, uniqueViolation } from "../lib/idempotency.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { applyCheckoutEvidence, createCheckout, quoteCheckout } from "../services/subscription-checkout.js";
import { assertBillingManage, assertBillingView, billingScope, withBillingSystem } from "../services/subscriptions.js";
import type { AppEnv } from "../types.js";

/** Self-service subscription checkout paid with a Yo! mobile money prompt. */
export const subscriptionCheckoutRoutes = new Hono<AppEnv>();

function checkoutView(row: Record<string, unknown>) {
  const status = String(row.status);
  return {
    id: String(row.id),
    status,
    interval: String(row.interval),
    seats: Number(row.seats),
    unitPriceUsdMinor: Number(row.unitPriceUsdMinor),
    amountUsdMinor: Number(row.amountUsdMinor),
    amountUgx: Number(row.amountUgx),
    fx: {
      base: String(row.fxBase), quote: String(row.fxQuote), rate: Number(row.fxRate), source: String(row.fxSource),
      providerTimestamp: row.fxProviderTimestamp ?? null, recordedAt: row.fxRecordedAt, rounding: String(row.fxRounding),
    },
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    nextRenewalAt: row.periodEnd,
    renewalMode: "manual",
    product: String(row.product),
    disclosure: String(row.disclosure),
    msisdn: maskMsisdn(String(row.msisdn)),
    provider: String(row.provider),
    providerMode: String(row.providerMode),
    externalReference: String(row.externalReference),
    statusDetail: row.statusDetail ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    canCancel: status === "pending" || status === "indeterminate",
  };
}

/** The price, period, exchange rate and manual-renewal terms before any prompt is sent. */
subscriptionCheckoutRoutes.get("/billing/subscription-checkout/quote", async (c) => {
  requireStaff(c);
  const interval = billingIntervalSchema.parse(c.req.query("interval"));
  const deps = c.get("deps");
  const quote = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingManage(scope);
    return quoteCheckout(tx, deps.config, deps, scope.billingAccountId, interval);
  });
  return c.json({ quote });
});

/** Creates the checkout, then asks Yo! to prompt the payer. A browser redirect never marks it paid. */
subscriptionCheckoutRoutes.post("/billing/subscription-checkout", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  await enforceRateLimit(c, "subscriptions.checkout", auth.user.id);
  assertIntegrationAvailable(deps.config, "payments", "subscription.checkout", "no payment prompt was sent; the subscription can still be paid once mobile money is configured");
  const body = await parseJson(c, subscriptionCheckoutSchema);
  const key = idempotencyKey(c);
  if (!key) throw new ValidationError("An Idempotency-Key header is required so a retried request does not prompt the payer twice");
  const msisdn = normalizeUgandaMsisdn(body.msisdn);
  if (!msisdn) throw new ValidationError("Enter a Ugandan mobile number, for example 0772 123456", [{ path: "msisdn", message: "Invalid mobile number" }]);
  const scope = await withStaffActor(c, async (tx) => {
    const found = await billingScope(c, tx);
    assertBillingManage(found);
    return found;
  });

  const replay = async (): Promise<Record<string, unknown> | null> => withBillingSystem(c, async (tx) => {
    const [existing] = await tx`
      select * from subscription_checkouts where billing_account_id = ${scope.billingAccountId} and idempotency_key = ${key}
    `;
    return (existing as Record<string, unknown> | undefined) ?? null;
  });
  const existing = await replay();
  if (existing) return c.json({ ok: true, replayed: true, checkout: checkoutView(existing) }, 200);

  let created;
  try {
    created = await withBillingSystem(c, (tx) => createCheckout(tx, deps.config, deps, {
      billingAccountId: scope.billingAccountId, interval: body.interval, msisdn, idempotencyKey: key,
      initiatedBy: auth.user.id, actor: { kind: "staff", userId: auth.user.id, tenantId: auth.activeTenant!.id },
    }));
  } catch (error) {
    if (uniqueViolation(error) === "subscription_checkouts_one_pending") {
      throw new ConflictError("A subscription payment prompt for this account is still waiting. Check its status before starting another.");
    }
    if (uniqueViolation(error) === "subscription_checkouts_billing_account_id_idempotency_key_key") {
      const raced = await replay();
      if (raced) return c.json({ ok: true, replayed: true, checkout: checkoutView(raced) }, 200);
    }
    throw error;
  }

  let evidence;
  try {
    const response = await createYoClient(deps.config.yo, deps.yoTransport).depositFunds({
      msisdn, amount: created.quote.amountUgx, externalReference: created.externalReference,
      narrative: `${deps.config.subscription.productDescription} - ${created.quote.interval} (${created.quote.seats} users)`,
      providerReferenceText: `Medveris subscription ${created.checkoutId.slice(0, 8)}`,
    });
    const outcome = yoOutcome(response);
    evidence = {
      kind: "initiate" as const,
      dedupeKey: "initiate",
      outcome,
      providerStatus: [response.status, response.statusCode, response.transactionStatus].filter((part) => part !== null && part !== "").join(" "),
      providerReference: response.transactionReference,
      networkReference: response.mnoTransactionReferenceId,
      confirmedAmount: outcome === "succeeded" ? created.quote.amountUgx : null,
      statusMessage: response.status === "ERROR" ? `Yo! refused the request: ${response.errorMessage ?? response.statusMessage ?? "no reason given"}` : null,
      detail: { errorCode: response.errorMessageCode ?? null },
    };
  } catch (error) {
    if (!(error instanceof YoTransportError)) throw error;
    evidence = {
      kind: "initiate" as const, dedupeKey: "initiate", outcome: "indeterminate" as const, providerStatus: null,
      statusMessage: `${error.message}. The prompt may or may not have been sent; check its status before trying again.`,
    };
  }
  const result = await withBillingSystem(c, async (tx) => {
    await applyCheckoutEvidence(tx, deps.config, created.checkoutId, evidence, { kind: "staff", userId: auth.user.id, tenantId: auth.activeTenant!.id });
    const [row] = await tx`select * from subscription_checkouts where id = ${created.checkoutId}`;
    return row as Record<string, unknown>;
  });
  return c.json({ ok: true, checkout: checkoutView(result) }, 201);
});

/** Status of one checkout. A pending prompt is never reported as paid because the browser returned. */
subscriptionCheckoutRoutes.get("/billing/subscription-checkout/:id", async (c) => {
  requireStaff(c);
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ValidationError("Invalid checkout id");
  const data = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingView(scope);
    const [row] = await tx`select * from subscription_checkouts where id = ${id} and billing_account_id = ${scope.billingAccountId}`;
    return row as Record<string, unknown> | undefined;
  });
  if (!data) return c.json({ error: { code: "not_found", message: "Checkout not found" } }, 404);
  return c.json({ checkout: checkoutView(data) });
});

/** Asks Yo! for the authoritative status. Idempotent; a settled checkout is returned unchanged. */
subscriptionCheckoutRoutes.post("/billing/subscription-checkout/:id/check", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  await enforceRateLimit(c, "subscriptions.checkout", auth.user.id);
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ValidationError("Invalid checkout id");
  const checkout = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingManage(scope);
    const [row] = await tx`select * from subscription_checkouts where id = ${id} and billing_account_id = ${scope.billingAccountId}`;
    return row as Record<string, unknown> | undefined;
  });
  if (!checkout) return c.json({ error: { code: "not_found", message: "Checkout not found" } }, 404);
  if (checkout.status === "succeeded" || checkout.status === "cancelled") return c.json({ checkout: checkoutView(checkout) });
  assertIntegrationAvailable(deps.config, "payments", "subscription.checkout", "the prompt status cannot be checked until mobile money is configured");
  let evidence;
  try {
    const response = await createYoClient(deps.config.yo, deps.yoTransport).checkStatus({ externalReference: String(checkout.externalReference) });
    const outcome = yoOutcome(response);
    evidence = {
      kind: "status-check" as const,
      dedupeKey: `status:${response.transactionReference ?? String(checkout.externalReference)}:${response.transactionStatus || response.status}`,
      outcome,
      providerStatus: [response.status, response.statusCode, response.transactionStatus].filter((part) => part !== null && part !== "").join(" "),
      providerReference: response.transactionReference,
      networkReference: response.mnoTransactionReferenceId,
      confirmedAmount: outcome === "succeeded" ? Number(response.amount ?? checkout.amountUgx) : null,
      statusMessage: response.status === "ERROR" ? `Yo! could not check this transaction: ${response.errorMessage ?? response.statusMessage ?? "no reason given"}` : null,
    };
  } catch (error) {
    if (!(error instanceof YoTransportError)) throw error;
    evidence = { kind: "status-check" as const, dedupeKey: `status:${String(checkout.externalReference)}:unreachable`, outcome: "indeterminate" as const, providerStatus: null, statusMessage: `${error.message}. The prompt may still be waiting; check again shortly.` };
  }
  const result = await withBillingSystem(c, async (tx) => {
    await applyCheckoutEvidence(tx, deps.config, id, evidence, { kind: "staff", userId: auth.user.id, tenantId: auth.activeTenant!.id });
    const [row] = await tx`select * from subscription_checkouts where id = ${id}`;
    return row as Record<string, unknown>;
  });
  return c.json({ checkout: checkoutView(result) });
});

/** Stops an unresolved prompt. A paid period is not affected. */
subscriptionCheckoutRoutes.post("/billing/subscription-checkout/:id/cancel", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ValidationError("Invalid checkout id");
  const body = await parseJson(c, subscriptionCheckoutCancelSchema);
  const row = await withBillingSystem(c, async (tx) => {
    const [checkout] = await tx`select * from subscription_checkouts where id = ${id} and billing_account_id = (
      select id from billing_accounts where id = (select billing_account_id from tenants where id = ${auth.activeTenant!.id})
    ) for update`;
    if (!checkout) return null;
    const status = String(checkout.status);
    if (!["pending", "indeterminate"].includes(status)) throw new ConflictError(`This checkout is ${status} and cannot be cancelled`);
    const detail = `Cancelled by the customer: ${body.reason}`;
    await tx`
      insert into subscription_checkout_events (id, checkout_id, kind, dedupe_key, outcome, detail)
      values (${crypto.randomUUID()}, ${id}, 'cancel', ${`cancel:${id}`}, 'applied', ${tx.json({ reason: body.reason } as never)})
      on conflict (checkout_id, dedupe_key) do nothing
    `;
    await tx`update subscription_checkouts set status = 'cancelled', status_detail = ${detail}, completed_at = now(), updated_at = now() where id = ${id}`;
    await writeAudit(tx, deps.config, {
      tenantId: auth.activeTenant!.id, actorKind: "staff", actorUserId: auth.user.id, actorRoles: auth.activeTenant!.roles,
      action: "subscription.checkout.cancel", resourceType: "SubscriptionCheckout", resourceId: id,
      metadata: { reason: body.reason },
    });
    return checkout as Record<string, unknown>;
  });
  if (!row) return c.json({ error: { code: "not_found", message: "Checkout not found" } }, 404);
  const [updated] = await withStaffActor(c, async (tx) => tx`select * from subscription_checkouts where id = ${id}`);
  return c.json({ ok: true, checkout: checkoutView(updated as Record<string, unknown>) });
});

/** The next manual renewal: what is due, when, and that nothing is charged automatically. */
subscriptionCheckoutRoutes.get("/billing/subscription-renewal", async (c) => {
  requireStaff(c);
  const deps = c.get("deps");
  const data = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingView(scope);
    const [subscription] = await tx`
      select s.billing_interval, s.seats, s.next_renewal_at, s.current_period_end, s.status, s.renewal_mode
        from subscriptions s where s.billing_account_id = ${scope.billingAccountId}
       order by (s.status <> 'cancelled') desc, s.created_at desc limit 1
    `;
    return { scope, subscription };
  });
  if (!data.subscription) return c.json({ renewal: null });
  const subscription = data.subscription as Record<string, unknown>;
  const interval = subscription.billingInterval ? String(subscription.billingInterval) : null;
  const amount = interval
    ? await withStaffActor(c, (tx) => quoteCheckout(tx, deps.config, deps, data.scope.billingAccountId, interval as never))
    : null;
  return c.json({
    renewal: {
      renewalMode: "manual",
      automaticCharge: false,
      status: String(subscription.status),
      interval,
      seats: subscription.seats == null ? null : Number(subscription.seats),
      nextRenewalAt: subscription.nextRenewalAt ?? subscription.currentPeriodEnd ?? null,
      amountUgx: amount?.amountUgx ?? null,
      amountUsdMinor: amount?.amountUsdMinor ?? null,
      fx: amount?.fx ?? null,
      disclosure: amount?.disclosure ?? null,
      note: "Nothing is charged automatically. Pay the next period from this page when you are ready; access continues to the end of the paid period.",
    },
  });
});
