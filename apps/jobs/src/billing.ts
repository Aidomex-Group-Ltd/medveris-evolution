import type { Sql, Tx } from "@medveris/db";
import {
  DAY_MS,
  INVOICE_DUE_DAYS,
  PAST_DUE_GRACE_DAYS,
  TIER_EVALUATION_WINDOW_DAYS,
  TIER_MINIMUM_MEASURED_DAYS,
  crossedThresholds,
  formatMinor,
  monthlyPeriod,
  projectMonthlyUsage,
  recommendPlan,
  trialDaysRemaining,
  type BillingPeriod,
  type PlanCode,
  type PlanForEstimate,
  type SubscriptionStatus,
} from "@medveris/domain";

/**
 * Subscription lifecycle shared by the API (consent, payments) and the scheduled billing cycle (trial
 * expiry, renewals, overdue invoices, usage snapshots, thresholds and tier estimates). Every function
 * takes the caller's transaction; row-level security admits the API as 'system' and the jobs role.
 */

export type BillingActorKind = "staff" | "system" | "platform" | "registration" | "jobs";

export interface SubscriptionRow {
  id: string;
  billingAccountId: string;
  planId: string;
  status: SubscriptionStatus;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  pendingPlanId: string | null;
  pendingConsentId: string | null;
  consentId: string | null;
  cancelAtPeriodEnd: boolean;
  version: number;
}

export function subscriptionFromRow(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(row.id),
    billingAccountId: String(row.billingAccountId),
    planId: String(row.planId),
    status: row.status as SubscriptionStatus,
    trialStartedAt: (row.trialStartedAt as Date | null) ?? null,
    trialEndsAt: (row.trialEndsAt as Date | null) ?? null,
    currentPeriodStart: (row.currentPeriodStart as Date | null) ?? null,
    currentPeriodEnd: (row.currentPeriodEnd as Date | null) ?? null,
    pendingPlanId: (row.pendingPlanId as string | null) ?? null,
    pendingConsentId: (row.pendingConsentId as string | null) ?? null,
    consentId: (row.consentId as string | null) ?? null,
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
    version: Number(row.version),
  };
}

export async function lockSubscription(tx: Tx, id: string): Promise<SubscriptionRow | null> {
  const [row] = await tx`select * from subscriptions where id = ${id} for update`;
  return row ? subscriptionFromRow(row) : null;
}

/** Every plan version that is not retired, with its resource rules, in the shape the estimator uses. */
export async function loadPlans(tx: Tx, options: { includeDrafts?: boolean } = {}): Promise<PlanForEstimate[]> {
  const plans = await tx`
    select id, code, version, name, status, monthly_price_minor, max_monthly_charge_minor, usage_overages, features
      from subscription_plans where status = 'approved' ${options.includeDrafts ? tx`or status = 'draft'` : tx``}
     order by code, version`;
  const rules = await tx`select plan_id, resource, treatment, included_quantity, limit_quantity, unit_rate_minor, rate_unit_quantity from plan_resource_rules`;
  return plans.map((plan) => ({
    id: String(plan.id),
    code: plan.code as PlanCode,
    version: Number(plan.version),
    name: String(plan.name),
    status: plan.status as PlanForEstimate["status"],
    monthlyPriceMinor: plan.monthlyPriceMinor == null ? null : Number(plan.monthlyPriceMinor),
    maxMonthlyChargeMinor: plan.maxMonthlyChargeMinor == null ? null : Number(plan.maxMonthlyChargeMinor),
    usageOverages: Boolean(plan.usageOverages),
    features: (plan.features as string[]) ?? [],
    rules: rules.filter((rule) => rule.planId === plan.id).map((rule) => ({
      resource: String(rule.resource),
      treatment: rule.treatment as "included" | "excluded" | "billable",
      includedQuantity: rule.includedQuantity == null ? null : Number(rule.includedQuantity),
      limitQuantity: rule.limitQuantity == null ? null : Number(rule.limitQuantity),
      unitRateMinor: rule.unitRateMinor == null ? null : Number(rule.unitRateMinor),
      rateUnitQuantity: Number(rule.rateUnitQuantity),
    })),
  }));
}

