import { Hono, type Context, type MiddlewareHandler } from "hono";
import { setCookie } from "hono/cookie";
import { ShardRoutingError } from "@medveris/db";
import { ZodError } from "zod";
import { bodyLimit } from "hono/body-limit";
import { authMiddleware, READ_YOUR_WRITES_COOKIE } from "./auth/middleware.js";
import { httpCachePolicy } from "./lib/cache-policy.js";
import { DATABASE_RETRY_AFTER_SECONDS, isDatabaseUnavailable } from "./lib/db-health.js";
import { requestTelemetry, routeShape } from "./lib/observability.js";
import { enforceRateLimit, RateLimitedError, requestAddress } from "./lib/rate-limit.js";
import { AppError, nativeErrorBody } from "./lib/errors.js";
import { AuthzError } from "@medveris/authz";
import { DomainError } from "@medveris/domain";
import { operationOutcome } from "./fhir/router.js";
import type { AppBaseDeps, AppBindings, AppEnv } from "./types.js";
import { publicRoutes } from "./routes/public.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { adminRoutes } from "./routes/admin.js";
import { receptionRoutes } from "./routes/reception.js";
import { clinicalRoutes } from "./routes/clinical.js";
import { consentRoutes } from "./routes/consent.js";
import { credentialRoutes } from "./routes/credentials.js";
import { fhirRoutes } from "./fhir/router.js";
import { terminologyRoutes } from "./terminology/router.js";
import { inpatientRoutes } from "./routes/inpatient.js";
import { theatreRoutes } from "./routes/theatre.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { pharmacyRoutes } from "./routes/pharmacy.js";
import { financeRoutes } from "./routes/finance.js";
import { programmeRoutes } from "./routes/programmes.js";
import { telehealthRoutes } from "./routes/telehealth.js";
import { deviceRoutes } from "./routes/devices.js";
import { aiRoutes } from "./routes/ai.js";
import { emergencyRoutes } from "./routes/emergency.js";
import { careRoutes } from "./routes/care.js";
import { organizationRoutes } from "./routes/organization.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { documentRoutes } from "./routes/documents.js";
import { maternityRoutes } from "./routes/maternity.js";
import { operationsRoutes } from "./routes/operations.js";
import { contentRoutes } from "./routes/content.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { directoryRoutes } from "./routes/directory.js";
import { promotionRoutes } from "./routes/promotions.js";
import { integrationRoutes } from "./routes/integrations.js";
import { radiologyRoutes } from "./routes/radiology.js";
import { patientMergeRoutes } from "./routes/patient-merge.js";
import { reportRoutes } from "./routes/reports.js";
import { realtimeRoutes } from "./routes/realtime.js";
import { opsRoutes } from "./routes/ops.js";

function isFhirPath(path: string): boolean {
  return path.startsWith("/fhir/") || path.startsWith("/terminology/fhir/");
}

function fhirResponse(c: Context<AppEnv>, body: unknown, status: number) {
  const headers = new Headers({
    "content-type": "application/fhir+json; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
  });
  const retryAfter = c.res.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** After a successful write, this session reads its own data from the primary for a bounded time. */
function readYourWrites(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const deps = c.get("deps");
    if (!MUTATING.has(c.req.method) || c.res.status >= 400 || !c.get("auth") || !deps?.db?.hasReplica()) return;
    const windowMs = deps.config.database.readYourWritesMs;
    setCookie(c, READ_YOUR_WRITES_COOKIE, String(Date.now() + windowMs), {
      httpOnly: true, sameSite: "Strict", path: "/api", maxAge: Math.ceil(windowMs / 1000),
      secure: deps.config.origin.startsWith("https://"),
    });
  };
}

/** Session and facility-selection changes touch only the directory database, so they stay open during a tenant freeze. */
const FREEZE_EXEMPT = [/^\/api\/v1\/auth\//, /^\/api\/v1\/me\/context$/];

/**
 * While a facility is frozen or being moved between shards, its data must not change. Writes
 * with that facility active get 503 with Retry-After; reads continue. Unknown shard placement
 * fails closed through ShardRoutingError.
 */
function tenantWriteGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    const shards = c.get("deps")?.shards;
    if (auth?.activeTenant && shards && MUTATING.has(c.req.method) && !FREEZE_EXEMPT.some((pattern) => pattern.test(c.req.path))) {
      const decision = shards.resolve(auth.activeTenant.id, auth.activeTenant.shard ?? null);
      if (!decision.writable) {
        c.header("retry-after", "60");
        throw new AppError(503, "tenant_maintenance", "This facility is in a maintenance window; changes are paused. Try again shortly.");
      }
    }
    await next();
  };
}

/**
 * Coarse per-isolate request-volume guard (no coordination round trip). Endpoint policies such
 * as sign-in, recovery and search are enforced globally where they are handled.
 */
function requestVolumeGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path === "/api/v1/health/live") return next();
    const auth = c.get("auth");
    if (auth) await enforceRateLimit(c, "api.authenticated", auth.user.id);
    else await enforceRateLimit(c, "api.public", requestAddress(c));
    await next();
  };
}

