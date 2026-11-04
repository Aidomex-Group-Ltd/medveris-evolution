import type { MiddlewareHandler } from "hono";
import type { ModuleCode } from "@medveris/domain";
import { effectiveModulesFor } from "../auth/middleware.js";
import { ForbiddenError } from "./errors.js";
import type { AppEnv } from "../types.js";

interface ModuleRoute {
  pattern: RegExp;
  modules: readonly ModuleCode[];
}

/**
 * API prefixes that belong to one clinical or administrative module. A prefix is only listed when
 * every route under it is module-specific; shared routes (patients, encounters, appointments,
 * queues) are deliberately absent because several modules legitimately use them.
 *
 * Diagnostics is shared by laboratory and imaging, so its prefixes accept either module.
 */
const MODULE_ROUTES: readonly ModuleRoute[] = [
  { pattern: /^\/api\/v1\/medicines(?:\/|$)/, modules: ["pharmacy"] },
  { pattern: /^\/api\/v1\/medication-orders(?:\/|$)/, modules: ["pharmacy"] },
  { pattern: /^\/api\/v1\/medication-administrations(?:\/|$)/, modules: ["pharmacy"] },
  { pattern: /^\/api\/v1\/dispenses(?:\/|$)/, modules: ["pharmacy"] },
  { pattern: /^\/api\/v1\/stock(?:\/|$)/, modules: ["pharmacy"] },
  { pattern: /^\/api\/v1\/pharmacy(?:\/|$)/, modules: ["pharmacy"] },

  { pattern: /^\/api\/v1\/lab-tests(?:\/|$)/, modules: ["laboratory"] },
  { pattern: /^\/api\/v1\/lab-results(?:\/|$)/, modules: ["laboratory"] },
  { pattern: /^\/api\/v1\/specimens(?:\/|$)/, modules: ["laboratory"] },
  { pattern: /^\/api\/v1\/diagnostic-orders(?:\/|$)/, modules: ["laboratory", "radiology"] },
  { pattern: /^\/api\/v1\/diagnostic-reports(?:\/|$)/, modules: ["laboratory", "radiology"] },
  { pattern: /^\/api\/v1\/diagnostic-reporting(?:\/|$)/, modules: ["laboratory", "radiology"] },
  { pattern: /^\/api\/v1\/critical-communications(?:\/|$)/, modules: ["laboratory", "radiology"] },
  { pattern: /^\/api\/v1\/imaging-studies(?:\/|$)/, modules: ["radiology"] },
  { pattern: /^\/api\/v1\/radiology(?:\/|$)/, modules: ["radiology"] },

  { pattern: /^\/api\/v1\/wards(?:\/|$)/, modules: ["inpatient"] },
  { pattern: /^\/api\/v1\/beds(?:\/|$)/, modules: ["inpatient"] },
  { pattern: /^\/api\/v1\/admissions(?:\/|$)/, modules: ["inpatient"] },
  { pattern: /^\/api\/v1\/theatres(?:\/|$)/, modules: ["theatre"] },
  { pattern: /^\/api\/v1\/theatre-cases(?:\/|$)/, modules: ["theatre"] },
  { pattern: /^\/api\/v1\/maternity(?:\/|$)/, modules: ["maternity"] },
  { pattern: /^\/api\/v1\/emergency(?:\/|$)/, modules: ["emergency"] },

  { pattern: /^\/api\/v1\/inventory(?:\/|$)/, modules: ["inventory"] },
  { pattern: /^\/api\/v1\/procurement(?:\/|$)/, modules: ["inventory"] },
  { pattern: /^\/api\/v1\/programmes(?:\/|$)/, modules: ["programmes"] },
  { pattern: /^\/api\/v1\/enrolments(?:\/|$)/, modules: ["programmes"] },
  { pattern: /^\/api\/v1\/care-plans(?:\/|$)/, modules: ["programmes"] },
  { pattern: /^\/api\/v1\/public-health(?:\/|$)/, modules: ["public-health"] },
  { pattern: /^\/api\/v1\/ehmis(?:\/|$)/, modules: ["public-health"] },
];

export function modulesRequiredByPath(path: string): readonly ModuleCode[] | null {
  return MODULE_ROUTES.find((route) => route.pattern.test(path))?.modules ?? null;
}

/**
 * Enforces the unit profile at the API boundary. Unauthenticated calls fall through so the route's
 * own `requireStaff` still answers 401; only a resolved active workspace is checked.
 */
export function unitModuleGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const required = modulesRequiredByPath(c.req.path);
    const auth = c.get("auth");
    if (required && auth?.activeTenant) {
      const available = effectiveModulesFor(auth);
      if (!required.some((module) => available.includes(module))) {
        throw new ForbiddenError("This module is not available for this workspace");
      }
    }
    await next();
  };
}