export async function recordSubscriptionEvent(tx: Tx, input: {
  subscriptionId: string;
  billingAccountId: string;
  event: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  fromPlanId?: string | null;
  toPlanId?: string | null;
  detail?: Record<string, unknown>;
  actorUserId?: string | null;
  actorKind: BillingActorKind;
}): Promise<void> {
  await tx`
    insert into subscription_events (subscription_id, billing_account_id, event, from_status, to_status, from_plan_id, to_plan_id, detail, actor_user_id, actor_kind)
    values (${input.subscriptionId}, ${input.billingAccountId}, ${input.event}, ${input.fromStatus ?? null}, ${input.toStatus ?? null},
      ${input.fromPlanId ?? null}, ${input.toPlanId ?? null}, ${tx.json((input.detail ?? {}) as never)}, ${input.actorUserId ?? null}, ${input.actorKind})
  `;
}

/** In-app notification for an account's administrators; each dedupe key is delivered once. */
export async function notifyAccount(tx: Tx, input: { billingAccountId: string; kind: string; title: string; body: string; dedupeKey: string }): Promise<boolean> {
  const [row] = await tx`
    select app.record_billing_notification(${input.billingAccountId}, ${input.kind}, ${input.title}, ${input.body}, ${input.dedupeKey}) as id
  `;
  return Boolean(row?.id);
}

export async function setSubscriptionStatus(tx: Tx, subscription: SubscriptionRow, to: SubscriptionStatus, input: {
  reason: string;
  actorKind: BillingActorKind;
  actorUserId?: string | null;
  at?: Date;
  extra?: Record<string, unknown>;
}): Promise<void> {
  if (subscription.status === to) return;
  await tx`
    update subscriptions set status = ${to}, status_reason = ${input.reason}, status_changed_at = ${input.at ?? new Date()},
      cancelled_at = ${to === "cancelled" ? input.at ?? new Date() : null}, version = version + 1, updated_at = now()
     where id = ${subscription.id}
  `;
  await recordSubscriptionEvent(tx, {
    subscriptionId: subscription.id, billingAccountId: subscription.billingAccountId, event: "status-changed",
    fromStatus: subscription.status, toStatus: to, detail: { reason: input.reason, ...input.extra }, actorKind: input.actorKind, actorUserId: input.actorUserId,
  });
  subscription.status = to;
}

