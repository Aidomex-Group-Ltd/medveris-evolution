import type { Tx } from "@medveris/db";
import {
  billingIntervalPeriod,
  checkoutDisclosure,
  exchangeRateIsStaleHours,
  maskMsisdn,
  SEAT_PRICE_USD_MINOR,
  seatAmountUsdMinor,
  usdMinorToUgx,
  type BillingInterval,
} from "@medveris/domain";
import { notifyAccount, recordSubscriptionEvent } from "../../../jobs/src/billing.js";
import type { AppConfig } from "../config.js";
import { createFxProvider, FxUnavailableError, maskFxSecrets } from "../integrations/fx.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, ConflictError, NotFoundError } from "../lib/errors.js";
import type { AppDeps } from "../types.js";

export interface SubscriptionFx {
  base: "USD";
  quote: "UGX";
  rate: number;
  source: string;
  providerTimestamp: Date | null;
  recordedAt: Date;
  fallback: boolean;
}

export interface CheckoutQuote {
  interval: BillingInterval;
  seats: number;
  unitPriceUsdMinor: number;
  amountUsdMinor: number;
  amountUgx: number;
  fx: SubscriptionFx;
  periodStart: Date;
  periodEnd: Date;
  nextRenewalAt: Date;
  renewalMode: "manual";
  product: string;
  disclosure: string;
  minUgx: number;
}

export interface CheckoutActor {
  kind: "system" | "staff";
  userId: string | null;
  tenantId: string;
}

export interface FxResolutionContext {
  billingAccountId?: string | null;
  correlationId?: string | null;
  tenantId?: string | null;
}

const FX_EVENT = "subscription_fx_rate";

