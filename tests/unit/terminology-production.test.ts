import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBreakers } from "@medveris/platform";
import { ProductionTerminologyAdapter } from "../../apps/api/src/terminology/production.js";
import { DependencyError } from "../../apps/api/src/lib/errors.js";

describe("Production terminology upstream failures (AT31)", () => {
  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetBreakers();
  });

  it("fails closed with a dependency error when the provider rejects the credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const adapter = new ProductionTerminologyAdapter("https://terminology.example/fhir", "expired-token", 500);
    await expect(adapter.validateCode({ system: "http://loinc.org", code: "8867-4" })).rejects.toBeInstanceOf(DependencyError);
  });

  it("fails closed with a dependency error when the provider times out", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const adapter = new ProductionTerminologyAdapter("https://terminology.example/fhir", null, 20);
    await expect(adapter.lookup("http://loinc.org", "8867-4")).rejects.toBeInstanceOf(DependencyError);
  });

  it("does not treat an unapproved production mapping as a translation", async () => {
    const adapter = new ProductionTerminologyAdapter("https://terminology.example/fhir", null, 500);
    await expect(adapter.translate({
      conceptMap: "https://terminology.example/fhir/ConceptMap/local-lab",
      system: "https://medveris.example/local-lab",
      code: "GLU",
      specimen: "Blood",
      method: "Enzymatic",
      unit: "mg/dL",
    })).rejects.toBeInstanceOf(DependencyError);
  });
});
