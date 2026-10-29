import { Hono, type Context } from "hono";
import {
  planAcceptSchema,
  planApproveSchema,
  planDraftSchema,
  planQuoteSchema,
  subscriptionCancelSchema,
  subscriptionPaymentSchema,
  subscriptionRefundSchema,
  subscriptionStatusActionSchema,
  usageCorrectionSchema,
  uuidSchema,
} from "@medveris/contracts";
import type { Tx } from "@medveris/db";
import {
  accessModeFor,
  estimatePlan,
  parseMajorToMinor,
  RESTRICTED_CAPABILITIES,
  trialWindow,
  type SubscriptionStatus,
} from "@medveris/domain";
import { isPlatformOperator, requireAuth, requireStaff, withPlatformActor, withStaffActor } from "../auth/middleware.js";
import { requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { parseJson } from "../lib/http.js";
import { idempotencyKey, uniqueViolation } from "../lib/idempotency.js";
import {
  loadPlans,
  lockSubscription,
  notifyAccount,
  periodUsage,
  recordSubscriptionEvent,
  setSubscriptionStatus,
  settleInvoice,
  usagePeriodStart,
} from "../../../jobs/src/billing.js";
import {
  acceptPlanChange,
  assertBillingManage,
  assertBillingView,
  billingScope,
  cancelSubscription,
  currentSubscription,
  quotePlanChange,
  resumeSubscription,
  summarize,
  tenantSubscriptionStatus,
  withBillingSystem,
} from "../services/subscriptions.js";
import { receiptNumber } from "../services/billing.js";
import type { AppEnv } from "../types.js";

export const billingRoutes = new Hono<AppEnv>();

function planView(plan: Record<string, unknown>) {
  return {
    id: plan.id, code: plan.code, version: Number(plan.version), name: plan.name, description: plan.description, status: plan.status,
    currency: plan.currency, monthlyPriceMinor: plan.monthlyPriceMinor == null ? null : Number(plan.monthlyPriceMinor),
    dailyReferenceMinor: plan.dailyReferenceMinor == null ? null : Number(plan.dailyReferenceMinor),
    maxMonthlyChargeMinor: plan.maxMonthlyChargeMinor == null ? null : Number(plan.maxMonthlyChargeMinor),
    usageOverages: Boolean(plan.usageOverages), features: plan.features, contractRequired: Boolean(plan.contractRequired),
    effectiveFrom: plan.effectiveFrom, approvedAt: plan.approvedAt,
  };
}

async function plansWithRules(tx: Tx) {
  const plans = await tx`select * from subscription_plans where status <> 'retired' order by code, version`;
  const rules = await tx`
    select r.plan_id, r.resource, r.treatment, r.included_quantity, r.limit_quantity, r.unit_rate_minor, r.rate_unit_quantity, u.name, u.unit
      from plan_resource_rules r join usage_resources u on u.code = r.resource`;
  return plans.map((plan) => ({
    ...planView(plan),
    rules: rules.filter((rule) => rule.planId === plan.id).map((rule) => ({
      resource: rule.resource, name: rule.name, unit: rule.unit, treatment: rule.treatment,
      includedQuantity: rule.includedQuantity == null ? null : Number(rule.includedQuantity),
      limitQuantity: rule.limitQuantity == null ? null : Number(rule.limitQuantity),
      unitRateMinor: rule.unitRateMinor == null ? null : Number(rule.unitRateMinor),
      rateUnitQuantity: Number(rule.rateUnitQuantity),
    })),
  }));
}

/** Subscription standing for the active workspace. Every staff member sees whether features are paused; billing detail needs billing access. */
billingRoutes.get("/billing/status", async (c) => {
  const auth = requireStaff(c);
  const config = c.get("deps").config;
  const { scope, subscription } = await withStaffActor(c, async (tx) => {
    const found = await billingScope(c, tx).catch(() => null);
    return { scope: found, subscription: found?.access ? await currentSubscription(tx, found.billingAccountId) : null };
  });
  const status = subscription?.status ?? await tenantSubscriptionStatus(c, auth.activeTenant!.id);
  const summary = subscription ? summarize(subscription) : { ...summarize(null), status, accessMode: accessModeFor(status) };
  return c.json({
    enforcement: config.billing.enforcement,
    accessMode: config.billing.enforcement === "enforce" ? summary.accessMode : "full",
    restrictedCapabilities: config.billing.enforcement === "enforce" && summary.accessMode === "restricted" ? RESTRICTED_CAPABILITIES : [],
    billing: scope?.access ? { ...summary, accountKind: scope.accountKind, canManage: scope.access === "manage" || scope.access === "operate" } : { status: summary.status, label: summary.label, canManage: false },
  });
});

/** Everything an account administrator needs: plan, trial, period, measured use, estimate, recommendation, invoices and notices. */
billingRoutes.get("/billing/overview", async (c) => {
  requireStaff(c);
  const data = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingView(scope);
    const subscription = await currentSubscription(tx, scope.billingAccountId);
    if (!subscription) throw new NotFoundError("This account has no subscription");
    const [plan] = await tx`select * from subscription_plans where id = ${subscription.planId}`;
    const [pendingPlan] = subscription.pendingPlanId ? await tx`select id, name, monthly_price_minor from subscription_plans where id = ${subscription.pendingPlanId}` : [];
    const periodStart = usagePeriodStart(subscription, new Date());
    const usage = await periodUsage(tx, scope.billingAccountId, periodStart);
    const byWorkspace = await tx`
      select t.id, t.name, e.resource, sum(coalesce(e.corrected_quantity, e.quantity)) as quantity
        from usage_events e join tenants t on t.id = e.tenant_id
       where e.billing_account_id = ${scope.billingAccountId} and e.bucket_start >= ${periodStart} and e.source = 'api-request'
       group by t.id, t.name, e.resource order by t.name`;
    const unassigned = await tx`
      select count(*)::int as events from usage_events where billing_account_id = ${scope.billingAccountId} and validation_status <> 'valid'`;
    const plans = await plansWithRules(tx);
    const estimatePlans = await loadPlans(tx, { includeDrafts: true });
    const currentEstimate = estimatePlans.find((candidate) => candidate.id === subscription.planId);
    const [recommendation] = await tx`
      select r.*, p.name as recommended_name from tier_recommendations r left join subscription_plans p on p.id = r.recommended_plan_id
       where r.billing_account_id = ${scope.billingAccountId} order by r.evaluated_on desc limit 1`;
    const invoices = await tx`
      select id, number, kind, period_start, period_end, total_minor, status, issued_at, due_at, paid_at
        from subscription_invoices where billing_account_id = ${scope.billingAccountId} order by issued_at desc limit 24`;
    const notifications = await tx`
      select id, kind, title, body, created_at, read_at from billing_notifications
       where billing_account_id = ${scope.billingAccountId} order by created_at desc limit 20`;
    const events = await tx`
      select e.event, e.from_status, e.to_status, e.detail, e.occurred_at, e.actor_kind, u.display_name as actor_name
        from subscription_events e left join users u on u.id = e.actor_user_id
       where e.billing_account_id = ${scope.billingAccountId} order by e.occurred_at desc limit 20`;
    const workspaces = await tx`select id, name from tenants where billing_account_id = ${scope.billingAccountId} order by name`;
    return { scope, subscription, plan, pendingPlan, periodStart, usage, byWorkspace, unassigned: Number(unassigned[0]?.events ?? 0), plans, currentEstimate, recommendation, invoices, notifications, events, workspaces };
  });
  const summary = summarize(data.subscription);
  const estimate = data.currentEstimate ? estimatePlan(data.currentEstimate, data.usage) : null;
  const resourceRules = data.plans.find((plan) => plan.id === data.subscription.planId)?.rules ?? [];
  return c.json({
    account: { id: data.scope.billingAccountId, kind: data.scope.accountKind, name: data.scope.accountName, canManage: data.scope.access === "manage" || data.scope.access === "operate", workspaces: data.workspaces },
    subscription: {
      ...summary, id: data.subscription.id, version: data.subscription.version,
      plan: planView(data.plan!),
      trialStartedAt: data.subscription.trialStartedAt, trialEndsAt: data.subscription.trialEndsAt,
      currentPeriodStart: data.subscription.currentPeriodStart, currentPeriodEnd: data.subscription.currentPeriodEnd,
      cancelAtPeriodEnd: data.subscription.cancelAtPeriodEnd,
      pendingPlan: data.pendingPlan ? { id: data.pendingPlan.id, name: data.pendingPlan.name, monthlyPriceMinor: Number(data.pendingPlan.monthlyPriceMinor) } : null,
    },
    enforcement: c.get("deps").config.billing.enforcement,
    usage: {
      periodStart: data.periodStart,
      resources: resourceRules.map((rule) => ({ ...rule, quantity: data.usage[String(rule.resource)] ?? 0 })),
      byWorkspace: data.byWorkspace.map((row) => ({ tenantId: row.id, name: row.name, resource: row.resource, quantity: Number(row.quantity) })),
      unverifiedEvents: data.unassigned,
      // Trial use is measured for estimates only and never becomes a charge.
      projectedChargeMinor: data.subscription.status === "trialing" ? 0 : estimate?.totalMinor ?? null,
      estimate,
    },
    recommendation: data.recommendation ? {
      id: data.recommendation.id, evaluatedOn: data.recommendation.evaluatedOn, status: data.recommendation.status, measuredDays: data.recommendation.measuredDays,
      recommendedPlanId: data.recommendation.recommendedPlanId, recommendedName: data.recommendation.recommendedName,
      estimatedMonthlyMinor: data.recommendation.estimatedMonthlyMinor == null ? null : Number(data.recommendation.estimatedMonthlyMinor),
      projectedUsage: data.recommendation.projectedUsage, explanation: data.recommendation.explanation,
    } : null,
    plans: data.plans,
    invoices: data.invoices.map((row) => ({ ...row, totalMinor: Number(row.totalMinor) })),
    notifications: data.notifications,
    events: data.events,
  });
});

