import { describe, expect, it } from "vitest";
import { accessModeFor } from "@medveris/domain";
import { isAllowlistedWhileRestricted, POLICY_TABLES } from "../../apps/api/src/lib/billing-middleware.js";

const { RESTRICTED_ROUTES, RESTRICTED_FINANCE_CONTINUITY_ALLOWLIST } = POLICY_TABLES;

describe("subscription enforcement policy tables", () => {
  it("accessModeFor restricts terminal/escrow states and allows everything else", () => {
    expect(accessModeFor("trial_expired")).toBe("restricted");
    expect(accessModeFor("restricted")).toBe("restricted");
    expect(accessModeFor("suspended")).toBe("restricted");
    expect(accessModeFor("cancelled")).toBe("restricted");
    expect(accessModeFor("past_due")).toBe("full");
    expect(accessModeFor("pending_payment")).toBe("full");
    expect(accessModeFor("trialing")).toBe("full");
    expect(accessModeFor("active")).toBe("full");
    expect(accessModeFor(null)).toBe("full");
  });

  it("keeps patient-care and emergency workflows mutable while restricted", () => {
    const open = [
      "/api/v1/emergency/cases",
      "/api/v1/clinical/orders",
      "/api/v1/care/encounters",
      "/api/v1/reception/registrations",
      "/api/v1/workflow/orders",
      "/api/v1/consent/grants",
      "/api/v1/diagnostics/orders",
      "/api/v1/radiology/studies",
      "/api/v1/pharmacy/dispense",
      "/api/v1/pharmacy-pos/sales",
      "/api/v1/inpatient/notes",
      "/api/v1/theatre/cases",
      "/api/v1/maternity/records",
      "/api/v1/documents",
      "/api/v1/devices",
      "/api/v1/telehealth/sessions",
      "/api/v1/programmes/enrollments",
      "/api/v1/operations",
      "/api/v1/patient-merges",
      "/api/v1/billing/checkout",
      "/api/v1/me/profile",
      "/api/v1/auth/sessions",
      "/api/v1/public/forms",
      "/api/v1/legal/privacy",
    ];
    for (const path of open) {
      expect(isAllowlistedWhileRestricted("POST", path), path).toBe(true);
      expect(isAllowlistedWhileRestricted("PATCH", path), path).toBe(true);
    }
    expect(isAllowlistedWhileRestricted("DELETE", "/api/v1/clinical/notes/1")).toBe(true);
  });

  it("blocks growth and administration mutations while restricted", () => {
    const blocked = [
      ["POST", "/api/v1/procurement/orders"],
      ["POST", "/api/v1/inventory/receipts"],
      ["POST", "/api/v1/organizations"],
      ["POST", "/api/v1/organization/departments"],
      ["POST", "/api/v1/workspace/invitations"],
      ["POST", "/api/v1/admin/flags"],
      ["POST", "/api/v1/ehmis/periods"],
      ["POST", "/api/v1/content/pages"],
      ["POST", "/api/v1/integrations/clients"],
      ["POST", "/api/v1/directory/listings"],
      ["POST", "/api/v1/promotion/campaigns"],
      ["POST", "/api/v1/notifications/mark-read"],
      ["POST", "/api/v1/ai/inference"],
      ["POST", "/api/v1/chat"],
      ["POST", "/api/v1/onboarding/cases"],
      ["POST", "/api/v1/integration-applications"],
    ] as const;
    for (const [method, path] of blocked) {
      expect(isAllowlistedWhileRestricted(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("leaves read-only methods to the guard's read-only branch (never allowlisted here)", () => {
    for (const path of ["/api/v1/procurement/orders", "/api/v1/organizations", "/api/v1/ai/inference"]) {
      expect(isAllowlistedWhileRestricted("GET", path)).toBe(false);
      expect(isAllowlistedWhileRestricted("HEAD", path)).toBe(false);
      expect(isAllowlistedWhileRestricted("OPTIONS", path)).toBe(false);
    }
  });

  it("keeps the patient-payment continuity allowlist for finance mutations", () => {
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/encounters/00000000-0000-4000-8000-000000000001/bill")).toBe(true);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/invoices")).toBe(true);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/invoices/00000000-0000-4000-8000-000000000001/payments")).toBe(true);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/invoices/00000000-0000-4000-8000-000000000001/cash")).toBe(true);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/invoices/00000000-0000-4000-8000-000000000001/mobile-money")).toBe(true);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/mobile-money/00000000-0000-4000-8000-000000000001/check")).toBe(true);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/claims")).toBe(true);
    expect(isAllowlistedWhileRestricted("GET", "/api/v1/finance/reports")).toBe(false);
    expect(isAllowlistedWhileRestricted("DELETE", "/api/v1/finance/invoices/00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(isAllowlistedWhileRestricted("POST", "/api/v1/finance/reports/export")).toBe(false);
  });

  it("declares restricted growth capabilities with 402 semantics", () => {
    const capabilities = RESTRICTED_ROUTES.map((entry) => entry.capability);
    expect(new Set(capabilities)).toEqual(new Set(["staff-invitations", "new-sites", "reports", "integrations"]));
    for (const entry of RESTRICTED_ROUTES) {
      expect(entry.method).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      expect(entry.pattern.source.startsWith("^")).toBe(true);
      expect(entry.pattern.source.endsWith("$")).toBe(true);
    }
  });

  it("exposes the finance-continuity patterns exactly (fail-closed on shape change)", () => {
    const sources = RESTRICTED_FINANCE_CONTINUITY_ALLOWLIST.map((re) => re.source);
    expect(sources).toHaveLength(8);
    expect(sources.some((s) => s.includes("bill"))).toBe(true);
    expect(sources.some((s) => s.includes("mobile-money"))).toBe(true);
  });
});
