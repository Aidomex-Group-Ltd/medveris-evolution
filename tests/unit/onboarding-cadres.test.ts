import { describe, expect, it } from "vitest";
import {
  CADRE_GROUPS,
  UGANDA_CADRES,
  UGANDA_ONBOARDING_CATALOGUE,
  groupedCadres,
  parseOnboardingCatalogue,
} from "../../packages/domain/src/onboarding-catalogue.js";

describe("onboarding cadre picker", () => {
  it("ships every cadre with an empty, unreviewed ISCO-08 mapping", () => {
    expect(UGANDA_CADRES.length).toBeGreaterThan(0);
    for (const cadre of UGANDA_CADRES) {
      expect(cadre.isco08Code).toBeNull();
      expect(cadre.isco08Reviewed).toBe(false);
    }
  });

  it("groups every cadre exactly once under a display label", () => {
    const groups = groupedCadres(UGANDA_CADRES);
    const groupedCodes = groups.flatMap((group) => group.cadres.map((cadre) => cadre.code)).sort();
    expect(groupedCodes).toEqual(UGANDA_CADRES.map((cadre) => cadre.code).sort());
    expect(new Set(groups.map((group) => group.code)).size).toBe(groups.length);
    for (const group of groups) {
      expect(group.label.trim().length).toBeGreaterThan(0);
      expect(group.cadres.length).toBeGreaterThan(0);
    }
  });

  it("covers every category the seed uses", () => {
    const groupedCategories = new Set<string>(CADRE_GROUPS.flatMap((group) => [...group.categories]));
    const ungrouped = UGANDA_CADRES.map((cadre) => cadre.category).filter((category) => !groupedCategories.has(category));
    expect([...new Set(ungrouped)]).toEqual([]);
  });

  it("gives a cadre no role or permission field at all", () => {
    for (const cadre of UGANDA_CADRES) {
      for (const forbidden of ["roles", "suggestedSystemRoles", "permissions", "privilegeCodes"]) {
        expect(cadre).not.toHaveProperty(forbidden);
      }
    }
  });

  it("keeps a published catalogue's unreviewed cadres unreviewed", () => {
    const parsed = parseOnboardingCatalogue(UGANDA_ONBOARDING_CATALOGUE);
    expect(parsed.cadres.every((cadre) => cadre.isco08Code === null && cadre.isco08Reviewed === false)).toBe(true);
  });

  it("drops an invented review flag that has no code", () => {
    const payload = {
      ...UGANDA_ONBOARDING_CATALOGUE,
      cadres: UGANDA_ONBOARDING_CATALOGUE.cadres.map((cadre, index) =>
        index === 0 ? { ...cadre, isco08Code: null, isco08Reviewed: true } : cadre,
      ),
    };
    expect(parseOnboardingCatalogue(payload).cadres[0]!.isco08Reviewed).toBe(false);
  });
});
