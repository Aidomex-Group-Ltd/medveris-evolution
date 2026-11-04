import { describe, expect, it } from "vitest";
import { USAGE_NOTIFICATION_THRESHOLDS, crossedThresholds } from "@medveris/domain";

describe("capacity alerts", () => {
  it("notifies at 80%, 90% and 100% of a staff or storage allowance", () => {
    expect(USAGE_NOTIFICATION_THRESHOLDS).toEqual([0.8, 0.9, 1]);
    expect(crossedThresholds(7, 10)).toEqual([]);
    expect(crossedThresholds(8, 10)).toEqual([0.8]);
    expect(crossedThresholds(9, 10)).toEqual([0.8, 0.9]);
    expect(crossedThresholds(10, 10)).toEqual([0.8, 0.9, 1]);
  });

  it("never alerts when the plan has no allowance", () => {
    expect(crossedThresholds(1_000, null)).toEqual([]);
    expect(crossedThresholds(1_000, 0)).toEqual([]);
  });

  it("does not delete or block existing data at 100%", () => {
    // The threshold is a notification only: exceeding it returns the same crossed set as reaching it.
    expect(crossedThresholds(11, 10)).toEqual([0.8, 0.9, 1]);
  });
});
