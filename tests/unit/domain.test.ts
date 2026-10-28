import { describe, expect, it } from "vitest";
import {
  canTransitionEncounter,
  canTransitionFollowUp,
  canTransitionReferral,
  canonicalJson,
  contentDigest,
  isPatientPublicId,
  localMedicalRecordNumber,
  nextEntryStatus,
  randomPatientPublicId,
  DEFAULT_PRIVILEGES,
  UGANDA_CATALOGUE_VERSION,
  UGANDA_ONBOARDING_CATALOGUE,
  catalogueIntegrityIssues,
  isClinicalCadre,
  jobTitleByCode,
  onboardingPathForTitle,
  regulatorCodesForCadre,
  searchCatalogue,
  titleDepartmentCodes,
} from "@medveris/domain";
import { ROLES } from "@medveris/authz";

describe("patient public identifier", () => {
  it("is randomized, non-sequential and matches the transcription-safe alphabet", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomPatientPublicId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^MV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(isPatientPublicId(id)).toBe(true);
    }
  });

  it("rejects ambiguous characters", () => {
    expect(isPatientPublicId("MV-IIII-1111-OOOO-0000")).toBe(false);
  });

  it("derives distinct facility record numbers for public IDs that share a suffix", () => {
    expect(localMedicalRecordNumber("kampala-clinic", "MV-AAAA-BBBB-CCCC-7XYZ")).toBe("MRN-KAMPALA--AAAABBBBCCCC7XYZ");
    expect(localMedicalRecordNumber("kampala-clinic", "MV-DDDD-EEEE-FFFF-7XYZ")).not.toBe(localMedicalRecordNumber("kampala-clinic", "MV-AAAA-BBBB-CCCC-7XYZ"));
    expect(() => localMedicalRecordNumber("kampala-clinic", "not-an-id")).toThrow();
  });
});

describe("clinical entry state machine", () => {
  it("permits draft to signed only", () => {
    expect(nextEntryStatus("draft", "sign")).toBe("signed");
    expect(() => nextEntryStatus("signed", "sign")).toThrow();
    expect(() => nextEntryStatus("amended", "sign")).toThrow();
  });

  it("permits reasoned amendments only after signing", () => {
    expect(nextEntryStatus("signed", "amend")).toBe("amended");
    expect(nextEntryStatus("amended", "amend")).toBe("amended");
    expect(() => nextEntryStatus("draft", "amend")).toThrow();
  });

  it("preserves signed history by transitioning to entered-in-error rather than deleting", () => {
    expect(nextEntryStatus("signed", "error")).toBe("entered-in-error");
    expect(() => nextEntryStatus("draft", "error")).toThrow();
  });
});

describe("encounter transitions", () => {
  it("enforces the outpatient pathway", () => {
    expect(canTransitionEncounter("planned", "arrived")).toBe(true);
    expect(canTransitionEncounter("arrived", "triaged")).toBe(true);
    expect(canTransitionEncounter("triaged", "in-progress")).toBe(true);
    expect(canTransitionEncounter("in-progress", "completed")).toBe(true);
    expect(canTransitionEncounter("completed", "in-progress")).toBe(false);
    expect(canTransitionEncounter("arrived", "completed")).toBe(false);
  });
});

describe("content digests", () => {
  it("is stable across object key order but sensitive to content changes", async () => {
    const first = await contentDigest({ title: "Note", plan: "Review" });
    const second = await contentDigest({ plan: "Review", title: "Note" });
    const changed = await contentDigest({ plan: "Review", title: "Note " });
    expect(first).toBe(second);
    expect(changed).not.toBe(first);
    expect(first.startsWith("sha256:")).toBe(true);
  });

  it("canonicalizes nested structures deterministically", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("follow-up and referral tracking transitions", () => {
  it("keeps follow-ups terminal after a decision", () => {
    expect(canTransitionFollowUp("pending", "completed")).toBe(true);
    expect(canTransitionFollowUp("pending", "cancelled")).toBe(true);
    expect(canTransitionFollowUp("completed", "cancelled")).toBe(false);
    expect(canTransitionFollowUp("cancelled", "completed")).toBe(false);
  });

  it("allows referral completion only after local acceptance", () => {
    expect(canTransitionReferral("pending", "accepted")).toBe(true);
    expect(canTransitionReferral("pending", "declined")).toBe(true);
    expect(canTransitionReferral("accepted", "completed")).toBe(true);
    expect(canTransitionReferral("declined", "completed")).toBe(false);
    expect(canTransitionReferral("completed", "cancelled")).toBe(false);
  });
});

describe("Uganda onboarding catalogue", () => {
  it("is internally consistent and references only known privileges and roles", () => {
    expect(catalogueIntegrityIssues(UGANDA_ONBOARDING_CATALOGUE, {
      knownPrivilegeCodes: DEFAULT_PRIVILEGES.map((item) => item.code),
      knownSystemRoles: ROLES,
    })).toEqual([]);
  });

  it("keeps a version, country and non-legal notice", () => {
    expect(UGANDA_ONBOARDING_CATALOGUE.countryCode).toBe("UG");
    expect(UGANDA_ONBOARDING_CATALOGUE.version).toBe(UGANDA_CATALOGUE_VERSION);
    expect(UGANDA_ONBOARDING_CATALOGUE.notice.toLowerCase()).toContain("not an exhaustive");
  });

  it("maps clinical, nursing, support and administrative titles to distinct onboarding paths", () => {
    const path = (code: string) => onboardingPathForTitle(UGANDA_ONBOARDING_CATALOGUE, jobTitleByCode(UGANDA_ONBOARDING_CATALOGUE, code)!);
    expect(path("MED-OFF-STD")).toBe("clinician");
    expect(path("MIDWIFE-STD")).toBe("nurse");
    expect(path("HOUSEKEEPER-STD")).toBe("support");
    expect(path("HR-OFF-STD")).toBe("administrative");
    expect(path("HOSP-MGR-STD")).toBe("facility_admin");
  });

  it("returns department and regulator metadata for a selected title", () => {
    expect(titleDepartmentCodes(UGANDA_ONBOARDING_CATALOGUE, "MED-OFF-STD")).toContain("OPD");
    expect(regulatorCodesForCadre(UGANDA_ONBOARDING_CATALOGUE, "MED-OFF")).toEqual(["UMDPC"]);
    expect(isClinicalCadre(UGANDA_ONBOARDING_CATALOGUE, "MIDWIFE")).toBe(true);
    expect(isClinicalCadre(UGANDA_ONBOARDING_CATALOGUE, "HOUSEKEEPER")).toBe(false);
  });

  it("searches by text, cadre and department without exposing unreviewed free text", () => {
    const result = searchCatalogue(UGANDA_ONBOARDING_CATALOGUE, { q: "midwife" });
    expect(result.titles.some((title) => title.code === "MIDWIFE-STD")).toBe(true);
    const byDepartment = searchCatalogue(UGANDA_ONBOARDING_CATALOGUE, { departmentCode: "THEATRE" });
    expect(byDepartment.titles.every((title) => title.departmentCodes.includes("THEATRE"))).toBe(true);
  });
});
