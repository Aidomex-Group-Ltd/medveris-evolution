import { describe, expect, it } from "vitest";
import {
  dispensingDecision,
  experienceForCategory,
  isPharmacyOnlyRoute,
  normalizeDispensingScope,
  resolveFacilityExperience,
} from "@medveris/domain";

const TODAY = "2026-11-27";

function drugshop(registrations: Array<{ kind: string; identifier: string; status: string; validUntil?: string | null }>) {
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

  it("restricts a workspace with no recorded facility type", () => {
    const resolved = resolveFacilityExperience({ serviceCategory: null, today: TODAY });
    expect(resolved.access.status).toBe("restricted");
    expect(resolved.access.reasons[0]).toMatch(/no recorded facility type/i);
  });

  it("blocks a Drugshop until an NDA drug shop licence is verified", () => {
    const missing = drugshop([]);
    expect(missing.experience).toBe("drugshop");
    expect(missing.access.status).toBe("restricted");
    expect(missing.licence).toBeNull();
    expect(missing.requiredLicenceKinds).toEqual(["nda-drug-shop"]);

    const recorded = drugshop([{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "recorded" }]);
    expect(recorded.access.status).toBe("restricted");
    expect(recorded.licence?.state).toBe("unverified");
    expect(recorded.access.reasons[0]).toMatch(/not verified/i);

    const expired = drugshop([{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "verified", validUntil: "2026-01-01" }]);
    expect(expired.access.status).toBe("restricted");
    expect(expired.access.reasons[0]).toMatch(/expired/i);

    const withdrawn = drugshop([{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "withdrawn" }]);
    expect(withdrawn.access.status).toBe("restricted");

    const verified = drugshop([{ kind: "nda-drug-shop", identifier: "NDA-DS-1", status: "verified", validUntil: "2027-01-01" }]);
    expect(verified.access.status).toBe("ready");
    expect(verified.licence).toMatchObject({ identifier: "NDA-DS-1", state: "verified" });
  });

  it("ignores a pharmacy licence as proof for a drug shop", () => {
    const resolved = drugshop([{ kind: "nda-pharmacy", identifier: "NDA-PH-1", status: "verified" }]);
    expect(resolved.access.status).toBe("restricted");
    expect(resolved.licence).toBeNull();
  });

  it("keeps the pharmacy experience without locking pharmacies out over a missing licence", () => {
    const resolved = resolveFacilityExperience({ serviceCategory: "pharmacy", registrations: [], today: TODAY });
    expect(resolved.experience).toBe("pharmacy");
    expect(resolved.access.status).toBe("ready");
    expect(resolved.access.warnings[0]).toMatch(/no NDA pharmacy licence/i);
  });
});

describe("drugshop dispensing eligibility", () => {
  const verified = "verified" as const;

  it("allows only explicitly over-the-counter stock", () => {
    expect(dispensingDecision({ experience: "drugshop", licenceState: verified, dispensingScope: "otc", prescriptionOnly: false })).toEqual({ allowed: true });
    expect(dispensingDecision({ experience: "drugshop", licenceState: verified, dispensingScope: "otc", prescriptionOnly: true }).code).toBe("prescription-only");
  });

  it("refuses unclassified, pharmacy-only, prescription-only and non-dispensable items", () => {
    expect(dispensingDecision({ experience: "drugshop", licenceState: verified, dispensingScope: "unverified" }).code).toBe("classification-unverified");
    expect(dispensingDecision({ experience: "drugshop", licenceState: verified, dispensingScope: "pharmacy-only" }).code).toBe("pharmacy-only");
    expect(dispensingDecision({ experience: "drugshop", licenceState: verified, dispensingScope: "prescription-only" }).code).toBe("prescription-only");
    expect(dispensingDecision({ experience: "drugshop", licenceState: verified, dispensingScope: "not-dispensable" }).code).toBe("not-dispensable");
    expect(normalizeDispensingScope("something-else")).toBe("unverified");
  });

  it("refuses every item when the licence is not verified, even an OTC one", () => {
    expect(dispensingDecision({ experience: "drugshop", licenceState: "unverified", dispensingScope: "otc" }).code).toBe("licence-unverified");
    expect(dispensingDecision({ experience: "drugshop", licenceState: null, dispensingScope: "otc" }).code).toBe("licence-unverified");
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