export function subscriptionInvoiceNumber(now = new Date()): string {
  return `SUB-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export interface InvoiceLineInput {
  kind: "plan" | "proration" | "usage" | "credit";
  description: string;
  planId: string | null;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
  period: BillingPeriod;
}

/**
 * Issues one invoice per subscription, kind and period start. A second attempt for the same period
 * returns the existing invoice instead of charging again.
 */
export async function issueSubscriptionInvoice(tx: Tx, input: {
  subscription: SubscriptionRow;
  kind: "period" | "proration";
  period: BillingPeriod;
  lines: InvoiceLineInput[];
  issuedAt: Date;
}): Promise<{ id: string; number: string; totalMinor: number; created: boolean }> {
  const totalMinor = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new Error("Invoice total must be a non-negative whole number of cents");
  const id = crypto.randomUUID();
  const number = subscriptionInvoiceNumber(input.issuedAt);
  const dueAt = new Date(input.issuedAt.getTime() + INVOICE_DUE_DAYS * DAY_MS);
  const inserted = await tx`
    insert into subscription_invoices (id, billing_account_id, subscription_id, number, kind, period_start, period_end, currency, total_minor, issued_at, due_at)
    values (${id}, ${input.subscription.billingAccountId}, ${input.subscription.id}, ${number}, ${input.kind}, ${input.period.start}, ${input.period.end},
      'USD', ${totalMinor}, ${input.issuedAt}, ${dueAt})
    on conflict (subscription_id, kind, period_start) where status <> 'void' do nothing
    returning id
  `;
  if (!inserted.length) {
    const [existing] = await tx`
      select id, number, total_minor from subscription_invoices
       where subscription_id = ${input.subscription.id} and kind = ${input.kind} and period_start = ${input.period.start} and status <> 'void'`;
    return { id: String(existing!.id), number: String(existing!.number), totalMinor: Number(existing!.totalMinor), created: false };
  }
  for (const line of input.lines) {
    await tx`
      insert into subscription_invoice_lines (invoice_id, kind, description, plan_id, quantity, unit_amount_minor, amount_minor, period_start, period_end)
      values (${id}, ${line.kind}, ${line.description}, ${line.planId}, ${line.quantity}, ${line.unitAmountMinor}, ${line.amountMinor}, ${line.period.start}, ${line.period.end})
    `;
  }
  await notifyAccount(tx, {
    billingAccountId: input.subscription.billingAccountId, kind: "invoice-issued",
    title: `Invoice ${number} issued`,
    body: `${formatMinor(totalMinor)} for ${input.period.start.toISOString().slice(0, 10)} to ${input.period.end.toISOString().slice(0, 10)}, due ${dueAt.toISOString().slice(0, 10)}.`,
    dedupeKey: `invoice-issued:${id}`,
  });
  return { id, number, totalMinor, created: true };
}

/** The plan line for one monthly period: the plan's monthly price once, whatever the month's length. */
export async function planPeriodLine(tx: Tx, planId: string, period: BillingPeriod): Promise<InvoiceLineInput> {
  const [plan] = await tx`select name, monthly_price_minor from subscription_plans where id = ${planId}`;
  const price = Number(plan!.monthlyPriceMinor);
  return {
    kind: "plan", description: `${plan!.name} plan, ${period.start.toISOString().slice(0, 10)} to ${period.end.toISOString().slice(0, 10)}`,
    planId, quantity: 1, unitAmountMinor: price, amountMinor: price, period,
  };
}

/** Starts the consented paid plan for a new monthly period and invoices that period. */
export async function startPaidPeriod(tx: Tx, subscription: SubscriptionRow, input: {
  planId: string;
  consentId: string;
  periodStart: Date;
  actorKind: BillingActorKind;
  actorUserId?: string | null;
  reason: string;
}): Promise<{ invoiceId: string; number: string; totalMinor: number }> {
  const period = monthlyPeriod(input.periodStart);
  const fromPlan = subscription.planId;
  const fromStatus = subscription.status;
  await tx`
    update subscriptions set plan_id = ${input.planId}, consent_id = ${input.consentId}, pending_plan_id = null, pending_consent_id = null,
      status = 'pending_payment', status_reason = ${input.reason}, status_changed_at = now(), current_period_start = ${period.start},
      current_period_end = ${period.end}, cancel_at_period_end = false, version = version + 1, updated_at = now()
     where id = ${subscription.id}
  `;
  await recordSubscriptionEvent(tx, {
    subscriptionId: subscription.id, billingAccountId: subscription.billingAccountId, event: "plan-started",
    fromStatus, toStatus: "pending_payment", fromPlanId: fromPlan, toPlanId: input.planId,
    detail: { reason: input.reason, consentId: input.consentId, periodStart: period.start.toISOString(), periodEnd: period.end.toISOString() },
    actorKind: input.actorKind, actorUserId: input.actorUserId,
  });
  Object.assign(subscription, { planId: input.planId, consentId: input.consentId, pendingPlanId: null, pendingConsentId: null, status: "pending_payment", currentPeriodStart: period.start, currentPeriodEnd: period.end });
  const invoice = await issueSubscriptionInvoice(tx, { subscription, kind: "period", period, lines: [await planPeriodLine(tx, input.planId, period)], issuedAt: new Date(Math.max(Date.now(), input.periodStart.getTime())) });
  return { invoiceId: invoice.id, number: invoice.number, totalMinor: invoice.totalMinor };
}

/** Marks an invoice paid when unrefunded successful payments cover it, and restores good standing. */
export async function settleInvoice(tx: Tx, invoiceId: string, input: { actorKind: BillingActorKind; actorUserId?: string | null }): Promise<{ status: string; paidMinor: number; totalMinor: number }> {
  const [invoice] = await tx`select id, subscription_id, total_minor, status from subscription_invoices where id = ${invoiceId} for update`;
  if (!invoice) throw new Error("subscription invoice not found");
  const [paid] = await tx`
    select coalesce(sum(amount_minor - refunded_minor), 0) as paid from subscription_payments where invoice_id = ${invoiceId} and status = 'succeeded'`;
  const paidMinor = Number(paid!.paid);
  const totalMinor = Number(invoice.totalMinor);
  let status = String(invoice.status);
  if (status !== "void") {
    const next = paidMinor >= totalMinor ? "paid" : "open";
    if (next !== status) {
      await tx`update subscription_invoices set status = ${next}, paid_at = ${next === "paid" ? new Date() : null} where id = ${invoiceId}`;
      status = next;
    }
  }
  if (status === "paid") {
    const subscription = await lockSubscription(tx, String(invoice.subscriptionId));
    if (subscription && ["pending_payment", "past_due", "restricted"].includes(subscription.status)) {
      const [outstanding] = await tx`
        select count(*)::int as open from subscription_invoices where subscription_id = ${subscription.id} and status = 'open' and due_at <= now()`;
      if (!Number(outstanding!.open)) {
        await setSubscriptionStatus(tx, subscription, "active", { reason: "Invoice paid", actorKind: input.actorKind, actorUserId: input.actorUserId });
      }
    }
  }
  return { status, paidMinor, totalMinor };
}

// ---------------------------------------------------------------- scheduled cycle

export interface BillingCycleResult {
  trialsExpired: number;
  trialsConverted: number;
  remindersSent: number;
  renewals: number;
  cancellations: number;
  pastDue: number;
  restricted: number;
  snapshots: number;
  thresholdNotices: number;
  evaluations: number;
}

export interface BillingCycleOptions {
  now?: Date;
  /** Limits the cycle to these accounts (tests and targeted replays). */
  accountIds?: string[] | null;
}

const ACTIVE_FOR_USAGE: SubscriptionStatus[] = ["trialing", "pending_payment", "active", "past_due", "restricted", "trial_expired"];

/**
 * One pass of the billing lifecycle. Idempotent: notifications, invoices, snapshots and evaluations are
 * keyed so a repeated or overlapping run changes nothing twice. Each subscription is handled in its own
 * transaction under an advisory lock.
 */
export async function runBillingCycle(sql: Sql, options: BillingCycleOptions = {}): Promise<BillingCycleResult> {
  const now = options.now ?? new Date();
  const scope = options.accountIds ?? null;
  const result: BillingCycleResult = { trialsExpired: 0, trialsConverted: 0, remindersSent: 0, renewals: 0, cancellations: 0, pastDue: 0, restricted: 0, snapshots: 0, thresholdNotices: 0, evaluations: 0 };
  const subscriptions = await sql`
    select id from subscriptions where status <> 'cancelled' ${scope ? sql`and billing_account_id = any(${scope}::uuid[])` : sql``} order by id`;
  for (const { id } of subscriptions) {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`billing:${id}`}))`;
      const subscription = await lockSubscription(tx, String(id));
      if (!subscription) return;
      await lifecycleStep(tx, subscription, now, result);
    });
  }
  result.snapshots = await snapshotUsage(sql, now, scope);
  const accounts = await sql`
    select s.id from subscriptions s where s.status = any(${ACTIVE_FOR_USAGE}::text[]) ${scope ? sql`and s.billing_account_id = any(${scope}::uuid[])` : sql``}`;
  for (const { id } of accounts) {
    await sql.begin(async (tx) => {
      const subscription = await lockSubscription(tx, String(id));
      if (!subscription) return;
      result.thresholdNotices += await usageThresholds(tx, subscription, now);
      if (await evaluateTier(tx, subscription, now)) result.evaluations += 1;
    });
  }
  return result;
}

