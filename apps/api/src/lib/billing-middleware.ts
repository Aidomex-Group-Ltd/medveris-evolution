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

/**
 * With BILLING_ENFORCEMENT=enforce, a workspace whose subscription is restricted, suspended, cancelled
 * or past its trial cannot use the growth and analytics features above. Patient records, clinical
 * history, care workflows, billing patients and paying Medveris are never blocked.
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
