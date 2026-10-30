import { DomainError } from "./errors.js";
import { addMonths, type BillingPeriod } from "./billing.js";

/**
 * Self-service subscription periods. A seat is one active user on the billing account's workspaces,
 * and every period costs the same per seat. There is no automatic charge: the customer pays each
 * period with an explicit mobile-money prompt, so `addInterval` defines the paid period and its
 * renewal date rather than a recurring mandate.
 */
export const BILLING_INTERVALS = ["daily", "weekly", "monthly", "quarterly", "annually"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const BILLING_INTERVAL_LABELS: Record<BillingInterval, { singular: string; plural: string; per: string }> = {
  daily: { singular: "day", plural: "days", per: "per day" },
  weekly: { singular: "week", plural: "weeks", per: "per week" },
  monthly: { singular: "month", plural: "months", per: "per month" },
  quarterly: { singular: "quarter", plural: "quarters", per: "per quarter" },
  annually: { singular: "year", plural: "years", per: "per year" },
};

/** USD 0.50 per user per billing period, charged in its UGX equivalent. */
export const SEAT_PRICE_USD_MINOR = 50;

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);
}

/** The end of the period that starts at `start`. Calendar months respect month length; days are exact hours. */
export function addBillingInterval(start: Date, interval: BillingInterval): Date {
  const at = new Date(start.getTime());
  switch (interval) {
    case "daily":
      return new Date(at.getTime() + 24 * 60 * 60 * 1000);
    case "weekly":
      return new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000);
    case "monthly":
      return addMonths(at, 1);
    case "quarterly":
      return addMonths(at, 3);
    case "annually":
      return addMonths(at, 12);
    default:
      throw new DomainError("Unsupported billing interval");
  }
}

export function billingIntervalPeriod(start: Date, interval: BillingInterval): BillingPeriod {
  const end = addBillingInterval(start, interval);
  if (!(end > start)) throw new DomainError("The billing period must end after it starts");
  return { start: new Date(start.getTime()), end };
}

/** 50 cents per seat, in minor units, so the amount never depends on floating point money. */
export function seatAmountUsdMinor(seats: number): number {
  if (!Number.isInteger(seats) || seats < 1) throw new DomainError("A billing account needs at least one active user");
  return seats * SEAT_PRICE_USD_MINOR;
}

/**
 * Converts a USD minor amount to whole Ugandan shillings, rounding up. Mobile money collects whole
 * shillings, and rounding up means the collected amount is never below the disclosed price.
 */
export function usdMinorToUgxMinor(amountUsdMinor: number, ugxPerUsd: number): number {
  if (!Number.isInteger(amountUsdMinor) || amountUsdMinor <= 0) throw new DomainError("The USD amount must be a positive number of cents");
  if (!Number.isFinite(ugxPerUsd) || ugxPerUsd <= 0) throw new DomainError("A positive USD/UGX exchange rate is required");
  return Math.ceil((amountUsdMinor / 100) * ugxPerUsd);
}

/** A market rate older than the configured age is not used; a stale price would be a false disclosure. */
export function exchangeRateIsStale(providerTimestamp: Date, now: Date, maxAgeMinutes: number): boolean {
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) return true;
  const ageMs = now.getTime() - providerTimestamp.getTime();
  return ageMs > maxAgeMinutes * 60 * 1000;
}

export const SUBSCRIPTION_RENEWAL_MODE = "manual" as const;

/**
 * The exact terms shown before the payment prompt. The amount, interval, period, renewal date and
 * cancellation behaviour are all stated; nothing renews without a new prompt.
 */
export function checkoutDisclosure(input: {
  product: string;
  seats: number;
  interval: BillingInterval;
  amountUgx: number;
  amountUsdMinor: number;
  periodStart: Date;
  periodEnd: Date;
  rate: number;
  rateSource: string;
  rateTimestamp: Date | null;
  minUgx: number;
}): string {
  const label = BILLING_INTERVAL_LABELS[input.interval];
  const usd = `USD ${(input.amountUsdMinor / 100).toFixed(2)}`;
  const rateAt = input.rateTimestamp ? ` published ${input.rateTimestamp.toISOString().slice(0, 16).replace("T", " ")} UTC` : " set by the operator";
  return [
    `${input.product} for ${input.seats} active user${input.seats === 1 ? "" : "s"} at USD 0.50 per user ${label.per}.`,
    `You will be prompted to pay UGX ${input.amountUgx.toLocaleString("en-UG")} for one ${label.singular}, the equivalent of ${usd} at ${input.rate.toLocaleString("en-US", { maximumFractionDigits: 4 })} UGX per USD (${input.rateSource}${rateAt}, rounded up to whole shillings).`,
    `The paid period runs ${input.periodStart.toISOString().slice(0, 10)} to ${input.periodEnd.toISOString().slice(0, 10)} and ends on that date.`,
    "Renewal is manual: we never charge your phone automatically. We remind you before the period ends and you approve a new payment prompt when you are ready.",
    "You can stop at any time by not paying the next period; access continues to the end of the paid period and clinical records are never deleted. A pending prompt can be cancelled before it is approved.",
    `The minimum we collect is UGX ${input.minUgx.toLocaleString("en-UG")}.`,
  ].join(" ");
}