function fxLog(level: "info" | "warn" | "error", event: string, detail: Record<string, unknown>) {
  const payload = { event, level, ...detail };
  if (level === "error") console.error(JSON.stringify(payload));
  else if (level === "warn") console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function stale(maxAgeHours: number, when: Date | null, now: Date): boolean {
  if (!when) return true;
  return exchangeRateIsStaleHours(when, now, maxAgeHours);
}

/**
 * Resolves a USD/UGX rate: fresh provider fetch (cached in DB), then cached provider rate, then an
 * operator-set manual DB rate (non-expired) as fallback. Any rate older than FX_MAX_AGE_HOURS is
 * refused. If no valid rate exists, pricing fails closed and a structured alerting event is logged.
 */
export async function subscriptionExchangeRate(
  tx: Tx,
  config: AppConfig,
  deps: Pick<AppDeps, "fxProvider">,
  now = new Date(),
  ctx: FxResolutionContext = {},
): Promise<SubscriptionFx> {
  const maxAgeHours = config.subscription.fxMaxAgeHours;
  const meta = { correlationId: ctx.correlationId ?? null, billingAccountId: ctx.billingAccountId ?? null, base: "USD", quote: "UGX" };
  const provider = deps.fxProvider ?? createFxProvider(config.fx);

  if (provider) {
    try {
      const quote = await provider.rate("USD", "UGX");
      if (stale(maxAgeHours, quote.providerTimestamp, now)) {
        fxLog("warn", FX_EVENT, { ...meta, outcome: "provider_stale", provider: quote.provider, providerTimestamp: quote.providerTimestamp.toISOString(), maxAgeHours });
      } else {
        await tx`
          insert into subscription_fx_rates (base, quote, rate, provider, provider_timestamp, fetched_at)
          values ('USD', 'UGX', ${quote.rate}, ${quote.provider}, ${quote.providerTimestamp}, ${now})
          on conflict (base, quote) do update set
            rate = excluded.rate,
            provider = excluded.provider,
            provider_timestamp = excluded.provider_timestamp,
            fetched_at = excluded.fetched_at
        `;
        fxLog("info", FX_EVENT, { ...meta, outcome: "provider_fresh", provider: quote.provider, providerTimestamp: quote.providerTimestamp.toISOString() });
        return { base: "USD", quote: "UGX", rate: quote.rate, source: quote.provider, providerTimestamp: quote.providerTimestamp, recordedAt: now, fallback: false };
      }
    } catch (error) {
      const message = error instanceof FxUnavailableError ? error.message : maskFxSecrets((error as Error)?.message || "provider_error");
      fxLog("warn", FX_EVENT, { ...meta, outcome: "provider_failed", reason: message });
      // fall through to cached/manual
    }
  } else {
    fxLog("warn", FX_EVENT, { ...meta, outcome: "provider_unconfigured" });
  }

  const [cached] = await tx`
    select rate, provider, provider_timestamp, fetched_at from subscription_fx_rates
     where base = 'USD' and quote = 'UGX' limit 1
  `;
  if (cached && !stale(maxAgeHours, new Date(cached.providerTimestamp as Date), now)) {
    fxLog("info", FX_EVENT, { ...meta, outcome: "cache_used", provider: String(cached.provider), providerTimestamp: new Date(cached.providerTimestamp as Date).toISOString() });
    return {
      base: "USD", quote: "UGX", rate: Number(cached.rate), source: String(cached.provider),
      providerTimestamp: new Date(cached.providerTimestamp as Date), recordedAt: new Date(cached.fetchedAt as Date), fallback: false,
    };
  }
  if (cached) {
    fxLog("warn", FX_EVENT, { ...meta, outcome: "cache_stale", provider: String(cached.provider), providerTimestamp: new Date(cached.providerTimestamp as Date).toISOString(), maxAgeHours });
  }

  const [manual] = await tx`
    select rate, expires_at, set_at from subscription_fx_manual_rates
     where base = 'USD' and quote = 'UGX' and expires_at > ${now}
     order by expires_at desc, set_at desc limit 1
  `;
  if (manual && !stale(maxAgeHours, new Date(manual.setAt as Date), now)) {
    fxLog("warn", FX_EVENT, { ...meta, outcome: "manual_fallback", expiresAt: new Date(manual.expiresAt as Date).toISOString() });
    return {
      base: "USD", quote: "UGX", rate: Number(manual.rate), source: "manual",
      providerTimestamp: new Date(manual.setAt as Date), recordedAt: now, fallback: true,
    };
  }
  if (manual) {
    fxLog("warn", FX_EVENT, { ...meta, outcome: "manual_expired_or_stale", expiresAt: new Date(manual.expiresAt as Date).toISOString(), maxAgeHours });
  } else {
    fxLog("warn", FX_EVENT, { ...meta, outcome: "manual_missing" });
  }

  fxLog("error", FX_EVENT, { ...meta, outcome: "unavailable", reason: "no_valid_rate", maxAgeHours });
  throw new AppError(
    503,
    "exchange_rate_unavailable",
    "The UGX price is not available right now, so no payment can be requested. Please try again later or contact support and share the reference shown.",
    { correlationId: ctx.correlationId ?? null },
  );
}

/** Active distinct users across every workspace paid for by this billing account. */
export async function billingSeats(tx: Tx, billingAccountId: string): Promise<number> {
  const [row] = await tx`
    select count(distinct m.user_id)::int as seats
      from memberships m join tenants t on t.id = m.tenant_id
     where t.billing_account_id = ${billingAccountId} and m.status = 'active'
  `;
  return Math.max(1, Number(row?.seats ?? 0));
}

/**
 * The price, period and terms for one interval. A paid period starts when the current paid period
 * ends (or now, when nothing is paid), so an early renewal extends access instead of discarding it.
 * The UGX amount is computed once here from the resolved rate (single rounding point).
 */
export async function quoteCheckout(
  tx: Tx,
  config: AppConfig,
  deps: Pick<AppDeps, "fxProvider">,
  billingAccountId: string,
  interval: BillingInterval,
  now = new Date(),
  ctx: FxResolutionContext = {},
): Promise<CheckoutQuote> {
  const [subscription] = await tx`
    select id, status, current_period_end from subscriptions
     where billing_account_id = ${billingAccountId} order by (status <> 'cancelled') desc, created_at desc limit 1
  `;
  if (!subscription) throw new AppError(404, "billing_account_missing", "This account has no subscription yet. Contact Medveris support.");
  if (String(subscription.status) === "cancelled") {
    throw new ConflictError("This subscription was cancelled. Contact Medveris support to restart billing before paying for a new period.");
  }
  const seats = await billingSeats(tx, billingAccountId);
  const amountUsdMinor = seatAmountUsdMinor(seats);
  const fx = await subscriptionExchangeRate(tx, config, deps, now, { ...ctx, billingAccountId });
  const amountUgx = usdMinorToUgx(amountUsdMinor, fx.rate);
  if (amountUgx < config.subscription.minUgx) {
    throw new AppError(422, "amount_below_minimum", `The UGX equivalent for ${seats} user${seats === 1 ? "" : "s"} is below the UGX ${config.subscription.minUgx.toLocaleString("en-UG")} minimum for a mobile-money collection. Add an active user or choose a longer interval.`, {
      seats, amountUsdMinor, amountUgx, minUgx: config.subscription.minUgx, rate: fx.rate,
    });
  }
  const paidUntil = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd as Date) : null;
  const start = paidUntil && paidUntil > now && ["active", "past_due", "restricted"].includes(String(subscription.status)) ? paidUntil : now;
  const period = billingIntervalPeriod(start, interval);
  const disclosure = checkoutDisclosure({
    product: config.subscription.productDescription,
    seats,
    interval,
    amountUgx,
    amountUsdMinor,
    periodStart: period.start,
    periodEnd: period.end,
    rate: fx.rate,
    rateSource: fx.source,
    rateTimestamp: fx.providerTimestamp,
    minUgx: config.subscription.minUgx,
  });
  return {
    interval, seats, unitPriceUsdMinor: SEAT_PRICE_USD_MINOR, amountUsdMinor, amountUgx, fx,
    periodStart: period.start, periodEnd: period.end, nextRenewalAt: period.end,
    renewalMode: "manual", product: config.subscription.productDescription, disclosure, minUgx: config.subscription.minUgx,
  };
}

