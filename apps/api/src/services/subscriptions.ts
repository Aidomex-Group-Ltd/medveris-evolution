import type { Context } from "hono";
import { hmacHex } from "@medveris/auth";
import { setLocalContext, withContext, type Tx } from "@medveris/db";
import {
  accessModeFor,
  canonicalJson,
  formatMinor,
  monthlyPeriod,
  normalizeTrialEmail,
  prorateUpgradeMinor,
  sha256Hex,
  trialDaysRemaining,
  trialWindow,
  SUBSCRIPTION_STATUS_LABELS,
  type AccessMode,
  type SubscriptionStatus,
} from "@medveris/domain";
import {
  issueSubscriptionInvoice,
  lockSubscription,
  recordSubscriptionEvent,
  setSubscriptionStatus,
  startPaidPeriod,
  subscriptionFromRow,
  type BillingActorKind,
  type SubscriptionRow,
} from "../../../jobs/src/billing.js";
import type { AppConfig } from "../config.js";
import { requireStaff } from "../auth/middleware.js";
import { AppError, ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";

export const TRIAL_PLAN_ID = "c0000000-0000-4000-8000-000000000001";

/** Keyed hash of a trial-eligibility identifier; the identifier itself is never stored. */
export async function trialFingerprint(config: AppConfig, kind: string, value: string): Promise<string> {
  return hmacHex(config.sessionSecret, `trial-claim:${kind}:${value.trim().toLowerCase()}`);
}

export interface TrialIdentity {
  ownerEmail: string;
  organizationRegistration?: string | null;
  facilityRegistrations?: string[];
}

async function trialFingerprints(config: AppConfig, identity: TrialIdentity): Promise<Array<{ kind: string; fingerprint: string }>> {
  const out = [{ kind: "owner-email", fingerprint: await trialFingerprint(config, "owner-email", normalizeTrialEmail(identity.ownerEmail)) }];
  if (identity.organizationRegistration?.trim()) {
    out.push({ kind: "organization-registration", fingerprint: await trialFingerprint(config, "organization-registration", identity.organizationRegistration) });
  }
  for (const registration of identity.facilityRegistrations ?? []) {
    if (registration.trim()) out.push({ kind: "facility-registration", fingerprint: await trialFingerprint(config, "facility-registration", registration) });
  }
  return out;
}

/**
 * Creates the billing account for a new independent workspace or organization and starts its seven-day
 * trial, unless the owner, organization registration or facility registration already claimed one. No
 * onboarding fee exists. Runs inside the onboarding transaction, which must allow 'registration' or
 * 'system' billing writes; the caller's context is restored afterwards.
 */
export async function provisionBillingAccount(tx: Tx, config: AppConfig, input: {
  kind: "individual" | "independent-facility" | "organization";
  name: string;
  ownerTenantId?: string | null;
  ownerOrganizationId?: string | null;
  createdBy: string;
  identity: TrialIdentity;
  actorKind: Extract<BillingActorKind, "registration" | "system">;
  now?: Date;
}): Promise<{ billingAccountId: string; subscriptionId: string; trialEligible: boolean; trialEndsAt: Date | null }> {
  const now = input.now ?? new Date();
  const billingAccountId = crypto.randomUUID();
  await tx`
    insert into billing_accounts (id, kind, name, owner_tenant_id, owner_organization_id, created_by)
    values (${billingAccountId}, ${input.kind}, ${input.name}, ${input.ownerTenantId ?? null}, ${input.ownerOrganizationId ?? null}, ${input.createdBy})
  `;
  const fingerprints = await trialFingerprints(config, input.identity);
  const claimed = await tx`select kind from trial_claims where fingerprint = any(${fingerprints.map((entry) => entry.fingerprint)})`;
  const trialEligible = claimed.length === 0;
  for (const entry of fingerprints) {
    await tx`insert into trial_claims (fingerprint, kind, billing_account_id) values (${entry.fingerprint}, ${entry.kind}, ${billingAccountId}) on conflict (fingerprint) do nothing`;
  }
  const subscriptionId = crypto.randomUUID();
  const trial = trialEligible ? trialWindow(now) : null;
  await tx`
    insert into subscriptions (id, billing_account_id, plan_id, status, trial_started_at, trial_ends_at, trial_eligibility, status_reason)
    values (${subscriptionId}, ${billingAccountId}, ${TRIAL_PLAN_ID}, ${trialEligible ? "trialing" : "trial_expired"},
      ${trial?.start ?? null}, ${trial?.end ?? null}, ${trialEligible ? "eligible" : "already-claimed"},
      ${trialEligible ? "Seven-day free trial started at activation" : "A free trial was already used by this owner or registration"})
  `;
  await recordSubscriptionEvent(tx, {
    subscriptionId, billingAccountId, event: trialEligible ? "trial-started" : "trial-not-eligible",
    toStatus: trialEligible ? "trialing" : "trial_expired", toPlanId: TRIAL_PLAN_ID,
    detail: { claimedBy: claimed.map((row) => row.kind), trialEndsAt: trial?.end.toISOString() ?? null }, actorKind: input.actorKind, actorUserId: input.createdBy,
  });
  return { billingAccountId, subscriptionId, trialEligible, trialEndsAt: trial?.end ?? null };
}

/** Points a workspace at the account that pays for it. */
export async function attachTenantToAccount(tx: Tx, tenantId: string, billingAccountId: string): Promise<void> {
  await tx`update tenants set billing_account_id = ${billingAccountId} where id = ${tenantId}`;
}

/**
 * A workspace created by an organization is paid for by that organization's account, created on first
 * use. Runs as 'system' because the acting administrator cannot write billing state directly, so it must
 * be the last step of the caller's transaction unless a context to restore is given.
 */
export async function attachOrganizationSite(tx: Tx, config: AppConfig, input: {
  organizationId: string;
  organizationName: string;
  tenantId: string;
  actorUserId: string;
  restore?: Parameters<typeof setLocalContext>[1];
}): Promise<string> {
  await setLocalContext(tx, { actorKind: "system", tenantId: input.tenantId, userId: input.actorUserId });
  try {
    const [existing] = await tx`select id from billing_accounts where owner_organization_id = ${input.organizationId}`;
    let accountId = existing ? String(existing.id) : null;
    if (!accountId) {
      const [owner] = await tx`select u.email from organizations o join users u on u.id = o.created_by where o.id = ${input.organizationId}`;
      const created = await provisionBillingAccount(tx, config, {
        kind: "organization", name: input.organizationName, ownerOrganizationId: input.organizationId, createdBy: input.actorUserId,
        identity: { ownerEmail: String(owner?.email ?? `${input.organizationId}@organization.invalid`) }, actorKind: "system",
      });
      accountId = created.billingAccountId;
    }
    await attachTenantToAccount(tx, input.tenantId, accountId);
    return accountId;
  } finally {
    if (input.restore) await setLocalContext(tx, input.restore);
  }
}

// ---------------------------------------------------------------- access

export type BillingAccess = "operate" | "manage" | "view";

export interface BillingScope {
  billingAccountId: string;
  access: BillingAccess | null;
  accountKind: string;
  accountName: string;
}

/** The active workspace's billing account and what the signed-in user may do with it. */
export async function billingScope(c: Context<AppEnv>, tx: Tx): Promise<BillingScope> {
  const auth = requireStaff(c);
  const [row] = await tx`select billing_account_id from tenants where id = ${auth.activeTenant!.id}`;
  if (!row?.billingAccountId) throw new AppError(404, "billing_account_missing", "This workspace has no billing account yet. Contact Medveris support.");
  const [access] = await tx`select app.billing_account_access(${row.billingAccountId}) as access`;
  const [account] = await tx`select kind, name from billing_accounts where id = ${row.billingAccountId}`;
  return {
    billingAccountId: String(row.billingAccountId),
    access: (access?.access as BillingAccess | null) ?? null,
    accountKind: String(account?.kind ?? "unknown"),
    accountName: String(account?.name ?? ""),
  };
}

export function assertBillingView(scope: BillingScope): void {
  if (!scope.access) throw new ForbiddenError("Billing information is available to workspace administrators and finance staff");
}

export function assertBillingManage(scope: BillingScope): void {
  if (scope.access !== "manage" && scope.access !== "operate") {
    throw new ForbiddenError(scope.accountKind === "organization"
      ? "Only the organization's owners and administrators can change its subscription"
      : "Only the workspace owner or an administrator can change the subscription");
  }
}

/** Runs billing writes as 'system' after the route has authorized the user against the account. */
export async function withBillingSystem<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requireStaff(c);
  return withContext(c.get("deps").sql, { actorKind: "system", tenantId: auth.activeTenant!.id, userId: auth.user.id }, fn);
}

