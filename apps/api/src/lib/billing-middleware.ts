import type { MiddlewareHandler } from "hono";
import { withContext } from "@medveris/db";
import { metric } from "@medveris/platform";
import { accessModeFor, type RestrictedCapability } from "@medveris/domain";
import { tenantSubscriptionStatus } from "../services/subscriptions.js";
import { AppError } from "./errors.js";
import type { AppBindings, AppEnv } from "../types.js";

/** Features that pause while a subscription is restricted; everything else, including all care, continues. */
const RESTRICTED_ROUTES: ReadonlyArray<{ capability: RestrictedCapability; method: string; pattern: RegExp }> = [
  { capability: "staff-invitations", method: "POST", pattern: /^\/api\/v1\/admin\/invitations$/ },
  { capability: "staff-invitations", method: "POST", pattern: /^\/api\/v1\/organizations\/[0-9a-f-]{36}\/invitations$/ },
  { capability: "new-sites", method: "POST", pattern: /^\/api\/v1\/organizations\/[0-9a-f-]{36}\/sites$/ },
  { capability: "reports", method: "GET", pattern: /^\/api\/v1\/reports\/[^/]+$/ },
  { capability: "integrations", method: "POST", pattern: /^\/api\/v1\/integrations\/(applications|products)$/ },
];

const CAPABILITY_LABELS: Record<RestrictedCapability, string> = {
  "staff-invitations": "Inviting staff",
  "new-sites": "Adding sites",
  reports: "Running reports",
  integrations: "Adding integrations",
};

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Paths that must remain available while a facility subscription is restricted:
 * - auth/session, subscription recovery/payment, public callbacks, legal and health checks
 * - core patient-care, emergency documentation, and patient-billing/collection continuity
 *   (facility subscription must not compromise patient records or emergency-care documentation;
 *   billing patients and paying Medveris remain possible)
 * Read-only access remains available because only mutating operations are restricted.
 */
const RESTRICTED_MUTATION_ALLOWLIST: RegExp[] = [
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/me(?:\/|$)/,
  /^\/api\/v1\/billing(?:\/|$)/,
  /^\/api\/v1\/public(?:\/|$)/,
  /^\/api\/v1\/legal(?:\/|$)/,
  /^\/api\/health$/,
  /^\/api\/v1\/emergency(?:\/|$)/,
  /^\/api\/v1\/clinical(?:\/|$)/,
  /^\/api\/v1\/care(?:\/|$)/,
  /^\/api\/v1\/reception(?:\/|$)/,
  /^\/api\/v1\/workflow(?:\/|$)/,
  /^\/api\/v1\/consent(?:\/|$)/,
  /^\/api\/v1\/diagnostics(?:\/|$)/,
  /^\/api\/v1\/radiology(?:\/|$)/,
  /^\/api\/v1\/pharmacy(?:\/|$)/,
  /^\/api\/v1\/pharmacy-pos(?:\/|$)/,
  /^\/api\/v1\/inpatient(?:\/|$)/,
  /^\/api\/v1\/theatre(?:\/|$)/,
  /^\/api\/v1\/maternity(?:\/|$)/,
  /^\/api\/v1\/documents(?:\/|$)/,
  /^\/api\/v1\/devices(?:\/|$)/,
  /^\/api\/v1\/telehealth(?:\/|$)/,
  /^\/api\/v1\/programmes(?:\/|$)/,
  /^\/api\/v1\/operations(?:\/|$)/,
  /^\/api\/v1\/patient-merges(?:\/|$)/,
];

const RESTRICTED_FINANCE_CONTINUITY_ALLOWLIST: RegExp[] = [
  /^\/api\/v1\/finance\/encounters\/[0-9a-f-]{36}\/bill$/,
  /^\/api\/v1\/finance\/invoices$/,
  /^\/api\/v1\/finance\/invoices\/[0-9a-f-]{36}\/items\/[0-9a-f-]{36}\/remove$/,
  /^\/api\/v1\/finance\/invoices\/[0-9a-f-]{36}\/payments$/,
  /^\/api\/v1\/finance\/invoices\/[0-9a-f-]{36}\/cash$/,
  /^\/api\/v1\/finance\/invoices\/[0-9a-f-]{36}\/mobile-money$/,
  /^\/api\/v1\/finance\/mobile-money\/[0-9a-f-]{36}\/check$/,
  /^\/api\/v1\/finance\/claims$/,
];