export function createApp(deps: AppBaseDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestTelemetry({ sampleRate: deps.config.observability.requestLogSampleRate }));

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "no-referrer");
    c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  });

  app.use("*", httpCachePolicy());
  app.use("*", authMiddleware(deps));
  app.use("*", readYourWrites());
  app.use("*", tenantWriteGuard());
  app.use("/api/*", requestVolumeGuard());

  app.use(
    "*",
    bodyLimit({
      maxSize: Math.max(deps.config.maxUploadBytes, 2 * 1024 * 1024) + 64 * 1024,
      onError: (c) => {
        if (isFhirPath(c.req.path)) {
          return fhirResponse(c, operationOutcome("error", "too-costly", "Request body exceeds the configured size limit"), 413);
        }
        return c.json(
          { error: { code: "payload_too_large", message: "Request body exceeds the configured size limit" } },
          413,
        );
      },
    }),
  );

  app.route("/", fhirRoutes);
  app.route("/", terminologyRoutes);

  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1", publicRoutes);
  app.route("/api/v1", meRoutes);
  app.route("/api/v1", receptionRoutes);
  app.route("/api/v1", clinicalRoutes);
  app.route("/api/v1", consentRoutes);
  app.route("/api/v1", credentialRoutes);
  app.route("/api/v1", inpatientRoutes);
  app.route("/api/v1", theatreRoutes);
  app.route("/api/v1", diagnosticsRoutes);
  app.route("/api/v1", pharmacyRoutes);
  app.route("/api/v1", financeRoutes);
  app.route("/api/v1", programmeRoutes);
  app.route("/api/v1", telehealthRoutes);
  app.route("/api/v1", deviceRoutes);
  app.route("/api/v1", aiRoutes);
  app.route("/api/v1", emergencyRoutes);
  app.route("/api/v1", careRoutes);
  app.route("/api/v1", organizationRoutes);
  app.route("/api/v1", onboardingRoutes);
  app.route("/api/v1", documentRoutes);
  app.route("/api/v1", maternityRoutes);
  app.route("/api/v1", operationsRoutes);
  app.route("/api/v1", contentRoutes);
  app.route("/api/v1", inventoryRoutes);
  app.route("/api/v1", directoryRoutes);
  app.route("/api/v1", promotionRoutes);
  app.route("/api/v1", integrationRoutes);
  app.route("/api/v1", radiologyRoutes);
  app.route("/api/v1", patientMergeRoutes);
  app.route("/api/v1", reportRoutes);
  app.route("/api/v1", realtimeRoutes);
  app.route("/api/v1", opsRoutes);

  app.notFound((c) => {
    if (isFhirPath(c.req.path)) {
      return fhirResponse(c, operationOutcome("error", "not-found", "Interaction is not implemented"), 404);
    }
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "not_found", message: "Endpoint not found", correlationId: c.get("correlationId") } }, 404);
    }
    return c.text("Not found", 404);
  });

  app.onError((error, c) => {
    const correlation = c.get("correlationId") ?? crypto.randomUUID();
    if (error instanceof AuthzError) {
      const appError = new AppError(403, error.code, error.message);
      if (isFhirPath(c.req.path)) return fhirResponse(c, operationOutcome("error", "forbidden", appError.message), 403);
      return c.json(nativeErrorBody(c, appError), 403);
    }
    if (error instanceof ZodError) {
      const appError = new AppError(422, "validation_error", "Request validation failed");
      if (isFhirPath(c.req.path)) return fhirResponse(c, operationOutcome("error", "invalid", appError.message), 422);
      return c.json(nativeErrorBody(c, appError), 422);
    }
    if (error instanceof DomainError) {
      const appError = new AppError(422, "validation_error", error.message);
      if (isFhirPath(c.req.path)) return fhirResponse(c, operationOutcome("error", "invalid", appError.message), 422);
      return c.json(nativeErrorBody(c, appError), 422);
    }
    if (error instanceof ShardRoutingError) {
      const appError = new AppError(503, "tenant_unavailable", "This facility's records are temporarily unavailable");
      console.error(JSON.stringify({ event: "shard_routing_refused", correlationId: correlation, reason: error.reason }));
      c.header("retry-after", "60");
      if (isFhirPath(c.req.path)) return fhirResponse(c, operationOutcome("error", "transient", appError.message), 503);
      return c.json(nativeErrorBody(c, appError), 503);
    }
    if (isDatabaseUnavailable(error)) {
      const state = (c.env as AppBindings | undefined)?.requestState;
      if (state) state.databaseUnavailable = true;
      const appError = new AppError(503, "database_unavailable", "The service is temporarily unavailable. Try again shortly.");
      console.error(JSON.stringify({ event: "database_unavailable", correlationId: correlation, path: routeShape(c.req.path), errorCode: String((error as { code?: unknown }).code ?? "") }));
      c.header("retry-after", String(DATABASE_RETRY_AFTER_SECONDS));
      if (isFhirPath(c.req.path)) return fhirResponse(c, operationOutcome("error", "transient", appError.message), 503);
      return c.json(nativeErrorBody(c, appError), 503);
    }
    if (error instanceof RateLimitedError) c.header("retry-after", String(error.retryAfterSeconds));
    if (error instanceof AppError) {
      if (isFhirPath(c.req.path)) {
        const code = error.status === 401 ? "login" : error.status === 403 ? "forbidden" : error.status === 404 ? "not-found" : error.status === 409 ? "conflict" : error.status === 422 ? "invalid" : error.status === 429 ? "throttled" : error.status >= 500 ? "transient" : "processing";
        return fhirResponse(c, operationOutcome("error", code, error.message), error.status);
      }
      return c.json(nativeErrorBody(c, error), error.status as 400);
    }
    console.error(JSON.stringify({ event: "unhandled_error", correlationId: correlation, path: routeShape(c.req.path), message: (error as Error).message, stack: deps.config.appEnv === "production" ? undefined : (error as Error).stack }));
    if (isFhirPath(c.req.path)) {
      return fhirResponse(c, operationOutcome("error", "exception", "An unexpected error occurred"), 500);
    }
    return c.json({ error: { code: "internal_error", message: "An unexpected error occurred", correlationId: correlation } }, 500);
  });

  return app;
}