export async function currentSubscription(tx: Tx, billingAccountId: string): Promise<SubscriptionRow | null> {
  const [row] = await tx`
    select * from subscriptions where billing_account_id = ${billingAccountId} order by (status <> 'cancelled') desc, created_at desc limit 1`;
  return row ? subscriptionFromRow(row) : null;
}

export interface SubscriptionStatusSummary {
  status: SubscriptionStatus | null;
  label: string;
  accessMode: AccessMode;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
}

export function summarize(subscription: SubscriptionRow | null, now = new Date()): SubscriptionStatusSummary {
  const status = subscription?.status ?? null;
  return {
    status,
    label: status ? SUBSCRIPTION_STATUS_LABELS[status] : "No subscription",
    accessMode: accessModeFor(status),
    trialEndsAt: subscription?.status === "trialing" && subscription.trialEndsAt ? subscription.trialEndsAt.toISOString() : null,
    trialDaysRemaining: subscription?.status === "trialing" && subscription.trialEndsAt ? trialDaysRemaining(subscription.trialEndsAt, now) : null,
  };
}

/** Subscription standing of a workspace, read as 'system' so every staff member's requests can be checked. */
export async function tenantSubscriptionStatus(c: Context<AppEnv>, tenantId: string): Promise<SubscriptionStatus | null> {
  return withContext(c.get("deps").sql, { actorKind: "system", tenantId }, async (tx) => {
    const [row] = await tx`
      select s.status from tenants t join subscriptions s on s.billing_account_id = t.billing_account_id
       where t.id = ${tenantId} order by (s.status <> 'cancelled') desc, s.created_at desc limit 1`;
    return (row?.status as SubscriptionStatus | undefined) ?? null;
  });
}

