import type { ModuleCode } from "@medveris/domain";

interface RouteModule {
  prefixes: readonly string[];
  modules: readonly ModuleCode[];
}

/**
 * Front-end pages that belong to one module. Mirrors the API guard in
 * `apps/api/src/lib/unit-modules.ts`; shared pages such as patients, visits, queues and encounters
 * are absent because several modules use them.
 */
const ROUTE_MODULES: readonly RouteModule[] = [
  { prefixes: ["/pharmacy", "/pharmacy-pos", "/work-queues/pharmacy"], modules: ["pharmacy"] },
  { prefixes: ["/laboratory", "/work-queues/laboratory"], modules: ["laboratory"] },
  { prefixes: ["/radiology", "/work-queues/imaging"], modules: ["radiology"] },
  { prefixes: ["/diagnostics"], modules: ["laboratory", "radiology"] },
  { prefixes: ["/wards", "/operations"], modules: ["inpatient"] },
  { prefixes: ["/theatre", "/work-queues/theatre"], modules: ["theatre"] },
  { prefixes: ["/emergency"], modules: ["emergency"] },
  { prefixes: ["/maternity"], modules: ["maternity"] },
  { prefixes: ["/inventory", "/procurement"], modules: ["inventory"] },
  { prefixes: ["/finance", "/pos", "/price-list"], modules: ["finance"] },
  { prefixes: ["/programmes"], modules: ["programmes"] },
  { prefixes: ["/public-health", "/ehmis"], modules: ["public-health"] },
];

export function modulesRequiredByPath(path: string): readonly ModuleCode[] | null {
  for (const route of ROUTE_MODULES) {
    if (route.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return route.modules;
    }
  }
  return null;
}