export interface CreatedCheckout {
  checkoutId: string;
  externalReference: string;
  quote: CheckoutQuote;
}

/**
 * Locks the priced quote to a payment record: the rate, its timestamp/source and the UGX amount are
 * stored and the provider is charged that stored amount. A later rate change does not affect it.
 */
export async function createCheckout(tx: Tx, config: AppConfig, deps: Pick<AppDeps, "fxProvider">, input: {
  billingAccountId: string;
  interval: BillingInterval;
  msisdn: string;
  idempotencyKey: string;
  initiatedBy: string;
  actor: CheckoutActor;
  now?: Date;
  correlationId?: string | null;
}): Promise<CreatedCheckout> {
  const quote = await quoteCheckout(tx, config, deps, input.billingAccountId, input.interval, input.now ?? new Date(), {
    billingAccountId: input.billingAccountId, correlationId: input.correlationId ?? null, tenantId: input.actor.tenantId,
  });
  const [subscription] = await tx`select id from subscriptions where billing_account_id = ${input.billingAccountId} order by (status <> 'cancelled') desc, created_at desc limit 1`;
  const checkoutId = crypto.randomUUID();
  const provider = config.payments.provider;
  // LivePay refuses references longer than 30 characters; the Yo! reference keeps its existing shape
  // so in-flight sandbox checkouts and notifications remain reconcilable.
  const externalReference = provider === "livepay"
    ? `MS${checkoutId.replace(/-/g, "").slice(0, 20).toUpperCase()}`
    : `MS-${checkoutId.replace(/-/g, "").toUpperCase()}`;
  const providerMode = provider === "livepay" ? "live" : config.yo.mode;
  const providerLabel = provider === "livepay" ? "LivePay" : "Yo!";
  await tx`
    insert into subscription_checkouts (
      id, billing_account_id, subscription_id, interval, seats, unit_price_usd_minor, amount_usd_minor, amount_ugx,
      fx_base, fx_quote, fx_rate, fx_source, fx_provider_timestamp, fx_recorded_at, fx_rounding,
      period_start, period_end, product, disclosure, msisdn, provider, provider_mode, external_reference,
      idempotency_key, initiated_by, status_detail
    ) values (
      ${checkoutId}, ${input.billingAccountId}, ${subscription ? String(subscription.id) : null}, ${quote.interval}, ${quote.seats},
      ${quote.unitPriceUsdMinor}, ${quote.amountUsdMinor}, ${quote.amountUgx},
      ${quote.fx.base}, ${quote.fx.quote}, ${quote.fx.rate}, ${quote.fx.source}, ${quote.fx.providerTimestamp}, ${quote.fx.recordedAt}, 'ceil-whole-shilling',
      ${quote.periodStart}, ${quote.periodEnd}, ${quote.product}, ${quote.disclosure}, ${input.msisdn}, ${provider}, ${providerMode},
      ${externalReference}, ${input.idempotencyKey}, ${input.initiatedBy}, ${`Sending the payment prompt to ${providerLabel}`}
    )
  `;
  await writeAudit(tx, config, {
    tenantId: input.actor.tenantId, actorKind: input.actor.kind, actorUserId: input.actor.userId, actorRoles: [],
    action: "subscription.checkout.request", resourceType: "SubscriptionCheckout", resourceId: checkoutId,
    correlationId: input.correlationId ?? null,
    metadata: { interval: quote.interval, seats: quote.seats, amountUsdMinor: quote.amountUsdMinor, amountUgx: quote.amountUgx, rate: quote.fx.rate, rateSource: quote.fx.source, msisdn: maskMsisdn(input.msisdn), provider, mode: providerMode },
  });
  return { checkoutId, externalReference, quote };
}