// ---------------------------------------------------------------- plan changes with consent

export type PlanChange = "start" | "upgrade" | "downgrade";

export interface PlanQuote {
  change: PlanChange;
  plan: { id: string; code: string; version: number; name: string; monthlyPriceMinor: number; currency: "USD" };
  effective: "trial-end" | "now" | "period-end";
  effectiveAt: string | null;
  firstChargeMinor: number;
  prorationMinor: number;
  disclosure: string;
  disclosureDigest: string;
}

/**
 * The terms a customer is asked to accept. The digest binds the account, subscription version, plan
 * version, monthly price and timing, so stale or altered terms cannot be accepted.
 */
export async function quotePlanChange(tx: Tx, subscription: SubscriptionRow, planId: string, now = new Date()): Promise<PlanQuote> {
  const [plan] = await tx`select id, code, version, name, status, monthly_price_minor, max_monthly_charge_minor, usage_overages, contract_required from subscription_plans where id = ${planId}`;
  if (!plan) throw new ValidationError("Plan not found");
  if (plan.code === "trial") throw new ValidationError("The free trial cannot be chosen as a plan");
  if (plan.status !== "approved" || plan.monthlyPriceMinor == null) {
    throw new AppError(422, "plan_not_approved", `${plan.name} pricing has not been approved yet, so it cannot be chosen. Contact Medveris for an agreed price.`);
  }
  if (plan.contractRequired) throw new AppError(422, "plan_requires_contract", `${plan.name} needs a signed agreement with Medveris; it cannot be started here.`);
  if (["past_due", "restricted"].includes(subscription.status)) {
    throw new ConflictError("Settle the overdue invoice before changing plans");
  }
  if (subscription.status === "suspended") throw new ConflictError("This subscription is suspended; contact Medveris support");
  const price = Number(plan.monthlyPriceMinor);
  const [current] = await tx`select code, monthly_price_minor from subscription_plans where id = ${subscription.planId}`;
  const currentPrice = current?.code === "trial" ? 0 : Number(current?.monthlyPriceMinor ?? 0);
  let change: PlanChange;
  let effective: PlanQuote["effective"];
  let effectiveAt: Date | null;
  let prorationMinor = 0;
  let firstChargeMinor = price;
  if (subscription.status === "trialing") {
    change = "start"; effective = "trial-end"; effectiveAt = subscription.trialEndsAt;
  } else if (subscription.status === "trial_expired" || subscription.status === "cancelled" || current?.code === "trial") {
    change = "start"; effective = "now"; effectiveAt = null;
  } else {
    if (plan.id === subscription.planId) throw new ConflictError(`You are already on the ${plan.name} plan`);
    if (subscription.pendingPlanId === plan.id) throw new ConflictError(`${plan.name} is already scheduled`);
    if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) throw new ConflictError("This subscription has no current billing period");
    if (price > currentPrice) {
      change = "upgrade"; effective = "now"; effectiveAt = null;
      prorationMinor = prorateUpgradeMinor({ oldMonthlyMinor: currentPrice, newMonthlyMinor: price, period: { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd }, at: now });
      firstChargeMinor = prorationMinor;
    } else {
      change = "downgrade"; effective = "period-end"; effectiveAt = subscription.currentPeriodEnd; firstChargeMinor = 0;
    }
  }
  const monthly = formatMinor(price);
  const when = effective === "trial-end"
    ? `when your free trial ends on ${effectiveAt!.toISOString().slice(0, 10)}; nothing is charged during the trial`
    : effective === "period-end" ? `at the start of your next billing period on ${effectiveAt!.toISOString().slice(0, 10)}; your current plan continues until then` : "as soon as you confirm";
  const parts = [
    `You are choosing the ${plan.name} plan at ${monthly} per month, billed monthly in advance, starting ${when}.`,
    change === "upgrade" ? `For the rest of the current period you will be invoiced at most ${formatMinor(prorationMinor)}: the price difference for the unused part of the period. Later months are ${monthly}.` : null,
    plan.code === "basic" ? "Basic is a fixed monthly price with no usage charges; it is never charged per day on top of the monthly price. If your use outgrows it we will tell you and suggest another plan, but never charge more without your agreement." : null,
    plan.usageOverages ? "Measured use above the plan allowances is charged at the approved rates shown with the plan." : null,
    "You can cancel at any time; cancellation takes effect at the end of the month already paid. A payment problem never deletes patient records or clinical history. There is no onboarding fee.",
  ].filter(Boolean);
  const disclosure = parts.join(" ");
  const disclosureDigest = await sha256Hex(canonicalJson({
    accountId: subscription.billingAccountId, subscriptionId: subscription.id, subscriptionVersion: subscription.version,
    planId: plan.id, planVersion: Number(plan.version), monthlyPriceMinor: price, change, effective,
    effectiveAt: effectiveAt?.toISOString() ?? null, disclosure,
  }));
  return {
    change, effective, effectiveAt: effectiveAt?.toISOString() ?? null, firstChargeMinor, prorationMinor, disclosure, disclosureDigest,
    plan: { id: String(plan.id), code: String(plan.code), version: Number(plan.version), name: String(plan.name), monthlyPriceMinor: price, currency: "USD" },
  };
}

