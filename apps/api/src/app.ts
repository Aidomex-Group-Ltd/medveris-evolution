import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { bodyLimit } from "hono/body-limit";
import { authMiddleware } from "./auth/middleware.js";
import { AppError, nativeErrorBody } from "./lib/errors.js";
import { AuthzError } from "@medveris/authz";
import { DomainError } from "@medveris/domain";
import { operationOutcome } from "./fhir/router.js";
import type { AppDeps, AppEnv } from "./types.js";
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

function isFhirPath(path: string): boolean {
  return path.startsWith("/fhir/") || path.startsWith("/terminology/fhir/");
}

function fhirResponse(c: Context<AppEnv>, body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/fhir+json; charset=utf-8",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", authMiddleware(deps));

  app.use("*", async (c, next) => {
    const id = c.req.header("x-correlation-id") ?? crypto.randomUUID();
    c.set("correlationId", id);
    await next();
    c.header("x-correlation-id", id);
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "no-referrer");
    c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (isFhirPath(c.req.path) || c.req.path.startsWith("/api/")) {
      c.header("cache-control", "no-store, private");
    }
  });

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
    if (error instanceof AppError) {
      if (isFhirPath(c.req.path)) {
        const code = error.status === 401 ? "login" : error.status === 403 ? "forbidden" : error.status === 404 ? "not-found" : error.status === 409 ? "conflict" : error.status === 422 ? "invalid" : error.status === 429 ? "throttled" : error.status >= 500 ? "transient" : "processing";
        return fhirResponse(c, operationOutcome("error", code, error.message), error.status);
      }
      return c.json(nativeErrorBody(c, error), error.status as 400);
    }
    console.error(JSON.stringify({ event: "unhandled_error", correlationId: correlation, path: c.req.path, message: (error as Error).message, stack: deps.config.appEnv === "production" ? undefined : (error as Error).stack }));
    if (isFhirPath(c.req.path)) {
      return fhirResponse(c, operationOutcome("error", "exception", "An unexpected error occurred"), 500);
    }
    return c.json({ error: { code: "internal_error", message: "An unexpected error occurred", correlationId: correlation } }, 500);
  });

  return app;
}
