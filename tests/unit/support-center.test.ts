import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Support Center hidden-route contract", () => {
  const navSource = readFileSync(join(root, "apps/web/src/lib/nav.ts"), "utf8");
  const navDestinations = readFileSync(join(root, "apps/web/src/lib/navigation.ts"), "utf8");
  const appSource = readFileSync(join(root, "apps/web/src/App.tsx"), "utf8");
  const pageSource = readFileSync(join(root, "apps/web/src/pages/SupportCenterPage.tsx"), "utf8");

  it("registers the route behind the platform gate", () => {
    expect(appSource).toContain('path="support-center"');
    expect(appSource).toMatch(/path="support-center" element=\{<ProtectedRoute platform>/);
  });

  it("is absent from every navigation area (public, patient, provider and platform)", () => {
    for (const [name, source] of [["nav.ts", navSource], ["navigation.ts", navDestinations]] as const) {
      expect(source, `${name} must not reference the hidden route`).not.toContain("support-center");
    }
  });

  it("binds only operator-gated support-center and observability APIs", () => {
    expect(pageSource).toContain("/support-center/");
    expect(pageSource).toContain("/platform/observability/");
    for (const forbidden of ["/api/v1/reception", "/api/v1/patients", "/api/v1/clinical"]) {
      expect(pageSource).not.toContain(forbidden);
    }
  });
});