billingRoutes.get("/billing/plans", async (c) => {
  requireAuth(c);
  return c.json({ plans: await withStaffActor(c, plansWithRules) });
});

/** The exact terms of a plan change, for the administrator to read before accepting. Changes nothing. */
billingRoutes.post("/billing/subscription/quote", async (c) => {
  requireStaff(c);
  const body = await parseJson(c, planQuoteSchema);
  const quote = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingManage(scope);
    const subscription = await currentSubscription(tx, scope.billingAccountId);
    if (!subscription) throw new NotFoundError("This account has no subscription");
    return quotePlanChange(tx, subscription, body.planId);
  });
  return c.json({ quote });
});

/**
 * Accepts a quoted plan change. The digest must match freshly computed terms, so a price, plan version
 * or subscription change since the quote requires a new quote. A higher price never starts without this.
 */
billingRoutes.post("/billing/subscription/accept", async (c) => {
  const auth = requireStaff(c);
  const body = await parseJson(c, planAcceptSchema);
  const scope = await withStaffActor(c, async (tx) => {
    const found = await billingScope(c, tx);
    assertBillingManage(found);
    return found;
  });
  const result = await withBillingSystem(c, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`billing-account:${scope.billingAccountId}`}))`;
    const current = await currentSubscription(tx, scope.billingAccountId);
    if (!current) throw new NotFoundError("This account has no subscription");
    const subscription = await lockSubscription(tx, current.id);
    const quote = await quotePlanChange(tx, subscription!, body.planId);
    if (quote.disclosureDigest !== body.disclosureDigest) {
      throw new AppError(409, "terms_changed", "The terms changed since you reviewed them. Review the new terms and accept again.", { quote });
    }
    const accepted = await acceptPlanChange(tx, subscription!, quote, { userId: auth.user.id });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.plan.accept", {
      resourceType: "Subscription", resourceId: accepted.subscriptionId,
      metadata: { billingAccountId: scope.billingAccountId, planId: quote.plan.id, planVersion: quote.plan.version, monthlyPriceMinor: quote.plan.monthlyPriceMinor, change: quote.change, effective: quote.effective, invoice: accepted.invoice?.number ?? null },
    }));
    return { quote, invoice: accepted.invoice };
  });
  return c.json({ ok: true, ...result }, 201);
});

billingRoutes.post("/billing/subscription/cancel", async (c) => {
  const auth = requireStaff(c);
  const body = await parseJson(c, subscriptionCancelSchema);
  const scope = await withStaffActor(c, async (tx) => {
    const found = await billingScope(c, tx);
    assertBillingManage(found);
    return found;
  });
  const result = await withBillingSystem(c, async (tx) => {
    const current = await currentSubscription(tx, scope.billingAccountId);
    if (!current) throw new NotFoundError("This account has no subscription");
    const subscription = await lockSubscription(tx, current.id);
    const outcome = await cancelSubscription(tx, subscription!, { userId: auth.user.id, reason: body.reason, actorKind: "staff" });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.cancel", { resourceType: "Subscription", resourceId: current.id, metadata: { ...outcome, reason: body.reason } }));
    return outcome;
  });
  return c.json({ ok: true, cancellation: result });
});

billingRoutes.post("/billing/subscription/resume", async (c) => {
  const auth = requireStaff(c);
  const scope = await withStaffActor(c, async (tx) => {
    const found = await billingScope(c, tx);
    assertBillingManage(found);
    return found;
  });
  await withBillingSystem(c, async (tx) => {
    const current = await currentSubscription(tx, scope.billingAccountId);
    if (!current) throw new NotFoundError("This account has no subscription");
    await resumeSubscription(tx, (await lockSubscription(tx, current.id))!, auth.user.id);
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.resume", { resourceType: "Subscription", resourceId: current.id }));
  });
  return c.json({ ok: true });
});

billingRoutes.post("/billing/notifications/:id/read", async (c) => {
  const auth = requireStaff(c);
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingView(scope);
    const rows = await tx`
      update billing_notifications set read_at = coalesce(read_at, now()), read_by = coalesce(read_by, ${auth.user.id})
       where id = ${id} and billing_account_id = ${scope.billingAccountId} returning id`;
    if (!rows.length) throw new NotFoundError("Notification not found");
  });
  return c.json({ ok: true });
});

billingRoutes.get("/billing/invoices/:id", async (c) => {
  requireStaff(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withStaffActor(c, async (tx) => {
    const scope = await billingScope(c, tx);
    assertBillingView(scope);
    const invoice = await requireRows(await tx`
      select * from subscription_invoices where id = ${id} and billing_account_id = ${scope.billingAccountId}`, "Invoice not found");
    const lines = await tx`select kind, description, quantity, unit_amount_minor, amount_minor, period_start, period_end from subscription_invoice_lines where invoice_id = ${id} order by period_start`;
    const payments = await tx`
      select id, amount_minor, method, status, provider_reference, failure_reason, receipt_number, recorded_at, refunded_minor, refunded_at, refund_reason
        from subscription_payments where invoice_id = ${id} order by recorded_at`;
    return { invoice, lines, payments, accountName: scope.accountName };
  });
  return c.json(data);
});

// ---------------------------------------------------------------- platform operators

function requireOperator(c: Context<AppEnv>): void {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
}

billingRoutes.get("/platform/billing/accounts", async (c) => {
  requireOperator(c);
  const status = c.req.query("status");
  const rows = await withPlatformActor(c, async (tx) => tx`
    select a.id, a.kind, a.name, a.created_at, s.id as subscription_id, s.status, s.trial_ends_at, s.current_period_end, p.name as plan_name,
           (select count(*)::int from tenants t where t.billing_account_id = a.id) as workspaces,
           (select coalesce(sum(i.total_minor), 0) from subscription_invoices i where i.billing_account_id = a.id and i.status = 'open') as open_minor
      from billing_accounts a
      left join lateral (select * from subscriptions s where s.billing_account_id = a.id order by (s.status <> 'cancelled') desc, s.created_at desc limit 1) s on true
      left join subscription_plans p on p.id = s.plan_id
     ${status ? tx`where s.status = ${status}` : tx``}
     order by a.created_at desc limit 200`);
  return c.json({ accounts: rows.map((row) => ({ ...row, openMinor: Number(row.openMinor) })) });
});

billingRoutes.get("/platform/billing/accounts/:id/invoices", async (c) => {
  requireOperator(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const invoices = await withPlatformActor(c, async (tx) => tx`
    select i.id, i.number, i.kind, i.period_start, i.period_end, i.total_minor, i.status, i.due_at, i.payment_attempts,
           coalesce((select sum(p.amount_minor - p.refunded_minor) from subscription_payments p where p.invoice_id = i.id and p.status = 'succeeded'), 0) as paid_minor
      from subscription_invoices i where i.billing_account_id = ${id} order by i.issued_at desc`);
  return c.json({ invoices: invoices.map((row) => ({ ...row, totalMinor: Number(row.totalMinor), paidMinor: Number(row.paidMinor) })) });
});

billingRoutes.get("/platform/billing/invoices/:id", async (c) => {
  requireOperator(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const data = await withPlatformActor(c, async (tx) => {
    const invoice = await requireRows(await tx`select * from subscription_invoices where id = ${id}`, "Invoice not found");
    const lines = await tx`select kind, description, quantity, unit_amount_minor, amount_minor, period_start, period_end from subscription_invoice_lines where invoice_id = ${id} order by period_start`;
    const payments = await tx`
      select id, amount_minor, currency, method, status, provider_reference, failure_reason, receipt_number, recorded_at, refunded_minor, refunded_at, refund_reason
        from subscription_payments where invoice_id = ${id} order by recorded_at`;
    const [account] = await tx`select name from billing_accounts where id = ${invoice.billingAccountId}`;
    return { invoice, lines, payments, accountName: account?.name ?? "" };
  });
  return c.json(data);
});

/**
 * Records a subscription payment received outside Medveris (bank transfer, card terminal) or a failed
 * attempt. Idempotent per Idempotency-Key. A succeeded payment covering the invoice restores good standing.
 */
billingRoutes.post("/platform/billing/invoices/:id/payments", async (c) => {
  requireOperator(c);
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, subscriptionPaymentSchema);
  const key = idempotencyKey(c);
  if (!key) throw new ValidationError("An Idempotency-Key header is required so a retried request does not record a payment twice");
  const amountMinor = parseMajorToMinor(body.amount);
  if (amountMinor <= 0) throw new ValidationError("The amount must be more than zero");
  try {
    const result = await withPlatformActor(c, async (tx) => {
      const [existing] = await tx`select id, invoice_id from subscription_payments where idempotency_key = ${key}`;
      if (existing) {
        if (existing.invoiceId !== id) throw new ConflictError("This Idempotency-Key was already used for another invoice");
        return { paymentId: String(existing.id), replayed: true, settlement: null };
      }
      const invoice = await requireRows(await tx`select * from subscription_invoices where id = ${id} for update`, "Invoice not found");
      if (invoice.status === "void") throw new ConflictError("This invoice is void");
      const [paid] = await tx`select coalesce(sum(amount_minor - refunded_minor), 0) as paid from subscription_payments where invoice_id = ${id} and status = 'succeeded'`;
      const balance = Number(invoice.totalMinor) - Number(paid!.paid);
      if (body.status === "succeeded" && amountMinor > balance) throw new ValidationError(`The balance due is ${balance} cents`);
      const paymentId = crypto.randomUUID();
      await tx`
        insert into subscription_payments (id, invoice_id, billing_account_id, amount_minor, currency, method, status, provider_reference, failure_reason,
          receipt_number, idempotency_key, recorded_by)
        values (${paymentId}, ${id}, ${invoice.billingAccountId}, ${amountMinor}, 'USD', ${body.method}, ${body.status}, ${body.reference},
          ${body.failureReason ?? null}, ${body.status === "succeeded" ? receiptNumber() : null}, ${key}, ${auth.user.id})`;
      await tx`update subscription_invoices set payment_attempts = payment_attempts + 1, last_attempt_at = now() where id = ${id}`;
      if (body.status === "failed") {
        await notifyAccount(tx, {
          billingAccountId: String(invoice.billingAccountId), kind: "payment-failed", title: `Payment for invoice ${invoice.number} failed`,
          body: `${body.failureReason}. Nothing has been deleted; you can pay again before the due date.`, dedupeKey: `payment-failed:${paymentId}`,
        });
      } else {
        await notifyAccount(tx, {
          billingAccountId: String(invoice.billingAccountId), kind: "payment-received", title: `Payment received for invoice ${invoice.number}`,
          body: `Thank you. Receipt issued.`, dedupeKey: `payment-received:${paymentId}`,
        });
      }
      const settlement = await settleInvoice(tx, id, { actorKind: "platform", actorUserId: auth.user.id });
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.payment.record", {
        resourceType: "SubscriptionPayment", resourceId: paymentId,
        metadata: { invoiceId: id, amountMinor, method: body.method, status: body.status, invoiceStatus: settlement.status },
      }));
      return { paymentId, replayed: false, settlement };
    });
    return c.json({ ok: true, ...result }, result.replayed ? 200 : 201);
  } catch (error) {
    if (uniqueViolation(error) === "subscription_payments_idempotency_key_key") throw new ConflictError("This payment was just recorded; reload to see it");
    throw error;
  }
});

billingRoutes.post("/platform/billing/payments/:id/refund", async (c) => {
  requireOperator(c);
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, subscriptionRefundSchema);
  const amountMinor = parseMajorToMinor(body.amount);
  const result = await withPlatformActor(c, async (tx) => {
    const payment = await requireRows(await tx`select * from subscription_payments where id = ${id} for update`, "Payment not found");
    if (payment.status !== "succeeded") throw new ConflictError("Only a succeeded payment can be refunded");
    const refundable = Number(payment.amountMinor) - Number(payment.refundedMinor);
    if (amountMinor <= 0 || amountMinor > refundable) throw new ValidationError(`Up to ${refundable} cents can be refunded`);
    await tx`
      update subscription_payments set refunded_minor = refunded_minor + ${amountMinor}, refunded_at = now(), refunded_by = ${auth.user.id}, refund_reason = ${body.reason}
       where id = ${id}`;
    const settlement = await settleInvoice(tx, String(payment.invoiceId), { actorKind: "platform", actorUserId: auth.user.id });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.payment.refund", {
      resourceType: "SubscriptionPayment", resourceId: id, metadata: { amountMinor, reason: body.reason, invoiceStatus: settlement.status },
    }));
    return settlement;
  });
  return c.json({ ok: true, invoice: result });
});

/** Suspension, reinstatement and an operator-granted trial for a fair eligibility review. Never touches patient data. */
billingRoutes.post("/platform/billing/subscriptions/:id/status", async (c) => {
  requireOperator(c);
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, subscriptionStatusActionSchema);
  const status = await withPlatformActor(c, async (tx) => {
    const subscription = await lockSubscription(tx, id);
    if (!subscription) throw new NotFoundError("Subscription not found");
    if (body.action === "suspend") {
      if (subscription.status === "cancelled") throw new ConflictError("A cancelled subscription cannot be suspended");
      await setSubscriptionStatus(tx, subscription, "suspended", { reason: body.reason, actorKind: "platform", actorUserId: auth.user.id });
    } else if (body.action === "reinstate") {
      if (subscription.status !== "suspended") throw new ConflictError("Only a suspended subscription can be reinstated");
      const [open] = await tx`select count(*)::int as overdue from subscription_invoices where subscription_id = ${id} and status = 'open' and due_at <= now()`;
      const [plan] = await tx`select code from subscription_plans where id = ${subscription.planId}`;
      const next: SubscriptionStatus = plan?.code === "trial"
        ? (subscription.trialEndsAt && subscription.trialEndsAt > new Date() ? "trialing" : "trial_expired")
        : Number(open?.overdue ?? 0) ? "restricted" : "active";
      await setSubscriptionStatus(tx, subscription, next, { reason: body.reason, actorKind: "platform", actorUserId: auth.user.id });
    } else {
      if (subscription.status !== "trial_expired" || subscription.trialStartedAt) {
        throw new ConflictError("A trial can only be granted to an account that never had one");
      }
      const window = trialWindow(new Date());
      await tx`
        update subscriptions set status = 'trialing', trial_started_at = ${window.start}, trial_ends_at = ${window.end}, trial_eligibility = 'operator-granted',
          status_reason = ${body.reason}, status_changed_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
      await recordSubscriptionEvent(tx, {
        subscriptionId: id, billingAccountId: subscription.billingAccountId, event: "trial-granted", fromStatus: subscription.status, toStatus: "trialing",
        detail: { reason: body.reason, trialEndsAt: window.end.toISOString() }, actorKind: "platform", actorUserId: auth.user.id,
      });
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, `subscription.${body.action}`, { resourceType: "Subscription", resourceId: id, metadata: { reason: body.reason } }));
    const [after] = await tx`select status from subscriptions where id = ${id}`;
    return String(after!.status);
  });
  return c.json({ ok: true, status });
});