/** Applies an accepted quote: records the consent, then starts, schedules or upgrades the plan. */
export async function acceptPlanChange(tx: Tx, subscription: SubscriptionRow, quote: PlanQuote, input: { userId: string; now?: Date }): Promise<{ invoice: { id: string; number: string; totalMinor: number } | null; subscriptionId: string }> {
  const now = input.now ?? new Date();
  let target = subscription;
  if (subscription.status === "cancelled") {
    const id = crypto.randomUUID();
    await tx`
      insert into subscriptions (id, billing_account_id, plan_id, status, trial_eligibility, status_reason)
      values (${id}, ${subscription.billingAccountId}, ${TRIAL_PLAN_ID}, 'trial_expired', 'already-claimed', 'Resubscribing after cancellation')`;
    await recordSubscriptionEvent(tx, { subscriptionId: id, billingAccountId: subscription.billingAccountId, event: "resubscribed", toStatus: "trial_expired", actorKind: "staff", actorUserId: input.userId });
    target = (await lockSubscription(tx, id))!;
  }
  const consentId = crypto.randomUUID();
  const effectiveAt = quote.effective === "now" ? now : new Date(quote.effectiveAt!);
  await tx`
    insert into subscription_consents (id, billing_account_id, subscription_id, plan_id, change, monthly_price_minor, proration_minor, currency, effective_at,
      disclosure, disclosure_digest, accepted_by)
    values (${consentId}, ${target.billingAccountId}, ${target.id}, ${quote.plan.id}, ${quote.change}, ${quote.plan.monthlyPriceMinor}, ${quote.prorationMinor}, 'USD',
      ${effectiveAt}, ${quote.disclosure}, ${quote.disclosureDigest}, ${input.userId})
  `;
  await recordSubscriptionEvent(tx, {
    subscriptionId: target.id, billingAccountId: target.billingAccountId, event: "consent-recorded", fromPlanId: target.planId, toPlanId: quote.plan.id,
    detail: { consentId, change: quote.change, monthlyPriceMinor: quote.plan.monthlyPriceMinor, effective: quote.effective }, actorKind: "staff", actorUserId: input.userId,
  });
  if (quote.effective === "trial-end" || quote.effective === "period-end") {
    await tx`
      update subscriptions set pending_plan_id = ${quote.plan.id}, pending_consent_id = ${consentId}, cancel_at_period_end = false, version = version + 1, updated_at = now()
       where id = ${target.id}`;
    await recordSubscriptionEvent(tx, {
      subscriptionId: target.id, billingAccountId: target.billingAccountId, event: "plan-scheduled", fromPlanId: target.planId, toPlanId: quote.plan.id,
      detail: { effectiveAt: quote.effectiveAt }, actorKind: "staff", actorUserId: input.userId,
    });
    return { invoice: null, subscriptionId: target.id };
  }
  if (quote.change === "start") {
    const started = await startPaidPeriod(tx, target, { planId: quote.plan.id, consentId, periodStart: now, actorKind: "staff", actorUserId: input.userId, reason: "Plan chosen by the account administrator" });
    return { invoice: { id: started.invoiceId, number: started.number, totalMinor: started.totalMinor }, subscriptionId: target.id };
  }
  const period = { start: target.currentPeriodStart!, end: target.currentPeriodEnd! };
  const [old] = await tx`select code, monthly_price_minor from subscription_plans where id = ${target.planId}`;
  const prorationMinor = prorateUpgradeMinor({ oldMonthlyMinor: Number(old?.monthlyPriceMinor ?? 0), newMonthlyMinor: quote.plan.monthlyPriceMinor, period, at: now });
  if (prorationMinor > quote.prorationMinor) throw new ConflictError("The quoted amount has changed; review the terms again");
  await tx`
    update subscriptions set plan_id = ${quote.plan.id}, consent_id = ${consentId}, pending_plan_id = null, pending_consent_id = null, version = version + 1, updated_at = now()
     where id = ${target.id}`;
  await recordSubscriptionEvent(tx, {
    subscriptionId: target.id, billingAccountId: target.billingAccountId, event: "upgraded", fromPlanId: target.planId, toPlanId: quote.plan.id,
    detail: { prorationMinor, consentId }, actorKind: "staff", actorUserId: input.userId,
  });
  if (prorationMinor <= 0) return { invoice: null, subscriptionId: target.id };
  const prorationPeriod = { start: now, end: period.end };
  const invoice = await issueSubscriptionInvoice(tx, {
    subscription: { ...target, planId: quote.plan.id }, kind: "proration", period: prorationPeriod, issuedAt: now,
    lines: [{
      kind: "proration", description: `Upgrade to ${quote.plan.name} for the rest of the period to ${period.end.toISOString().slice(0, 10)}`,
      planId: quote.plan.id, quantity: 1, unitAmountMinor: prorationMinor, amountMinor: prorationMinor, period: prorationPeriod,
    }],
  });
  return { invoice: { id: invoice.id, number: invoice.number, totalMinor: invoice.totalMinor }, subscriptionId: target.id };
}

