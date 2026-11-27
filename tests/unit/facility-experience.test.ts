import { describe, expect, it } from "vitest";
import {
  LICENCE_STATUS_MESSAGES,
  dispensingDecision,
  experienceForCategory,
  isPharmacyOnlyRoute,
  licenceStatusOf,
  normalizeDispensingScope,
  resolveFacilityExperience,
  type LicenceStatus,
} from "@medveris/domain";

const TODAY = "2026-11-27";

function drugshop(registrations: Array<{
  kind: string; identifier: string; status: string; validUntil?: string | null;
  issuer?: string | null; verifiedAt?: string | null; documentReference?: string | null;
}>) {
  return resolveFacilityExperience({ serviceCategory: "drug-shop", registrations, today: TODAY });
}

describe("facility experience routing", () => {
  it("maps only the canonical category to the Drugshop experience, never the name", () => {
    expect(experienceForCategory("drug-shop")).toBe("drugshop");
    expect(experienceForCategory("pharmacy")).toBe("pharmacy");
    expect(experienceForCategory("hospital")).toBe("facility");
    expect(experienceForCategory("clinic")).toBe("facility");
    expect(experienceForCategory(null)).toBe("facility");
    // A name containing "drugshop" is not a category and cannot be passed here at all.
    expect(experienceForCategory("Kampala Drugshop")).toBe("facility");
  });

  it("restricts only a workspace with no recorded facility type", () => {
    const resolved = resolveFacilityExperience({ serviceCategory: null, today: TODAY });
    expect(resolved.access.status).toBe("restricted");
    expect(resolved.access.reasons[0]).toMatch(/no recorded facility type/i);
  });

  it("never restricts a Drugshop because of the licence's documentation state", () => {
    const cases: Array<{
      label: string;
      registrations: Array<{ kind: string; identifier: string; status: string; validUntil?: string | null }>;
      status: LicenceStatus;
    }> = [
      { label: "not provided", registrations: [], status: "not-provided" },
      { label: "pending", registrations: [{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "recorded" }], status: "pending-verification" },
      { label: "rejected", registrations: [{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "rejected" }], status: "rejected" },
      { label: "expired by date", registrations: [{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "verified", validUntil: "2026-01-01" }], status: "expired" },
      { label: "expired by status", registrations: [{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "expired" }], status: "expired" },
      { label: "withdrawn", registrations: [{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "withdrawn" }], status: "withdrawn" },
    ];

    for (const scenario of cases) {
      const resolved = drugshop([...scenario.registrations]);
      expect(resolved.experience, scenario.label).toBe("drugshop");
      expect(resolved.access.status, scenario.label).toBe("ready");
      expect(resolved.access.reasons, scenario.label).toEqual([]);
      expect(resolved.licenceStatus, scenario.label).toBe(scenario.status);
      if (scenario.status !== "verified") {
        // The notice names the documentation state and says access continues; an expired
        // record adds the date it lapsed.
        expect(resolved.licenceNotice, scenario.label).toContain(
          scenario.status === "not-provided" ? "continue using MedVeris" : "platform access remains active",
        );
        expect(resolved.access.warnings, scenario.label).toContain(resolved.licenceNotice);
      }
    }
    expect(drugshop([]).licenceNotice).toBe(LICENCE_STATUS_MESSAGES["not-provided"]);
    expect(drugshop([{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "recorded" }]).licenceNotice)
      .toBe(LICENCE_STATUS_MESSAGES["pending-verification"]);
  });

  it("reports a verified, unexpired licence as verified and carries its details", () => {
    const verified = drugshop([{
      kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "verified", validUntil: "2027-01-01",
      issuer: "National Drug Authority", verifiedAt: "2026-11-01T00:00:00.000Z", documentReference: "licence-2026.pdf",
    }]);
    expect(verified.access.status).toBe("ready");
    expect(verified.access.warnings).toEqual([]);
    expect(verified.licenceStatus).toBe("verified");
    expect(verified.licence).toMatchObject({
      identifier: "NDA-DS-1", status: "verified", issuer: "National Drug Authority", documentReference: "licence-2026.pdf",
    });
    expect(verified.licenceKinds).toEqual(["nda-drug-shop"]);
  });

  it("ignores a pharmacy licence as proof for a drug shop, without blocking the shop", () => {
    const resolved = drugshop([{ kind: "nda-pharmacy", identifier: "NDA-PH-1", status: "verified" }]);
    expect(resolved.access.status).toBe("ready");
    expect(resolved.licence).toBeNull();
    expect(resolved.licenceStatus).toBe("not-provided");
  });

  it("keeps the pharmacy experience without locking pharmacies out over a missing licence", () => {
    const resolved = resolveFacilityExperience({ serviceCategory: "pharmacy", registrations: [], today: TODAY });
    expect(resolved.experience).toBe("pharmacy");
    expect(resolved.access.status).toBe("ready");
    expect(resolved.access.warnings[0]).toMatch(/licence details have not been provided/i);
  });

  it("maps stored status and expiry to the documentation states", () => {
    expect(licenceStatusOf({ kind: "nda-drug-shop", identifier: "x", status: "recorded" }, TODAY)).toBe("pending-verification");
    expect(licenceStatusOf({ kind: "nda-drug-shop", identifier: "x", status: "verified", validUntil: "2027-01-01" }, TODAY)).toBe("verified");
    expect(licenceStatusOf({ kind: "nda-drug-shop", identifier: "x", status: "verified", validUntil: "2026-01-01" }, TODAY)).toBe("expired");
    expect(licenceStatusOf({ kind: "nda-drug-shop", identifier: "x", status: "rejected" }, TODAY)).toBe("rejected");
  });
});

