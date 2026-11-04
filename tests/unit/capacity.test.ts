import { describe, expect, it } from "vitest";
import { assertStaffCapacity, assertStorageCapacity } from "../../apps/api/src/services/capacity.js";

describe("staff seat capacity", () => {
  it("counts active and reserved seats against the plan allowance", () => {
    expect(() => assertStaffCapacity({ active: 8, pending: 1, limit: 10 }, 1)).not.toThrow();
    expect(() => assertStaffCapacity({ active: 9, pending: 1, limit: 10 }, 1)).toThrow(/10 active staff accounts/);
  });

  it("does not block patients or unlimited trial capacity", () => {
    expect(() => assertStaffCapacity({ active: 500, pending: 0, limit: null }, 1)).not.toThrow();
    expect(() => assertStaffCapacity({ active: 10, pending: 0, limit: 10 }, 0)).not.toThrow();
  });
});

describe("storage capacity", () => {
  it("allows an upload inside the allowance and refuses one that would exceed it", () => {
    expect(() => assertStorageCapacity(9, 1, 10)).not.toThrow();
    expect(() => assertStorageCapacity(9, 2, 10)).toThrow(/storage allowance/);
  });

  it("never blocks when the plan has no storage cap", () => {
    expect(() => assertStorageCapacity(1_000_000, 1_000_000, null)).not.toThrow();
  });
});
