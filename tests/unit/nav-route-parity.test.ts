import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_TABS, NAV_DESTINATIONS, NAV_GROUPS, NAV_SECTIONS, PLATFORM_NAV } from "../../apps/web/src/lib/nav";
import { CASHIER_ROLES, INVENTORY_ROLES, PROCUREMENT_ROLES, VISIT_ROLES } from "../../apps/web/src/lib/roles";

/**
 * Narrative parity between the navigation SSOT (nav.ts) and the route table
 * (App.tsx). Navigation only decides what is worth showing; the route guard
 * is the authorization boundary. The critical contract is one-directional:
 * navigation must never advertise a role the guard denies (DX-01), while a
 * narrower presentation than the guard allows (queue workers vs all visit
 * roles) is legitimate and expected.
 */

interface RouteInfo {
  path: string;
  roles?: readonly string[];
  staff?: boolean;
  patient?: boolean;
  platform?: boolean;
  organization?: boolean;
  guarded: boolean;
}

const ROLE_SETS: Record<string, readonly string[]> = {
  INVENTORY_ROLES,
  PROCUREMENT_ROLES,
  VISIT_ROLES,
  CASHIER_ROLES,
};

const ROUTES: RouteInfo[] = (() => {
  const source = readFileSync(resolve(process.cwd(), "apps/web/src/App.tsx"), "utf8");
  const routes: RouteInfo[] = [];
  for (const line of source.split("\n")) {
    const pathMatch = line.match(/<Route path="([^"]+)"/);
    if (!pathMatch) continue;
    const info: RouteInfo = { path: pathMatch[1]!, guarded: false };
    const guard = line.match(/<ProtectedRoute\b([^>]*)>/);
    if (guard) {
      info.guarded = true;
      const attrs = guard[1] ?? "";
      const rolesMatch = attrs.match(/roles=\{(\[[^\]]*\]|[A-Za-z_$][\w$]*)\}/);
      if (rolesMatch) {
        const expression = rolesMatch[1]!;
        if (expression.startsWith("[")) {
          info.roles = [...expression.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
        } else {
          const resolved = ROLE_SETS[expression];
          if (!resolved) throw new Error(`Unresolved role constant ${expression} in App.tsx`);
          info.roles = resolved;
        }
      }
      for (const flag of ["staff", "patient", "platform", "organization"] as const) {
        if (new RegExp(`\\b${flag}\\b`).test(attrs)) info[flag] = true;
      }
    }
    routes.push(info);
  }
  return routes;
})();

const segments = (path: string) => path.replace(/^\//, "").split("/").filter((part) => part.length > 0);

function pathMatches(template: string, target: string): boolean {
  const left = segments(template);
  const right = segments(target);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => segment.startsWith(":") || segment === right[index]);
}

function findRoute(target: string): RouteInfo | undefined {
  return ROUTES.find((route) => pathMatches(route.path, target));
}