async function lifecycleStep(tx: Tx, subscription: SubscriptionRow, now: Date, result: BillingCycleResult): Promise<void> {
  if (subscription.status === "trialing" && subscription.trialEndsAt) {
    const endsAt = subscription.trialEndsAt;
    if (now >= endsAt) {
      if (subscription.pendingPlanId && subscription.pendingConsentId) {
        await startPaidPeriod(tx, subscription, { planId: subscription.pendingPlanId, consentId: subscription.pendingConsentId, periodStart: endsAt, actorKind: "jobs", reason: "Trial ended; the plan you chose has started" });
        result.trialsConverted += 1;
      } else {
        await setSubscriptionStatus(tx, subscription, "trial_expired", { reason: "Trial ended without a chosen plan", actorKind: "jobs", at: now });
        await notifyAccount(tx, {
          billingAccountId: subscription.billingAccountId, kind: "trial-expired", title: "Your free trial has ended",
          body: "No paid plan was started. Patient records and care workflows stay available; choose a plan to keep using every feature.",
          dedupeKey: `trial-expired:${subscription.id}`,
        });
        result.trialsExpired += 1;
      }
      return;
    }
    const remaining = trialDaysRemaining(endsAt, now);
    const due = remaining <= 1 ? 1 : remaining <= 3 ? 3 : null;
    if (due) {
      const sent = await notifyAccount(tx, {
        billingAccountId: subscription.billingAccountId, kind: "trial-reminder",
        title: due === 1 ? "Your free trial ends within a day" : "Your free trial ends in 3 days",
        body: `The trial ends on ${endsAt.toISOString().slice(0, 16).replace("T", " ")} UTC. ${subscription.pendingPlanId ? "Your chosen plan starts then." : "Nothing will be charged unless you choose a plan."}`,
        dedupeKey: `trial-reminder:${due}:${subscription.id}`,
      });
      if (sent) result.remindersSent += 1;
    }
    return;
  }

  if (subscription.status === "active" && subscription.currentPeriodEnd && now >= subscription.currentPeriodEnd) {
    const periodEnd = subscription.currentPeriodEnd;
    if (subscription.cancelAtPeriodEnd) {
      await setSubscriptionStatus(tx, subscription, "cancelled", { reason: "Cancelled at the end of the paid period", actorKind: "jobs", at: periodEnd });
      result.cancellations += 1;
      return;
    }
    const planId = subscription.pendingPlanId ?? subscription.planId;
    const consentId = subscription.pendingConsentId ?? subscription.consentId;
    const period = monthlyPeriod(periodEnd);
    await tx`
      update subscriptions set plan_id = ${planId}, consent_id = ${consentId}, pending_plan_id = null, pending_consent_id = null,
        current_period_start = ${period.start}, current_period_end = ${period.end}, version = version + 1, updated_at = now()
       where id = ${subscription.id}`;
    await recordSubscriptionEvent(tx, {
      subscriptionId: subscription.id, billingAccountId: subscription.billingAccountId, event: "renewed",
      fromStatus: "active", toStatus: "active", fromPlanId: subscription.planId, toPlanId: planId,
      detail: { periodStart: period.start.toISOString(), periodEnd: period.end.toISOString() }, actorKind: "jobs",
    });
    Object.assign(subscription, { planId, consentId, pendingPlanId: null, pendingConsentId: null, currentPeriodStart: period.start, currentPeriodEnd: period.end });
    await issueSubscriptionInvoice(tx, { subscription, kind: "period", period, lines: [await planPeriodLine(tx, planId, period)], issuedAt: period.start });
    result.renewals += 1;
  }

  if (["active", "pending_payment", "past_due"].includes(subscription.status)) {
    const overdue = await tx`
      select id, number, total_minor, due_at from subscription_invoices
       where subscription_id = ${subscription.id} and status = 'open' and due_at <= ${now} order by due_at`;
    if (!overdue.length) return;
    const oldest = overdue[0]!;
    const daysOverdue = Math.floor((now.getTime() - (oldest.dueAt as Date).getTime()) / DAY_MS);
    if (subscription.status !== "past_due") {
      await setSubscriptionStatus(tx, subscription, "past_due", { reason: `Invoice ${oldest.number} is overdue`, actorKind: "jobs", at: now });
      result.pastDue += 1;
    }
    for (const step of [0, 3, 7]) {
      if (daysOverdue >= step) {
        await notifyAccount(tx, {
          billingAccountId: subscription.billingAccountId, kind: "payment-overdue", title: `Invoice ${oldest.number} is overdue`,
          body: `${formatMinor(Number(oldest.totalMinor))} was due on ${(oldest.dueAt as Date).toISOString().slice(0, 10)}. Features other than patient care pause ${PAST_DUE_GRACE_DAYS} days after the due date if it stays unpaid.`,
          dedupeKey: `overdue:${oldest.id}:${step}`,
        });
      }
    }
    if (daysOverdue >= PAST_DUE_GRACE_DAYS) {
      await setSubscriptionStatus(tx, subscription, "restricted", { reason: `Invoice ${oldest.number} unpaid ${PAST_DUE_GRACE_DAYS} days after its due date`, actorKind: "jobs", at: now });
      await notifyAccount(tx, {
        billingAccountId: subscription.billingAccountId, kind: "restricted", title: "Account restricted",
        body: "Staff invitations, new sites, reports and integrations are paused until the overdue invoice is paid. Patient records, clinical history and care workflows are not affected and nothing is deleted.",
        dedupeKey: `restricted:${oldest.id}`,
      });
      result.restricted += 1;
    }
  }
}

