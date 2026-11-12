import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../apps/api/src/routes");
const GUARD_MARKERS = [
  "requireAuth",
  "requireStaff",
  "requirePatient",
  "requirePlatformOperator",
  "requirePlatformReviewer",
  "withActor",
  "withStaffActor",
  "withPatientActor",
  "withPlatformActor",
  "withReviewerActor",
  "loadAuthContext",
  "verifyIntegratorToken",
];

/** Public surfaces, documented in the authorization matrix exemptions with their compensating controls. */
const PUBLIC_ROUTE_FILES: Record<string, RegExp[]> = {
  // Read-only public catalogue/config; the app-wide requestVolumeGuard caps per-isolate volume.
  "public.ts": [/\.get\(/],
  "payment-callbacks.ts": [/enforceRateLimit/, /signature|verify/i],
};

const routeFiles = readdirSync(ROUTES_DIR).filter((name) => name.endsWith(".ts")).sort();

describe("route authorization coverage", () => {
  it("inventories the expected route surface", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(50);
  });

  for (const file of routeFiles) {
    it(`${file} carries an authorization guard or is a documented public surface`, () => {
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      const allowlisted = PUBLIC_ROUTE_FILES[file];
      if (allowlisted) {
        for (const control of allowlisted) expect(source, `${file} must keep its compensating control`).toMatch(control);
        if (file === "public.ts") {
          const mutating = [...source.matchAll(/publicRoutes\.(post|put|patch|delete)\("([^"]+)"/g)].map((m) => m[2]);
          expect(mutating, "public.ts may only expose the rate-limited terminology probe").toEqual(["/public/terminology/status"]);
          expect(source, "public.ts terminology probe must stay rate-limited").toMatch(/enforceRateLimit/);
        }
        return;
      }
      const guarded = GUARD_MARKERS.some((marker) => source.includes(marker));
      expect(guarded, `${file} has no authorization guard marker and is not a documented public surface`).toBe(true);
    });
  }
});
