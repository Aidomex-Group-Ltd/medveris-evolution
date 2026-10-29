import { describe, expect, it } from "vitest";
import {
  DomainError,
  NO_STANDALONE_LEVEL_LABEL,
  defaultLevelStatus,
  describeLevel,
  parsePeriod,
  periodSchedule,
  previousPeriod,
  recommendModules,
  resolveLevel,
  rollUpLevel,
  suggestedEquivalent,
} from "@medveris/domain";

describe("facility category and level of care", () => {
  it("suggests HC II-equivalent for a general outpatient clinic without applying it", () => {
    expect(suggestedEquivalent("clinic", "general-outpatient")).toBe("hc2");
    expect(defaultLevelStatus("clinic")).toBe("not-yet-assigned");
    const level = resolveLevel({ serviceCategory: "clinic", serviceSubtype: "general-outpatient", levelStatus: "medveris-equivalent", equivalentLevel: "hc2" });
    expect(level).toMatchObject({ levelStatus: "medveris-equivalent", equivalentLevel: "hc2", officialLevel: null });
    const display = describeLevel(level);
    expect(display.official).toBe(false);
    expect(display.label).toContain("Medveris equivalent — confirm service scope");
    expect(display.source).toContain("not a Ministry of Health or NHFR designation");
  });

  it("allows a different clinic equivalent only with a justification from the registered scope", () => {
    expect(() => resolveLevel({ serviceCategory: "clinic", serviceSubtype: "general-outpatient", levelStatus: "medveris-equivalent", equivalentLevel: "hc3" }))
      .toThrow(DomainError);
    const level = resolveLevel({
      serviceCategory: "clinic", serviceSubtype: "general-outpatient", levelStatus: "medveris-equivalent", equivalentLevel: "hc3",
      equivalentJustification: "Registered maternity unit and laboratory on site",
    });
    expect(level.equivalentLevel).toBe("hc3");
  });

  it("never infers a hospital level and accepts only a registered Level 5, 6 or 7 designation", () => {
    expect(() => resolveLevel({ serviceCategory: "hospital", levelStatus: "medveris-equivalent", equivalentLevel: "general-hospital" })).toThrow(/never inferred/);
    expect(() => resolveLevel({ serviceCategory: "hospital", levelStatus: "official", officialLevel: "hc4", officialLevelSource: "nhfr", officialLevelReference: "NHFR-1" }))
      .toThrow(DomainError);
    expect(() => resolveLevel({ serviceCategory: "hospital", levelStatus: "official", officialLevel: "regional-referral" })).toThrow(/official level comes from/);
    const level = resolveLevel({ serviceCategory: "hospital", serviceSubtype: "specialised", levelStatus: "official", officialLevel: "regional-referral", officialLevelSource: "nhfr", officialLevelReference: "NHFR-123" });
    expect(describeLevel(level)).toMatchObject({ official: true, status: "official" });
    expect(describeLevel(level).source).toContain("NHFR-123");
    expect(resolveLevel({ serviceCategory: "hospital", levelStatus: "not-yet-assigned" }).levelStatus).toBe("not-yet-assigned");
  });

  it("shows standalone service businesses as having no standalone care level", () => {
    for (const category of ["drug-shop", "pharmacy", "dental", "laboratory", "imaging", "ophthalmology", "specialty-service"]) {
      expect(defaultLevelStatus(category)).toBe("not-applicable");
      expect(describeLevel(resolveLevel({ serviceCategory: category, levelStatus: "not-applicable" })).label).toBe(NO_STANDALONE_LEVEL_LABEL);
      expect(() => resolveLevel({ serviceCategory: category, levelStatus: "medveris-equivalent", equivalentLevel: "hc2" })).toThrow(DomainError);
    }
    expect(() => resolveLevel({ serviceCategory: "clinic", levelStatus: "not-applicable" })).toThrow(DomainError);
  });

  it("keeps a confirmed official level for a standalone service", () => {
    const level = resolveLevel({ serviceCategory: "laboratory", levelStatus: "official", officialLevel: "hc3", officialLevelSource: "moh-registration", officialLevelReference: "REG-77" });
    expect(level.officialLevel).toBe("hc3");
  });

  it("lets a unit inside a facility inherit the host level for roll-ups only", () => {
    const host = resolveLevel({ serviceCategory: "hospital", levelStatus: "official", officialLevel: "general-hospital", officialLevelSource: "nhfr", officialLevelReference: "NHFR-9" });
    const inherited = rollUpLevel(host);
    expect(inherited.inherited).toBe(true);
    expect(inherited.source).toMatch(/^Inherited from the host facility for roll-ups/);
  });

  it("recommends modules and HMIS forms without treating a level as proof of a service", () => {
    const shop = recommendModules("drug-shop", { levelStatus: "not-applicable" });
    expect(shop.hmisCandidates).toEqual([]);
    expect(shop.modules).toContain("inventory");
    const hc4 = recommendModules("clinic", { levelStatus: "medveris-equivalent", equivalentLevel: "hc4" });
    expect(hc4.modules).toEqual(expect.arrayContaining(["inpatient", "theatre", "maternity"]));
    expect(hc4.notes[0]).toMatch(/does not prove a service is available/);
  });
});

describe("HMIS reporting periods", () => {
  it("parses DHIS2 monthly, quarterly and ISO weekly periods", () => {
    expect(parsePeriod("202602", "Monthly")).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(parsePeriod("2026Q4", "Quarterly")).toMatchObject({ start: "2026-10-01", end: "2026-12-31" });
    expect(parsePeriod("2026W1", "Weekly")).toMatchObject({ start: "2025-12-29", end: "2026-01-04" });
    expect(() => parsePeriod("202613", "Monthly")).toThrow(DomainError);
    expect(() => parsePeriod("2025W53", "Weekly")).toThrow(DomainError);
  });

  it("derives deadlines from a configurable rule", () => {
    const rule = { submissionDueDay: 7, validationStartDay: 8, validationEndDay: 15, lockAfterDay: 15, source: "test", verifiedOn: "2026-10-29" };
    const parsed = parsePeriod("202609", "Monthly");
    expect(periodSchedule(parsed, rule, "2026-10-05")).toMatchObject({ submissionDue: "2026-10-07", validationEnd: "2026-10-15", phase: "due" });
    expect(periodSchedule(parsed, rule, "2026-10-10").phase).toBe("validation");
    expect(periodSchedule(parsed, rule, "2026-10-29").phase).toBe("locked");
    expect(periodSchedule(parsed, rule, "2026-09-20").phase).toBe("open");
  });

  it("finds the most recently ended period", () => {
    expect(previousPeriod("Monthly", "2026-01-15")).toBe("202512");
    expect(previousPeriod("Quarterly", "2026-02-01")).toBe("2025Q4");
    expect(previousPeriod("Weekly", "2026-10-29")).toBe("2026W43");
  });
});