export interface CheckoutEvidence {
  kind: "initiate" | "ipn" | "failure-notification" | "status-check";
  dedupeKey: string;
  outcome: "succeeded" | "failed" | "pending" | "indeterminate";
  providerStatus: string | null;
  providerReference?: string | null;
  networkReference?: string | null;
  confirmedAmount?: number | null;
  statusMessage?: string | null;
  payloadDigest?: string | null;
  detail?: Record<string, unknown>;
}

export interface CheckoutOutcome {
  status: string;
  applied: boolean;
  duplicate: boolean;
}

/**
 * Applies one piece of provider evidence to a checkout. Success requires the provider's amount to
 * match the UGX amount disclosed at checkout; a mismatch is never treated as payment. Only this
 * function moves money state, and each dedupe key applies once.
 */
export async function applyCheckoutEvidence(tx: Tx, config: AppConfig, checkoutId: string, evidence: CheckoutEvidence, actor: CheckoutActor): Promise<CheckoutOutcome> {
  const [checkout] = await tx`select * from subscription_checkouts where id = ${checkoutId} for update`;
  if (!checkout) throw new NotFoundError("Subscription checkout not found");
  const current = String(checkout.status);
  const provider = String(checkout.provider) === "livepay" ? "LivePay" : "Yo!";
  const [seen] = await tx`
    insert into subscription_checkout_events (id, checkout_id, kind, dedupe_key, outcome, provider_status, payload_digest, detail)
    values (${crypto.randomUUID()}, ${checkoutId}, ${evidence.kind}, ${evidence.dedupeKey}, 'ignored', ${evidence.providerStatus},
      ${evidence.payloadDigest ?? null}, ${tx.json((evidence.detail ?? {}) as never)})
    on conflict (checkout_id, dedupe_key) do nothing
    returning id
  `;
  if (!seen) return { status: current, applied: false, duplicate: true };

  let next = current;
  let detail = checkout.statusDetail as string | null;
  let applied = false;
  const amount = Number(checkout.amountUgx);

  if (evidence.outcome === "succeeded" && current !== "succeeded") {
    const confirmed = evidence.confirmedAmount == null ? null : Math.round(evidence.confirmedAmount);
    if (confirmed == null || !Number.isFinite(confirmed)) {
      next = current === "pending" ? "indeterminate" : current;
      detail = `${provider} reported success without an amount; nothing was applied. Check the status again to reconcile.`;
      await writeAudit(tx, config, {
        tenantId: actor.tenantId, actorKind: actor.kind, actorUserId: actor.userId, actorRoles: [],
        action: "subscription.checkout.amount-missing", resourceType: "SubscriptionCheckout", resourceId: checkoutId,
        metadata: { requestedUgx: amount, evidence: evidence.kind },
      });
    } else if (confirmed !== amount) {
      next = current === "pending" ? "indeterminate" : current;
      detail = `${provider} confirmed ${confirmed.toLocaleString("en-UG")} UGX but ${amount.toLocaleString("en-UG")} UGX was requested; not applied. Reconcile with ${provider} before taking another payment.`;
      await writeAudit(tx, config, {
        tenantId: actor.tenantId, actorKind: actor.kind, actorUserId: actor.userId, actorRoles: [],
        action: "subscription.checkout.amount-mismatch", resourceType: "SubscriptionCheckout", resourceId: checkoutId,
        metadata: { requestedUgx: amount, confirmedUgx: confirmed, evidence: evidence.kind },
      });
    } else {
      next = "succeeded";
      applied = true;
      detail = `Payment confirmed by ${provider}`;
      await tx`
        update subscription_checkouts set status = 'succeeded', completed_at = now(), updated_at = now(),
          provider_reference = coalesce(provider_reference, ${evidence.providerReference ?? null}),
          network_reference = coalesce(${evidence.networkReference ?? null}, network_reference),
          status_detail = ${detail}
         where id = ${checkoutId}
      `;
      const subscription = checkout.subscriptionId ? await tx`select * from subscriptions where id = ${checkout.subscriptionId} for update` : [];
      if (!subscription[0]) throw new ConflictError("The subscription for this checkout no longer exists; the payment needs operator reconciliation.");
      if (String(subscription[0].status) === "cancelled") throw new ConflictError("The subscription was cancelled before this payment was confirmed; the payment needs operator reconciliation.");
      await tx`
        update subscriptions set status = 'active',
          current_period_start = ${checkout.periodStart}, current_period_end = ${checkout.periodEnd},
          billing_interval = ${checkout.interval}, seats = ${Number(checkout.seats)}, renewal_mode = 'manual',
          next_renewal_at = ${checkout.periodEnd}, status_reason = ${`Paid for one ${String(checkout.interval)} with ${provider === "LivePay" ? "LivePay" : "Yo!"} mobile money`},
          status_changed_at = now(), version = version + 1, updated_at = now()
         where id = ${checkout.subscriptionId}
      `;
      await recordSubscriptionEvent(tx, {
        subscriptionId: String(checkout.subscriptionId), billingAccountId: String(checkout.billingAccountId), event: "checkout-paid",
        fromStatus: String(subscription[0].status) as never, toStatus: "active",
        detail: { checkoutId, interval: String(checkout.interval), seats: Number(checkout.seats), amountUgx: amount, amountUsdMinor: Number(checkout.amountUsdMinor), rate: Number(checkout.fxRate), periodEnd: new Date(checkout.periodEnd as Date).toISOString(), renewalMode: "manual", provider: String(checkout.provider) },
        actorKind: actor.kind === "system" ? "system" : "staff", actorUserId: actor.userId,
      });
      await notifyAccount(tx, {
        billingAccountId: String(checkout.billingAccountId), kind: "payment-received",
        title: "Subscription paid with mobile money",
        body: `UGX ${amount.toLocaleString("en-UG")} was confirmed by ${provider} for one ${String(checkout.interval)}. Access runs to ${new Date(checkout.periodEnd as Date).toISOString().slice(0, 10)}. Renewal is manual: you will be reminded before that date.`,
        dedupeKey: `subscription-checkout-paid:${checkoutId}`,
      });
      await writeAudit(tx, config, {
        tenantId: actor.tenantId, actorKind: actor.kind, actorUserId: actor.userId, actorRoles: [],
        action: "subscription.checkout.paid", resourceType: "SubscriptionCheckout", resourceId: checkoutId,
        metadata: { amountUgx: amount, amountUsdMinor: Number(checkout.amountUsdMinor), interval: String(checkout.interval), seats: Number(checkout.seats), periodEnd: new Date(checkout.periodEnd as Date).toISOString(), renewalMode: "manual", evidence: evidence.kind },
      });
    }
  } else if (evidence.outcome === "failed" && ["pending", "indeterminate"].includes(current)) {
    next = "failed";
    applied = true;
    detail = evidence.statusMessage || "The payer declined, cancelled or did not approve the prompt in time.";
    await writeAudit(tx, config, {
      tenantId: actor.tenantId, actorKind: actor.kind, actorUserId: actor.userId, actorRoles: [],
      action: "subscription.checkout.failed", resourceType: "SubscriptionCheckout", resourceId: checkoutId,
      metadata: { reason: detail, evidence: evidence.kind },
    });
  } else if (evidence.outcome === "pending" && current === "pending") {
    applied = true;
    detail = "Waiting for the payer to approve the prompt on their phone.";
  } else if (evidence.outcome === "indeterminate" && current === "pending") {
    next = "indeterminate";
    applied = true;
    detail = evidence.statusMessage || `${provider} has not resolved this transaction yet; check again before paying.`;
  }

  await tx`
    update subscription_checkout_events set outcome = ${applied ? "applied" : "ignored"},
      detail = ${tx.json({ ...(evidence.detail ?? {}), from: current, to: next } as never)}
     where checkout_id = ${checkoutId} and dedupe_key = ${evidence.dedupeKey}
  `;
  await tx`
    update subscription_checkouts set status = ${next}, status_detail = ${detail}, updated_at = now(),
      failure_reason = case when ${next}::text = 'failed' then ${detail} else failure_reason end,
      completed_at = case when ${next}::text in ('failed','cancelled') and completed_at is null then now() else completed_at end,
      provider_reference = coalesce(provider_reference, ${evidence.providerReference ?? null}),
      network_reference = coalesce(${evidence.networkReference ?? null}, network_reference)
     where id = ${checkoutId}
  `;
  return { status: next, applied, duplicate: false };
}