describe("front-door sections", () => {
  it("keeps the canonical 14 desktop sections and 5 mobile tabs", () => {
    expect(NAV_SECTIONS.map((section) => section.label)).toEqual([
      "Dashboard",
      "Reception & Billing",
      "OPD (Outpatient Care)",
      "Inpatient Care",
      "Theatre & Procedures",
      "Diagnostics",
      "Pharmacy",
      "Chronic & Community Care",
      "Virtual Care",
      "IoT & Remote Monitoring",
      "Facility & Location",
      "Administration",
      "Medveris Intelligence",
      "Patient Portal",
    ]);
    expect(MOBILE_TABS.map((tab) => tab.id)).toEqual(["home", "care", "analytics", "knowledge", "more"]);
  });

  it("Reception & Billing covers registration, appointments, check-in, and billing", () => {
    const ids = NAV_DESTINATIONS.filter((item) => item.section === "reception").map((item) => item.id);
    expect(ids).toEqual(["patients", "appointments", "exchange", "finance", "pos", "price-list"]);
    expect(NAV_DESTINATIONS.find((item) => item.id === "patients")?.activePrefixes).toEqual(["/visits", "/queues"]);
  });

  it("sidebar groups: Facility Operations, Management, Intelligence & Engagement", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "Facility Operations",
      "Facility Management",
      "Intelligence & Engagement",
    ]);
    const groupOf = (id: string) => NAV_SECTIONS.find((section) => section.id === id)?.group ?? null;
    expect(groupOf("dashboard")).toBeNull();
    expect(["reception", "outpatient", "inpatient", "theatre", "diagnostics", "pharmacy", "chronic", "virtual", "iot"].map(groupOf))
      .toEqual(Array(9).fill("operations"));
    expect(["facility", "administration"].map(groupOf)).toEqual(["management", "management"]);
    expect(["intelligence", "portal"].map(groupOf)).toEqual(["intelligence", "intelligence"]);
  });

  it("OPD (Outpatient Care) covers consultations, triage and follow-up", () => {
    const ids = NAV_DESTINATIONS.filter((item) => item.section === "outpatient").map((item) => item.id);
    expect(ids).toEqual(["worklist", "emergency", "care"]);
  });
});

describe("navigation ↔ route parity", () => {
  it("every navigation destination names an existing route", () => {
    const missing = NAV_DESTINATIONS.filter((item) => !findRoute(item.to)).map((item) => `${item.id} -> ${item.to}`);
    expect(missing).toEqual([]);
  });

  it("navigation never advertises a role the route guard denies", () => {
    const violations: string[] = [];
    for (const item of NAV_DESTINATIONS) {
      const route = findRoute(item.to);
      if (!route || !item.roles || !route.roles) continue;
      const extra = item.roles.filter((role) => !route.roles!.includes(role));
      if (extra.length) {
        violations.push(`${item.id}: nav allows ${extra.join(", ")} but route ${route.path} denies`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("platform operations stay separate from facility navigation", () => {
    for (const item of PLATFORM_NAV) {
      const route = findRoute(item.to);
      expect(route?.platform, `${item.to} must match a platform-guarded route`).toBe(true);
    }
    for (const item of NAV_DESTINATIONS) {
      const route = findRoute(item.to);
      expect(route?.platform, `facility destination ${item.id} must not point at a platform route`).not.toBe(true);
    }
  });

  it("patient-only destinations avoid staff-only routes and vice versa", () => {
    for (const item of NAV_DESTINATIONS) {
      const route = findRoute(item.to);
      if (!route) continue;
      if (item.staffOnly) expect(route.patient === true, `${item.id} is staffOnly but ${route.path} is patient-only`).toBe(false);
      if (item.patientOnly) expect(route.staff === true, `${item.id} is patientOnly but ${route.path} is staff-only`).toBe(false);
    }
  });

  it("organization destinations point at organization-guarded routes", () => {
    for (const item of NAV_DESTINATIONS.filter((entry) => entry.organization)) {
      const route = findRoute(item.to);
      expect(route?.organization, `${item.id} must point at an organization route`).toBe(true);
    }
  });

  it("DX-01 regression: Facility administration navigation matches the route guard exactly", () => {
    const navItem = NAV_DESTINATIONS.find((item) => item.id === "admin")!;
    const route = findRoute("/admin");
    expect(route).toBeDefined();
    expect([...(navItem.roles ?? [])].sort()).toEqual([...(route!.roles ?? [])].sort());
  });

  it("active prefixes resolve to their pages", () => {
    for (const item of NAV_DESTINATIONS) {
      for (const prefix of item.activePrefixes ?? []) {
        // A prefix is a page when it is either a list route itself (/visits)
        // or the parent of a detail route (/encounters/:id).
        expect(findRoute(prefix) ?? findRoute(`${prefix}/:id`), `${item.id} activePrefix ${prefix}`).toBeDefined();
      }
    }
  });
});