/**
 * Cancellation: a trial or an unpaid start ends now and its unpaid invoice is voided; a paid month runs
 * to its end. Patient records are untouched either way.
 */
export async function cancelSubscription(tx: Tx, subscription: SubscriptionRow, input: { userId: string; reason: string; actorKind: BillingActorKind }): Promise<{ effective: "now" | "period-end"; at: string | null }> {
  if (subscription.status === "cancelled") throw new ConflictError("This subscription is already cancelled");
  if (subscription.status === "active" && subscription.currentPeriodEnd) {
    await tx`
      update subscriptions set cancel_at_period_end = true, cancellation_reason = ${input.reason}, pending_plan_id = null, pending_consent_id = null,
        version = version + 1, updated_at = now() where id = ${subscription.id}`;
    await recordSubscriptionEvent(tx, {
      subscriptionId: subscription.id, billingAccountId: subscription.billingAccountId, event: "cancellation-scheduled",
      detail: { reason: input.reason, effectiveAt: subscription.currentPeriodEnd.toISOString() }, actorKind: input.actorKind, actorUserId: input.userId,
    });
    return { effective: "period-end", at: subscription.currentPeriodEnd.toISOString() };
  }
  if (subscription.status === "pending_payment") {
    await tx`
      update subscription_invoices set status = 'void', void_reason = 'Subscription cancelled before the first payment'
       where subscription_id = ${subscription.id} and status = 'open'`;
  }
  await tx`update subscriptions set cancellation_reason = ${input.reason}, pending_plan_id = null, pending_consent_id = null where id = ${subscription.id}`;
  await setSubscriptionStatus(tx, subscription, "cancelled", { reason: input.reason, actorKind: input.actorKind, actorUserId: input.userId });
  return { effective: "now", at: new Date().toISOString() };
}

export async function resumeSubscription(tx: Tx, subscription: SubscriptionRow, userId: string): Promise<void> {
  if (!subscription.cancelAtPeriodEnd) throw new ConflictError("No cancellation is scheduled");
  await tx`update subscriptions set cancel_at_period_end = false, cancellation_reason = null, version = version + 1, updated_at = now() where id = ${subscription.id}`;
  await recordSubscriptionEvent(tx, { subscriptionId: subscription.id, billingAccountId: subscription.billingAccountId, event: "cancellation-withdrawn", actorKind: "staff", actorUserId: userId });
}

export { monthlyPeriod, setSubscriptionStatus };
