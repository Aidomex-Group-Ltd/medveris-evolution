import { describe, expect, it } from "vitest";
import {
  RADIOLOGY_CORE_REQUIRED,
  RADIOLOGY_TEMPLATE_CATALOGUE,
  canTransitionRadiologyReport,
  checkRadiologyContent,
  configureRadiologyTemplate,
  radiologyAccession,
  radiologyTemplate,
} from "@medveris/domain";

describe("radiology template catalogue", () => {
  it("covers the required examinations with unique codes", () => {
    expect(RADIOLOGY_TEMPLATE_CATALOGUE.map((template) => template.code)).toEqual([
      "chest-xray", "abdominal-xray", "msk-xray", "ct-head", "ct-chest-abdomen", "mri-brain", "mri-spine",
      "us-abdomen", "us-pelvis", "us-obstetric", "doppler", "other",
    ]);
  });

  it("gives every template unique field keys, the core required fields and examination-specific findings", () => {
    for (const template of RADIOLOGY_TEMPLATE_CATALOGUE) {
      const keys = template.fields.map((field) => field.key);
      expect(new Set(keys).size, template.code).toBe(keys.length);
      for (const core of RADIOLOGY_CORE_REQUIRED) expect(template.fields.find((field) => field.key === core)?.required, `${template.code}.${core}`).toBe(true);
      expect(template.fields.some((field) => field.section === "findings"), template.code).toBe(true);
      expect(template.measurementUnits.length).toBeGreaterThan(0);
    }
  });

  it("never carries default finding text", () => {
    for (const template of RADIOLOGY_TEMPLATE_CATALOGUE) {
      for (const field of template.fields) expect(Object.keys(field)).not.toContain("default");
    }
  });
});

describe("report content validation", () => {
  const chest = radiologyTemplate("chest-xray")!;

  it("separates structural errors from incomplete required sections", () => {
    const empty = checkRadiologyContent(chest, { fields: {}, measurements: [] });
    expect(empty.invalid).toEqual([]);
    expect(empty.missing).toContain("Clinical indication");
    expect(empty.missing).toContain("Lungs and airways");
    expect(empty.missing).not.toContain("Lines, tubes and devices");
  });

  it("rejects unknown fields, invalid choices and measurements without allowed units", () => {
    const result = checkRadiologyContent(chest, {
      fields: { madeUp: "x", imageQuality: "excellent" },
      measurements: [{ label: "Nodule", value: 4, unit: "inches" }, { label: "", value: -1, unit: "mm" }],
    });
    expect(result.invalid).toEqual([
      "unknown field madeUp",
      "Image quality must be one of adequate, limited, non-diagnostic",
      "measurement 1 unit must be one of mm, cm",
      "measurement 2 needs a label",
      "measurement 2 needs a non-negative number",
    ]);
  });

  it("lets a facility require more fields but never fewer than the core", () => {
    const configured = configureRadiologyTemplate(chest, ["linesTubes"]);
    expect(configured.fields.find((field) => field.key === "linesTubes")?.required).toBe(true);
    expect(configured.fields.find((field) => field.key === "lungs")?.required).toBe(false);
    expect(configured.fields.find((field) => field.key === "impression")?.required).toBe(true);
    expect(() => configureRadiologyTemplate(chest, ["notAField"])).toThrow("Unknown template fields: notAField");
  });
});

describe("report lifecycle and accession", () => {
  it("allows signing only forward and never back to draft", () => {
    expect(canTransitionRadiologyReport("draft", "final")).toBe(true);
    expect(canTransitionRadiologyReport("preliminary", "final")).toBe(true);
    expect(canTransitionRadiologyReport("final", "corrected")).toBe(true);
    expect(canTransitionRadiologyReport("final", "draft")).toBe(false);
    expect(canTransitionRadiologyReport("final", "final")).toBe(false);
    expect(canTransitionRadiologyReport("cancelled", "final")).toBe(false);
  });

  it("formats accession numbers from the facility, date and random suffix", () => {
    expect(radiologyAccession("kampala-community", new Date("2026-10-28T09:00:00Z"), new Uint8Array([1, 171, 255]))).toBe("RAD-KAMP-20261028-01ABFF");
  });
});
