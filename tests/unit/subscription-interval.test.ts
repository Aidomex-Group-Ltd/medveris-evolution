import { describe, expect, it } from "vitest";
import {
  addBillingInterval,
  BILLING_INTERVALS,
  billingIntervalPeriod,
  checkoutDisclosure,
  exchangeRateIsStale,
  SEAT_PRICE_USD_MINOR,
  seatAmountUsdMinor,
  usdMinorToUgxMinor,
} from "@medveris/domain";

describe("subscription billing intervals", () => {
  it("offers exactly the five advertised intervals", () => {
    expect([...BILLING_INTERVALS]).toEqual(["daily", "weekly", "monthly", "quarterly", "annually"]);
  });

  it("advances each interval by its calendar length", () => {
    const start = new Date("2026-01-31T10:00:00.000Z");
    expect(addBillingInterval(start, "daily").toISOString()).toBe("2026-02-01T10:00:00.000Z");
    expect(addBillingInterval(start, "weekly").toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(addBillingInterval(start, "monthly").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addBillingInterval(start, "quarterly").toISOString()).toBe("2026-04-30T10:00:00.000Z");
    expect(addBillingInterval(start, "annually").toISOString()).toBe("2027-01-31T10:00:00.000Z");
  });

  it("builds a strictly increasing period for every interval", () => {
    for (const interval of BILLING_INTERVALS) {
      const period = billingIntervalPeriod(new Date("2026-03-01T00:00:00.000Z"), interval);
      expect(period.end.getTime()).toBeGreaterThan(period.start.getTime());
    }
  });

  it("charges USD 0.50 per active user and rejects an empty account", () => {
    expect(SEAT_PRICE_USD_MINOR).toBe(50);
    expect(seatAmountUsdMinor(1)).toBe(50);
    expect(seatAmountUsdMinor(6)).toBe(300);
    expect(() => seatAmountUsdMinor(0)).toThrow(/at least one active user/);
    expect(() => seatAmountUsdMinor(2.5)).toThrow();
  });

  it("converts to whole shillings by rounding up, never down", () => {
    expect(usdMinorToUgxMinor(300, 3800)).toBe(11_400);
    expect(usdMinorToUgxMinor(50, 3811.37)).toBe(1906); // 1905.685 rounds up
    expect(() => usdMinorToUgxMinor(50, 0)).toThrow();
  });

  it("treats a rate older than the configured age as stale", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    expect(exchangeRateIsStale(new Date("2026-10-30T11:59:00.000Z"), now, 60)).toBe(false);
    expect(exchangeRateIsStale(new Date("2026-10-30T10:00:00.000Z"), now, 60)).toBe(true);
    expect(exchangeRateIsStale(now, now, 0)).toBe(true);
  });

  it("discloses the UGX amount, interval, dates, manual renewal and minimum before payment", () => {
    const disclosure = checkoutDisclosure({
      product: "Medveris workspace access",
      seats: 4,
      interval: "quarterly",
      amountUgx: 22_800,
      amountUsdMinor: 200,
      periodStart: new Date("2026-11-01T00:00:00.000Z"),
      periodEnd: new Date("2027-02-01T00:00:00.000Z"),
      rate: 3800,
      rateSource: "openexchangerates",
      rateTimestamp: new Date("2026-10-30T10:00:00.000Z"),
      minUgx: 500,
    });
    expect(disclosure).toContain("4 active users");
    expect(disclosure).toContain("UGX 22,800");
    expect(disclosure).toContain("USD 2.00");
    expect(disclosure).toContain("2026-11-01 to 2027-02-01");
    expect(disclosure).toContain("Renewal is manual");
    expect(disclosure).toContain("never charge your phone automatically");
    expect(disclosure).toContain("UGX 500");
  });
});
