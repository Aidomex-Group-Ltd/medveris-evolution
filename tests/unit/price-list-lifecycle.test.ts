import { describe, expect, it } from "vitest";
import {
  PRICE_LIST_STATUSES,
  assertPriceListActionRole,
  availablePriceListActions,
  canTransitionPriceList,
  nextPriceListStatus,
  normalizePriceListStatus,
  priceListIsEditable,
  validatePriceList,
  type PriceListInput,
} from "@medveris/domain";

function list(overrides: Partial<PriceListInput> = {}): PriceListInput {
  return {
    code: "UGX-OPD-2027",
    name: "Outpatient prices 2027",
    effectiveFrom: "2027-01-01",
    effectiveTo: "2027-12-31",
    items: [
      { masterPriceCode: "CONS-001", name: "Consultation", category: "consultation", price: 20000, currency: "UGX" },
      { masterPriceCode: "LAB-001", name: "Full blood count", category: "laboratory", price: 15000, currency: "UGX" },
    ],
    ...overrides,
  };
}

describe("price list lifecycle", () => {
  it("moves through the controlled order and rejects skipping steps", () => {
    let status = normalizePriceListStatus("draft");
    expect(status).toBe("DRAFT");
    for (const step of ["validate", "submit", "approve", "publish"] as const) {
      status = nextPriceListStatus(status, step);
    }
    expect(status).toBe("PUBLISHED");
    status = nextPriceListStatus(status, "expire");
    expect(status).toBe("EXPIRED");
    status = nextPriceListStatus(status, "archive");
    expect(status).toBe("ARCHIVED");
    expect(availablePriceListActions(status)).toEqual([]);
  });

  it("refuses to publish a draft directly", () => {
    expect(() => nextPriceListStatus("DRAFT", "publish")).toThrow(/cannot go from/i);
    expect(canTransitionPriceList("DRAFT", "PUBLISHED")).toBe(false);
  });

  it("returns a rejected list to its editor as a draft", () => {
    expect(nextPriceListStatus("PENDING_APPROVAL", "reject")).toBe("DRAFT");
    expect(canTransitionPriceList("PENDING_APPROVAL", "REJECTED" as never)).toBe(false);
  });

  it("treats a published list as immutable apart from expiry or archiving", () => {
    expect(availablePriceListActions("PUBLISHED").sort()).toEqual(["archive", "expire"]);
    expect(availablePriceListActions("ARCHIVED")).toEqual([]);
    expect(priceListIsEditable("PUBLISHED")).toBe(false);
    expect(priceListIsEditable("DRAFT")).toBe(true);
    expect(priceListIsEditable("VALIDATED")).toBe(true);
  });

  it("normalises legacy lowercase statuses and rejects unknown ones", () => {
    expect(normalizePriceListStatus("pending_approval")).toBe("PENDING_APPROVAL");
    expect(() => normalizePriceListStatus("cancelled")).toThrow(/Unknown price list status/i);
    expect(PRICE_LIST_STATUSES).toEqual([
      "DRAFT",
      "VALIDATED",
      "PENDING_APPROVAL",
      "APPROVED",
      "PUBLISHED",
      "EXPIRED",
      "ARCHIVED",
    ]);
  });

  it("separates who validates from who approves and publishes", () => {
    expect(() => assertPriceListActionRole("validate", ["finance"])).not.toThrow();
    expect(() => assertPriceListActionRole("approve", ["finance"])).toThrow(/cannot approve/i);
    expect(() => assertPriceListActionRole("publish", ["finance"])).toThrow(/cannot publish/i);
    expect(() => assertPriceListActionRole("publish", ["facility_admin"])).not.toThrow();
    expect(() => assertPriceListActionRole("publish", [], true)).not.toThrow();
  });
});

describe("price list validation", () => {
  it("accepts a complete list", () => {
    expect(validatePriceList(list())).toEqual([]);
  });

  it("requires at least one item and a usable code", () => {
    const issues = validatePriceList(list({ code: "a", items: [] }));
    expect(issues.map((issue) => issue.field)).toContain("code");
    expect(issues.map((issue) => issue.field)).toContain("items");
  });

  it("refuses a mixed-currency list instead of converting money", () => {
    const issues = validatePriceList(list({
      items: [
        { name: "Consultation", category: "consultation", price: 20000, currency: "UGX" },
        { name: "Consultation (USD)", category: "consultation", price: 10, currency: "USD" },
      ],
    }));
    expect(issues.some((issue) => /one currency/i.test(issue.message))).toBe(true);
  });

  it("enforces the currency's decimal places", () => {
    const issues = validatePriceList(list({
      items: [{ name: "Consultation", category: "consultation", price: 20000.5, currency: "UGX" }],
    }));
    expect(issues.some((issue) => issue.field === "items.0.price")).toBe(true);
  });

  it("rejects a repeated catalogue item and a backwards date range", () => {
    const issues = validatePriceList(list({
      effectiveFrom: "2027-12-31",
      effectiveTo: "2027-01-01",
      items: [
        { masterPriceCode: "CONS-001", name: "Consultation", category: "consultation", price: 20000, currency: "UGX" },
        { masterPriceCode: "CONS-001", name: "Consultation again", category: "consultation", price: 25000, currency: "UGX" },
      ],
    }));
    const fields = issues.map((issue) => issue.field);
    expect(fields).toContain("effectiveTo");
    expect(fields).toContain("items.1.masterPriceCode");
  });

  it("rejects an unsupported currency and a negative price", () => {
    const issues = validatePriceList(list({
      items: [{ name: "Consultation", category: "consultation", price: -1, currency: "XYZ" }],
    }));
    expect(issues.map((issue) => issue.field)).toContain("items.0.currency");
  });
});