/** Internal: exported for policy-classification unit tests only; not part of the public API. */
export const POLICY_TABLES = { RESTRICTED_ROUTES, RESTRICTED_MUTATION_ALLOWLIST, RESTRICTED_FINANCE_CONTINUITY_ALLOWLIST } as const;

export function isAllowlistedWhileRestricted(method: string, path: string): boolean {
  if (RESTRICTED_MUTATION_ALLOWLIST.some((pattern) => pattern.test(path))) return true;
  if (path.startsWith("/api/v1/finance")) {
    return method === "POST" && RESTRICTED_FINANCE_CONTINUITY_ALLOWLIST.some((pattern) => pattern.test(path));
  }
  return false;
}

/**
 * With BILLING_ENFORCEMENT=enforce, a workspace whose subscription is restricted, suspended, cancelled
 * or past its trial cannot use protected mutating functionality or restricted growth features.
 * Read access, authentication/session, subscription recovery/payment, public callbacks and health checks
 * remain available. Backend enforcement is authoritative (UI restrictions are not sufficient).
 */
export function subscriptionGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get("deps");
    const auth = c.get("auth");
    if (deps?.config.billing.enforcement === "enforce" && auth?.activeTenant) {
      const route = RESTRICTED_ROUTES.find((candidate) => candidate.method === c.req.method && candidate.pattern.test(c.req.path));
      if (route) {
        const status = await tenantSubscriptionStatus(c, auth.activeTenant.id);
        if (accessModeFor(status) === "restricted") {
          throw new AppError(402, "subscription_restricted",
            `${CAPABILITY_LABELS[route.capability]} is paused until the subscription is brought up to date. Patient records and care workflows are not affected.`,
            { capability: route.capability, status });
        }
      } else if (!READ_ONLY_METHODS.has(c.req.method) && !isAllowlistedWhileRestricted(c.req.method, c.req.path)) {
        const status = await tenantSubscriptionStatus(c, auth.activeTenant.id);
        if (accessModeFor(status) === "restricted") {
          throw new AppError(402, "subscription_restricted",
            "This workspace subscription is not active. Protected changes are paused until the subscription is brought up to date. Read access and essential care/billing continuity remain available.",
            { status, path: c.req.path, method: c.req.method });
        }
      }
    }
    await next();
  };
}

function byteLength(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Measures each authenticated API request for its workspace: wall-clock processing time and request and
 * response bytes. Quantities only; no path, patient, payload or user is recorded. Measurements are added
 * to an hourly bucket after the response is ready and never fail the request.
 */
export function usageMeter(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const deps = c.get("deps");
    const tenantId = c.get("auth")?.activeTenant?.id;
    if (!deps?.config.billing.usageMetering || !tenantId) return;
    const computeMs = Math.max(0, Math.round(performance.now() - started));
    const ingress = byteLength(c.req.header("content-length") ?? null);
    let egress = byteLength(c.res.headers.get("content-length"));
    if (!egress && /json|text/.test(c.res.headers.get("content-type") ?? "")) {
      egress = (await c.res.clone().arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
    }
    const record = withContext(deps.sql, { actorKind: "system", tenantId }, async (tx) => {
      await tx`select app.record_request_usage(${tenantId}, ${computeMs}, ${ingress}, ${egress})`;
    }).catch((error: unknown) => {
      metric("billing.usage_record_failed", 1, { code: String((error as { code?: unknown }).code ?? "") });
    });
    const waitUntil = (c.env as AppBindings | undefined)?.waitUntil;
    if (waitUntil) waitUntil(record);
    else await record;
  };
}