/** Daily gauge readings per workspace: stored file bytes and active staff accounts. */
async function snapshotUsage(sql: Sql, now: Date, scope: string[] | null): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const inserted = await sql`
    with readings as (
      select t.id as tenant_id, t.billing_account_id, 'storage.file_bytes'::text as resource, 'byte'::text as unit,
             coalesce((select sum(u.size_bytes) from uploads u where u.tenant_id = t.id), 0)::numeric as quantity, 'storage-snapshot'::text as source
        from tenants t where t.status = 'active' ${scope ? sql`and t.billing_account_id = any(${scope}::uuid[])` : sql``}
      union all
      select t.id, t.billing_account_id, 'users.active', 'user',
             (select count(*) from memberships m where m.tenant_id = t.id and m.status = 'active')::numeric, 'user-snapshot'
        from tenants t where t.status = 'active' ${scope ? sql`and t.billing_account_id = any(${scope}::uuid[])` : sql``}
    )
    insert into usage_events (billing_account_id, tenant_id, resource, quantity, unit, bucket_start, period_start, plan_id, rule_version, source,
      dedupe_key, validation_status, billing_status)
    select r.billing_account_id, r.tenant_id, r.resource, r.quantity, r.unit, ${day}::date,
           coalesce(case when s.status = 'trialing' then s.trial_started_at end, s.current_period_start, s.trial_started_at, date_trunc('month', ${now}::timestamptz)),
           s.plan_id, coalesce(p.code || ':' || p.version, 'none'), r.source,
           'snap:' || r.tenant_id || ':' || r.resource || ':' || ${day},
           case when r.billing_account_id is null then 'unassigned' else 'valid' end,
           app.usage_billing_status(s.status, s.plan_id, r.resource)
      from readings r
      left join subscriptions s on s.billing_account_id = r.billing_account_id and s.status <> 'cancelled'
      left join subscription_plans p on p.id = s.plan_id
    on conflict (dedupe_key) do nothing
    returning id`;
  return inserted.length;
}