describe("drugshop dispensing eligibility", () => {
  const verified = "verified" as const;

  it("allows only explicitly over-the-counter stock", () => {
    expect(dispensingDecision({ experience: "drugshop", licenceStatus: verified, dispensingScope: "otc", prescriptionOnly: false })).toEqual({ allowed: true });
    expect(dispensingDecision({ experience: "drugshop", licenceStatus: verified, dispensingScope: "otc", prescriptionOnly: true }).code).toBe("prescription-only");
  });

  it("refuses unclassified, pharmacy-only, prescription-only and non-dispensable items", () => {
    expect(dispensingDecision({ experience: "drugshop", licenceStatus: verified, dispensingScope: "unverified" }).code).toBe("classification-unverified");
    expect(dispensingDecision({ experience: "drugshop", licenceStatus: verified, dispensingScope: "pharmacy-only" }).code).toBe("pharmacy-only");
    expect(dispensingDecision({ experience: "drugshop", licenceStatus: verified, dispensingScope: "prescription-only" }).code).toBe("prescription-only");
    expect(dispensingDecision({ experience: "drugshop", licenceStatus: verified, dispensingScope: "not-dispensable" }).code).toBe("not-dispensable");
    expect(normalizeDispensingScope("something-else")).toBe("unverified");
  });

  it("refuses every medicine sale while the licence is not verified, without touching platform access", () => {
    for (const status of ["not-provided", "pending-verification", "rejected", "expired", "withdrawn", null] as const) {
      expect(dispensingDecision({ experience: "drugshop", licenceStatus: status, dispensingScope: "otc" }).code).toBe("licence-unverified");
    }
  });

  it("does not change pharmacy or general-facility dispensing", () => {
    expect(dispensingDecision({ experience: "pharmacy", dispensingScope: "prescription-only", prescriptionOnly: true })).toEqual({ allowed: true });
    expect(dispensingDecision({ experience: "facility", dispensingScope: "unverified" })).toEqual({ allowed: true });
  });

  it("keeps Pharmacy-only routes closed to Drugshops", () => {
    expect(isPharmacyOnlyRoute("/pharmacy")).toBe(true);
    expect(isPharmacyOnlyRoute("/pharmacy/some-id")).toBe(true);
    expect(isPharmacyOnlyRoute("/pharmacy-pos")).toBe(false);
    expect(isPharmacyOnlyRoute("/price-lists")).toBe(false);
    expect(isPharmacyOnlyRoute("/drugshop")).toBe(false);
  });
});
