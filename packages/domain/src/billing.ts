import { DomainError } from "./errors.js";
import { currencyMinorDigits, fitsCurrencyPrecision } from "./currency.js";

/**
 * Platform subscription billing: Medveris charges a billing account (an independent workspace or an
 * organization) for its subscription. All amounts are integer minor units (US cents) so no floating
 * point arithmetic touches money; rates per unit may be fractional cents and are rounded once per line.
 */

export const SUBSCRIPTION_CURRENCY = "USD";
export const TRIAL_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Basic is a fixed monthly price with a hard monthly maximum; the daily figure is a reference only. */
export const BASIC_MONTHLY_PRICE_MINOR = 1500;
export const BASIC_DAILY_REFERENCE_MINOR = 50;

export const PLAN_CODES = ["trial", "basic", "standard", "advanced", "enterprise"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
export const PLAN_ORDER: Record<PlanCode, number> = { trial: 0, basic: 1, standard: 2, advanced: 3, enterprise: 4 };

export const SUBSCRIPTION_STATUSES = [
  "trialing", "trial_expired", "pending_payment", "active", "past_due", "restricted", "cancelled", "suspended",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Free trial",
  trial_expired: "Trial ended",
  pending_payment: "Awaiting first payment",
  active: "Active",
  past_due: "Payment overdue",
  restricted: "Restricted",
  cancelled: "Cancelled",
  suspended: "Suspended",
};

const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  trialing: ["trial_expired", "pending_payment", "active", "cancelled", "suspended"],
  trial_expired: ["pending_payment", "active", "trialing", "restricted", "cancelled", "suspended"],
  pending_payment: ["active", "past_due", "cancelled", "suspended"],
  active: ["past_due", "cancelled", "suspended", "active"],
  past_due: ["active", "restricted", "cancelled", "suspended"],
  restricted: ["active", "pending_payment", "cancelled", "suspended"],
  cancelled: [],
  suspended: ["active", "restricted", "cancelled", "trial_expired", "trialing"],
};

export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export function assertSubscriptionTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransitionSubscription(from, to)) throw new DomainError(`A subscription cannot move from ${from} to ${to}`);
}

/**
 * What the platform restricts while a subscription is not in good standing. Patient records, clinical
 * history, active care workflows, point-of-sale collection and data export are never restricted; only
 * growth and analytics features pause until the account is brought up to date.
 */
export const RESTRICTED_CAPABILITIES = ["staff-invitations", "new-sites", "reports", "integrations"] as const;
export type RestrictedCapability = (typeof RESTRICTED_CAPABILITIES)[number];

export type AccessMode = "full" | "restricted";

export function accessModeFor(status: SubscriptionStatus | null): AccessMode {
  return status === "trial_expired" || status === "restricted" || status === "suspended" || status === "cancelled" ? "restricted" : "full";
}

/** Days after an unpaid invoice falls due before the account moves from past_due to restricted. */
export const PAST_DUE_GRACE_DAYS = 14;
/** Days to pay an issued subscription invoice. */
export const INVOICE_DUE_DAYS = 7;

// ---------------------------------------------------------------- money

export function assertMinorUnits(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) throw new DomainError(`${label} must be a whole number of minor units`);
}