/** Usage in the current period per resource, using corrected values where an operator corrected them. */
export async function periodUsage(tx: Tx, billingAccountId: string, periodStart: Date): Promise<Record<string, number>> {
  const rows = await tx`
    select e.resource, r.aggregation,
           case when r.aggregation = 'max' then max(coalesce(e.corrected_quantity, e.quantity)) else sum(coalesce(e.corrected_quantity, e.quantity)) end as quantity
      from usage_events e join usage_resources r on r.code = e.resource
     where e.billing_account_id = ${billingAccountId} and e.validation_status = 'valid' and e.bucket_start >= ${periodStart}
     group by e.resource, r.aggregation`;
  return Object.fromEntries(rows.map((row) => [String(row.resource), Number(row.quantity)]));
}

export function usagePeriodStart(subscription: SubscriptionRow, now: Date): Date {
  if (subscription.status === "trialing" && subscription.trialStartedAt) return subscription.trialStartedAt;
  return subscription.currentPeriodStart ?? subscription.trialStartedAt ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function usageThresholds(tx: Tx, subscription: SubscriptionRow, now: Date): Promise<number> {
  const periodStart = usagePeriodStart(subscription, now);
  const usage = await periodUsage(tx, subscription.billingAccountId, periodStart);
  const rules = await tx`
    select r.resource, coalesce(r.included_quantity, r.limit_quantity) as allowance, u.name, u.unit
      from plan_resource_rules r join usage_resources u on u.code = r.resource where r.plan_id = ${subscription.planId}`;
  let sent = 0;
  for (const rule of rules) {
    const allowance = rule.allowance == null ? null : Number(rule.allowance);
    const quantity = usage[String(rule.resource)] ?? 0;
    for (const threshold of crossedThresholds(quantity, allowance)) {
      const percent = Math.round(threshold * 100);
      const created = await notifyAccount(tx, {
        billingAccountId: subscription.billingAccountId, kind: "usage-threshold",
        title: `${rule.name}: ${percent}% of your plan allowance used`,
        body: `${Math.round(quantity)} of ${allowance} ${rule.unit}s this period. ${percent >= 100 ? "Nothing extra is charged without your agreement; review the recommended plan." : "You will be told again at 100%."}`,
        dedupeKey: `usage:${subscription.billingAccountId}:${rule.resource}:${periodStart.toISOString()}:${percent}`,
      });
      if (created) sent += 1;
    }
  }
  return sent;
}

/**
 * Daily tier estimate over the evaluation window. It never changes the plan: a different plan is only
 * proposed, with the measurements, allowances, estimated charge, limits and effective date, for the
 * account administrator to accept or ignore.
 */
async function evaluateTier(tx: Tx, subscription: SubscriptionRow, now: Date): Promise<boolean> {
  const evaluatedOn = now.toISOString().slice(0, 10);
  const [already] = await tx`select 1 from tier_recommendations where billing_account_id = ${subscription.billingAccountId} and evaluated_on = ${evaluatedOn}`;
  if (already) return false;
  const windowStart = new Date(now.getTime() - TIER_EVALUATION_WINDOW_DAYS * DAY_MS);
  const daily = await tx`
    select e.resource, r.aggregation, date_trunc('day', e.bucket_start) as day,
           case when r.aggregation = 'max' then max(coalesce(e.corrected_quantity, e.quantity)) else sum(coalesce(e.corrected_quantity, e.quantity)) end as quantity
      from usage_events e join usage_resources r on r.code = e.resource
     where e.billing_account_id = ${subscription.billingAccountId} and e.validation_status = 'valid' and e.bucket_start >= ${windowStart} and e.bucket_start < ${now}
     group by e.resource, r.aggregation, date_trunc('day', e.bucket_start)`;
  const byResource = new Map<string, { aggregation: "sum" | "max"; values: number[] }>();
  const days = new Set<string>();
  for (const row of daily) {
    days.add(new Date(row.day as Date).toISOString().slice(0, 10));
    const entry = byResource.get(String(row.resource)) ?? { aggregation: row.aggregation as "sum" | "max", values: [] };
    entry.values.push(Number(row.quantity));
    byResource.set(String(row.resource), entry);
  }
  const projected = Object.fromEntries([...byResource].map(([resource, entry]) => [resource, projectMonthlyUsage(entry.values, entry.aggregation)]));
  const plans = await loadPlans(tx, { includeDrafts: true });
  const { recommended, estimates } = recommendPlan(plans, projected);
  const [current] = await tx`select code, name from subscription_plans where id = ${subscription.planId}`;
  const measuredDays = days.size;
  const effective = subscription.status === "active" && subscription.currentPeriodEnd ? subscription.currentPeriodEnd : now;
  const changes = recommended && recommended.planId !== subscription.planId && measuredDays >= TIER_MINIMUM_MEASURED_DAYS && current?.code !== "trial";
  const explanation = !recommended
    ? `Measured use over ${measuredDays} day(s) does not fit any plan with approved pricing. Contact Medveris; nothing changes and nothing extra is charged.`
    : `Based on ${measuredDays} measured day(s) in the last ${TIER_EVALUATION_WINDOW_DAYS} days (the highest days are ignored to avoid short spikes), `
      + `${recommended.name} is the least expensive eligible plan at an estimated ${formatMinor(recommended.totalMinor)} per month`
      + `${changes ? `, effective ${effective.toISOString().slice(0, 10)} if you accept it` : ""}. Your plan only changes if you accept.`;
  await tx`
    insert into tier_recommendations (billing_account_id, evaluated_on, window_start, window_end, measured_days, current_plan_id, recommended_plan_id,
      estimated_monthly_minor, projected_usage, estimates, explanation, status)
    values (${subscription.billingAccountId}, ${evaluatedOn}, ${windowStart}, ${now}, ${measuredDays}, ${subscription.planId}, ${recommended?.planId ?? null},
      ${recommended?.totalMinor ?? null}, ${tx.json(projected as never)}, ${tx.json(estimates as never)}, ${explanation}, ${changes ? "proposed" : "informational"})
    on conflict (billing_account_id, evaluated_on) do nothing`;
  if (changes) {
    await tx`update tier_recommendations set status = 'superseded' where billing_account_id = ${subscription.billingAccountId} and status = 'proposed' and evaluated_on < ${evaluatedOn}`;
    await notifyAccount(tx, {
      billingAccountId: subscription.billingAccountId, kind: "tier-recommendation", title: `${recommended!.name} plan recommended`,
      body: explanation, dedupeKey: `tier:${subscription.billingAccountId}:${recommended!.planId}:${evaluatedOn.slice(0, 7)}`,
    });
  }
  return true;
}