/** Corrects a usage measurement; the original and every previous value stay in the correction history. */
billingRoutes.post("/platform/billing/usage/:id/correct", async (c) => {
  requireOperator(c);
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, usageCorrectionSchema);
  await withPlatformActor(c, async (tx) => {
    const event = await requireRows(await tx`select * from usage_events where id = ${id} for update`, "Usage event not found");
    await tx`
      insert into usage_event_corrections (id, usage_event_id, billing_account_id, original_quantity, previous_quantity, corrected_quantity, reason, corrected_by)
      values (${crypto.randomUUID()}, ${id}, ${event.billingAccountId}, ${event.quantity}, ${event.correctedQuantity ?? event.quantity}, ${body.correctedQuantity}, ${body.reason}, ${auth.user.id})`;
    await tx`update usage_events set corrected_quantity = ${body.correctedQuantity}, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "usage.correct", {
      resourceType: "UsageEvent", resourceId: id, metadata: { from: Number(event.correctedQuantity ?? event.quantity), to: body.correctedQuantity, reason: body.reason },
    }));
  });
  return c.json({ ok: true });
});

billingRoutes.get("/platform/billing/plans", async (c) => {
  requireOperator(c);
  return c.json({ plans: await withPlatformActor(c, async (tx) => {
    const all = await tx`select * from subscription_plans order by code, version`;
    return all.map(planView);
  }) });
});

/** Drafts a new plan version. Prices only take effect once a separate approval is recorded. */
billingRoutes.post("/platform/billing/plans", async (c) => {
  requireOperator(c);
  const auth = requireAuth(c);
  const body = await parseJson(c, planDraftSchema);
  const monthly = parseMajorToMinor(body.monthlyPrice);
  const cap = body.maxMonthlyCharge ? parseMajorToMinor(body.maxMonthlyCharge) : null;
  const id = crypto.randomUUID();
  try {
    await withPlatformActor(c, async (tx) => {
      const [latest] = await tx`select coalesce(max(version), 0) as version from subscription_plans where code = ${body.code}`;
      await tx`
        insert into subscription_plans (id, code, version, name, description, status, monthly_price_minor, daily_reference_minor, max_monthly_charge_minor,
          usage_overages, features, contract_required, created_by)
        values (${id}, ${body.code}, ${Number(latest!.version) + 1}, ${body.name}, ${body.description}, 'draft', ${monthly}, null, ${cap},
          ${body.usageOverages}, ${body.features}, ${body.contractRequired}, ${auth.user.id})`;
      for (const rule of body.rules) {
        await tx`
          insert into plan_resource_rules (plan_id, resource, treatment, included_quantity, limit_quantity, unit_rate_minor, rate_unit_quantity)
          values (${id}, ${rule.resource}, ${rule.treatment}, ${rule.includedQuantity}, ${rule.limitQuantity}, ${rule.unitRateMinor}, ${rule.rateUnitQuantity})`;
      }
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.plan.draft", { resourceType: "SubscriptionPlan", resourceId: id, metadata: { code: body.code, monthly, cap, usageOverages: body.usageOverages } }));
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/check constraint|plan_rule_billable_without_overages/.test(message)) throw new ValidationError(`The plan breaks a pricing rule: ${message}`);
    throw error;
  }
  return c.json({ ok: true, plan: { id } }, 201);
});

/** Approves a drafted plan version; the previously approved version of that plan is retired. Existing subscriptions keep their consented version until they accept the new one. */
billingRoutes.post("/platform/billing/plans/:id/approve", async (c) => {
  requireOperator(c);
  const auth = requireAuth(c);
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, planApproveSchema);
  await withPlatformActor(c, async (tx) => {
    const plan = await requireRows(await tx`select * from subscription_plans where id = ${id} for update`, "Plan not found");
    if (plan.status !== "draft") throw new ConflictError("Only a draft plan can be approved");
    if (plan.monthlyPriceMinor == null) throw new ValidationError("Set a monthly price before approving");
    await tx`update subscription_plans set status = 'retired' where code = ${plan.code} and status = 'approved'`;
    await tx`
      update subscription_plans set status = 'approved', approved_by = ${auth.user.id}, approved_at = now(), approval_reference = ${body.approvalReference},
        effective_from = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "subscription.plan.approve", {
      resourceType: "SubscriptionPlan", resourceId: id, metadata: { code: plan.code, version: Number(plan.version), monthlyPriceMinor: Number(plan.monthlyPriceMinor), approvalReference: body.approvalReference },
    }));
  });
  return c.json({ ok: true });
});