/** "15.00" style display for USD minor units. */
export function formatMinor(minor: number, currency = SUBSCRIPTION_CURRENCY): string {
  assertMinorUnits(minor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Parses a decimal string such as "15", "15.5" or "15.50" into minor units without floating point. */
export function parseMajorToMinor(value: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new DomainError("Enter an amount such as 15 or 15.50");
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Half-up rounding of a non-negative fractional minor amount. */
export function roundMinor(value: number): number {
  if (!Number.isFinite(value)) throw new DomainError("Amount is not a finite number");
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

// ---------------------------------------------------------------- periods and proration

/** Adds calendar months, clamping to the last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(at: Date, months: number): Date {
  const result = new Date(at.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

/** Monthly billing period starting at `start`. A month is one charge however many days it has. */
export function monthlyPeriod(start: Date): BillingPeriod {
  return { start, end: addMonths(start, 1) };
}

export function trialWindow(activatedAt: Date): BillingPeriod {
  return { start: activatedAt, end: new Date(activatedAt.getTime() + TRIAL_DAYS * DAY_MS) };
}

export function trialDaysRemaining(trialEndsAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS));
}

/**
 * Upgrade within a period: the difference between the new and old monthly prices for the unused share
 * of the period, never negative. Downgrades and cancellations take effect at the end of the paid period
 * and earn no credit, so they need no proration line.
 */
export function prorateUpgradeMinor(input: { oldMonthlyMinor: number; newMonthlyMinor: number; period: BillingPeriod; at: Date }): number {
  assertMinorUnits(input.oldMonthlyMinor, "old price");
  assertMinorUnits(input.newMonthlyMinor, "new price");
  const total = input.period.end.getTime() - input.period.start.getTime();
  if (total <= 0) throw new DomainError("The billing period is empty");
  const remaining = Math.min(total, Math.max(0, input.period.end.getTime() - input.at.getTime()));
  const difference = input.newMonthlyMinor - input.oldMonthlyMinor;
  if (difference <= 0) return 0;
  return Math.min(difference, roundMinor((difference * remaining) / total));
}

// ---------------------------------------------------------------- usage and tier estimation

export const USAGE_TREATMENTS = ["included", "excluded", "billable"] as const;
export type UsageTreatment = (typeof USAGE_TREATMENTS)[number];

export interface PlanResourceRule {
  resource: string;
  treatment: UsageTreatment;
  /** Allowance per billing period; null means no allowance has been approved. */
  includedQuantity: number | null;
  /** Largest supported quantity per period; null means no limit has been approved. */
  limitQuantity: number | null;
  /** Price in minor units per `rateUnitQuantity`; null means no rate has been approved. */
  unitRateMinor: number | null;
  rateUnitQuantity: number;
}

export interface PlanForEstimate {
  id: string;
  code: PlanCode;
  version: number;
  name: string;
  status: "draft" | "approved" | "retired";
  monthlyPriceMinor: number | null;
  maxMonthlyChargeMinor: number | null;
  usageOverages: boolean;
  features: readonly string[];
  rules: readonly PlanResourceRule[];
}

export interface EstimateLine {
  resource: string;
  quantity: number;
  includedQuantity: number | null;
  limitQuantity: number | null;
  billableQuantity: number;
  costMinor: number;
  treatment: UsageTreatment | "not-configured";
}

export interface PlanEstimate {
  planId: string;
  code: PlanCode;
  name: string;
  eligible: boolean;
  reasons: string[];
  baseMinor: number;
  usageMinor: number;
  totalMinor: number;
  lines: EstimateLine[];
}

/**
 * Resource cost = billable quantity × unit rate; estimated usage cost = sum of resource costs. Included
 * resources and allowances cost nothing; a plan without usage overages never charges for usage; a
 * monthly maximum caps the total. A plan is ineligible when unapproved, unpriced, missing a required
 * feature, or when measured use exceeds one of its approved limits.
 */
export function estimatePlan(plan: PlanForEstimate, usage: Readonly<Record<string, number>>, requiredFeatures: readonly string[] = []): PlanEstimate {
  const reasons: string[] = [];
  if (plan.status !== "approved") reasons.push("pricing for this plan has not been approved");
  if (plan.monthlyPriceMinor == null) reasons.push("no approved monthly price");
  for (const feature of requiredFeatures) if (!plan.features.includes(feature)) reasons.push(`does not include ${feature}`);
  const lines: EstimateLine[] = [];
  let usageMinor = 0;
  for (const [resource, rawQuantity] of Object.entries(usage)) {
    const quantity = Math.max(0, rawQuantity);
    const rule = plan.rules.find((candidate) => candidate.resource === resource);
    if (!rule) {
      lines.push({ resource, quantity, includedQuantity: null, limitQuantity: null, billableQuantity: 0, costMinor: 0, treatment: "not-configured" });
      continue;
    }
    if (rule.limitQuantity != null && quantity > rule.limitQuantity) reasons.push(`${resource} use exceeds the plan limit`);
    let billableQuantity = 0;
    let costMinor = 0;
    if (rule.treatment === "billable" && plan.usageOverages) {
      billableQuantity = Math.max(0, quantity - (rule.includedQuantity ?? 0));
      if (rule.unitRateMinor == null) {
        if (billableQuantity > 0) reasons.push(`${resource} has no approved rate`);
      } else {
        costMinor = roundMinor((billableQuantity / rule.rateUnitQuantity) * rule.unitRateMinor);
      }
    }
    usageMinor += costMinor;
    lines.push({ resource, quantity, includedQuantity: rule.includedQuantity, limitQuantity: rule.limitQuantity, billableQuantity, costMinor, treatment: rule.treatment });
  }
  const baseMinor = plan.monthlyPriceMinor ?? 0;
  let totalMinor = baseMinor + usageMinor;
  if (plan.maxMonthlyChargeMinor != null) totalMinor = Math.min(totalMinor, plan.maxMonthlyChargeMinor);
  return { planId: plan.id, code: plan.code, name: plan.name, eligible: reasons.length === 0, reasons, baseMinor, usageMinor: totalMinor - baseMinor, totalMinor, lines };
}

/** The least expensive eligible paid plan; ties go to the lower tier. Trial is never recommended. */
export function recommendPlan(plans: readonly PlanForEstimate[], usage: Readonly<Record<string, number>>, requiredFeatures: readonly string[] = []): { recommended: PlanEstimate | null; estimates: PlanEstimate[] } {
  const estimates = plans.filter((plan) => plan.code !== "trial").map((plan) => estimatePlan(plan, usage, requiredFeatures));
  const eligible = estimates.filter((estimate) => estimate.eligible)
    .sort((a, b) => a.totalMinor - b.totalMinor || PLAN_ORDER[a.code] - PLAN_ORDER[b.code]);
  return { recommended: eligible[0] ?? null, estimates };
}

/** Evaluation window for tier recommendations, in days. */
export const TIER_EVALUATION_WINDOW_DAYS = 30;
/** Fewer measured days than this gives an estimate but no recommendation to change plan. */
export const TIER_MINIMUM_MEASURED_DAYS = 7;

/**
 * Projects a 30-day quantity from daily measurements while ignoring short spikes: the highest 10% of
 * days (at least one once a week of data exists) are dropped before averaging. Gauge resources such as
 * storage use the median daily value instead of a sum.
 */
export function projectMonthlyUsage(daily: readonly number[], aggregation: "sum" | "max"): number {
  const values = daily.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!values.length) return 0;
  if (aggregation === "max") {
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  }
  const drop = values.length >= TIER_MINIMUM_MEASURED_DAYS ? Math.max(1, Math.floor(values.length * 0.1)) : 0;
  const kept = values.slice(0, values.length - drop);
  const average = kept.reduce((sum, value) => sum + value, 0) / kept.length;
  return average * TIER_EVALUATION_WINDOW_DAYS;
}

/** Allowance thresholds that notify account administrators, as fractions of an approved allowance. */
export const USAGE_NOTIFICATION_THRESHOLDS = [0.8, 1] as const;

export function crossedThresholds(quantity: number, allowance: number | null): number[] {
  if (allowance == null || allowance <= 0) return [];
  return USAGE_NOTIFICATION_THRESHOLDS.filter((threshold) => quantity >= allowance * threshold);
}

// ---------------------------------------------------------------- trial eligibility

/**
 * Normalises an owner's email for the one-trial-per-owner check: case-folded, trimmed and without a
 * "+tag", so an ordinary re-registration does not claim another trial. Stored only as a keyed hash.
 */
export function normalizeTrialEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

// ---------------------------------------------------------------- facility prices

/** A change of more than this share of the current price needs explicit confirmation by default. */
export const DEFAULT_SIGNIFICANT_PRICE_CHANGE_PERCENT = 20;
export const PRICE_STATUSES = ["test", "approved"] as const;
export type PriceStatus = (typeof PRICE_STATUSES)[number];

export function isSignificantPriceChange(previous: number, next: number, thresholdPercent: number): boolean {
  if (previous === next) return false;
  if (previous === 0) return true;
  return (Math.abs(next - previous) / previous) * 100 > thresholdPercent;
}

/** Facility prices in the currency's own precision: UGX and RWF have no decimals; USD and KES have two. */
export function assertFacilityPrice(price: number, currency: string, allowZero: boolean): void {
  if (!Number.isFinite(price) || price < 0) throw new DomainError("A price cannot be negative");
  if (price === 0 && !allowZero) throw new DomainError("This facility does not allow zero-priced items. Enable them in billing settings first.");
  if (!fitsCurrencyPrecision(price, currency)) {
    const digits = currencyMinorDigits(currency);
    throw new DomainError(digits === 0 ? `${currency} prices are whole amounts with no decimals` : `${currency} prices have at most ${digits} decimal places`);
  }
}
