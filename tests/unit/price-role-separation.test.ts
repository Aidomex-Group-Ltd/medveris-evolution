import { describe, expect, it } from "vitest";
import {
  PRICE_LIST_READ_ROLES,
  PRICE_LIST_ROLES,
  ROLE_PERMISSIONS,
  assertPriceListManager,
  type ActorContext,
  type Role,
} from "@medveris/authz";

/** Read-only and billing roles must never reach the price-list write path. */
function actor(roles: Role[]): ActorContext {
  return {
    userId: "u1",
    roles,
    tenantId: "t1",
    patientId: null,
    mfaVerified: true,
    mfaEnrolled: true,
  };
}

describe("price catalogue role separation", () => {
  it("keeps read-only and billing roles out of the price-list write roles", () => {
    for (const role of ["facility_view_only", "billing_officer", "auditor"] as const) {
      expect(PRICE_LIST_ROLES).not.toContain(role);
      expect(PRICE_LIST_READ_ROLES).toContain(role);
      expect(() => assertPriceListManager(actor([role]))).toThrow(/price list management/i);
    }
  });

  it("lets the price administration roles change prices", () => {
    for (const role of ["finance", "facility_admin", "global_system_administrator", "global_price_manager", "country_price_administrator", "facility_finance_manager"] as const) {
      expect(PRICE_LIST_ROLES).toContain(role);
      expect(() => assertPriceListManager(actor([role]))).not.toThrow();
    }
  });

  it("gives read-only roles catalogue read access but no catalogue mutation permission", () => {
    for (const role of ["facility_view_only", "billing_officer"] as const) {
      const permissions = ROLE_PERMISSIONS[role];
      expect(permissions).toContain("inventory.catalogue.read");
      expect(permissions).not.toContain("inventory.catalogue.manage");
    }
    expect(ROLE_PERMISSIONS.global_price_manager).toContain("inventory.catalogue.manage");
  });

  it("does not let a view-only account place or dispense an order role-side", () => {
    const permissions = ROLE_PERMISSIONS.facility_view_only;
    expect(permissions).not.toContain("inventory.stock.issue");
    expect(permissions).not.toContain("inventory.stock.receive");
  });
});
