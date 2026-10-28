import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { DatabaseRouter, withContext, withReadOnlyContext, type ReadRoute, type TenantContext, type Tx } from "@medveris/db";
import { metric } from "@medveris/platform";
import { isDatabaseUnavailable } from "../lib/db-health.js";
import { annotate } from "../lib/observability.js";
import type { ActorContext, Role } from "@medveris/authz";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";
import type { AppBaseDeps, AppBindings, AppDeps, AppEnv, AuthContext } from "../types.js";
import { loadAuthContext, revokeSession, SESSION_COOKIE, type NewSession } from "./session.js";

export function setSessionCookie(c: Context<AppEnv>, session: NewSession): void {
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: c.get("deps").config.appEnv === "production" || c.get("deps").config.origin.startsWith("https://"),
    sameSite: "Strict",
    path: "/",
    maxAge: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function resolveDeps(c: Context<AppEnv>, deps: AppBaseDeps): AppDeps {
  const bound = (c.env as AppBindings | undefined)?.requestDeps;
  if (bound) return bound;
  if (!deps.sql) throw new Error("No database client is bound to this request");
  return { ...deps, sql: deps.sql };
}

export function authMiddleware(deps: AppBaseDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestDeps = resolveDeps(c, deps);
    c.set("deps", requestDeps);
    const token = getCookie(c, SESSION_COOKIE);
    let auth: AuthContext | null = null;
    if (token) {
      try {
        auth = await loadAuthContext(requestDeps.sql, token);
      } catch {
        auth = null;
      }
    }
    c.set("auth", auth);
    if (auth && ["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && isCsrfProtected(c.req.path)) {
      const supplied = c.req.header(requestDeps.config.csrfHeader) ?? "";
      if (!supplied || supplied !== auth.session.csrfToken) {
        throw new ForbiddenError("CSRF validation failed");
      }
    }
    await next();
  };
}

function isCsrfProtected(path: string): boolean {
  if (path.startsWith("/auth/login") || path.startsWith("/auth/register") || path.startsWith("/auth/forgot") || path.startsWith("/auth/reset")) return false;
  if (path.startsWith("/api/v1/auth/login") || path.startsWith("/api/v1/auth/register") || path.startsWith("/api/v1/auth/forgot") || path.startsWith("/api/v1/auth/reset")) return false;
  if (path.startsWith("/api/v1/auth/verify-email")) return false;
  // Read-only: shows an invitation for the emailed token and changes nothing.
  if (path === "/api/v1/auth/invitations/status") return false;
  return path.startsWith("/api/") || path.startsWith("/fhir/") || path.startsWith("/terminology/");
}

export function requireAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw new UnauthorizedError();
  return auth;
}

export function requireStaff(c: Context<AppEnv>): AuthContext {
  const auth = requireAuth(c);
  if (!auth.activeTenant || !auth.memberships.some((m) => m.tenantId === auth.activeTenant?.id)) {
    throw new ForbiddenError("An active facility context is required");
  }
  if (!auth.user.mfaEnrolledAt) {
    throw new ForbiddenError("Staff MFA enrolment is required before facility access");
  }
  if (!auth.mfaVerified) {
    throw new ForbiddenError("MFA verification is required for this session");
  }
  return auth;
}

export function requirePatient(c: Context<AppEnv>): AuthContext {
  const auth = requireAuth(c);
  if (!auth.patientId) throw new ForbiddenError("A verified patient account is required");
  return auth;
}

export function requirePlatformReviewer(c: Context<AppEnv>): AuthContext {
  const auth = requireAuth(c);
  if (!auth.platformRoles.includes("credential_reviewer")) {
    throw new ForbiddenError("Independent credential reviewer permission is required");
  }
  return auth;
}

export function isPlatformOperator(c: Context<AppEnv>): boolean {
  return requireAuth(c).platformRoles.includes("platform_operator");
}

export function actorFrom(auth: AuthContext): ActorContext {
  const roles: Role[] = auth.activeTenant?.roles ?? (auth.patientId ? ["patient"] : []);
  return {
    userId: auth.user.id,
    roles,
    tenantId: auth.activeTenant?.id ?? null,
    patientId: auth.patientId,
    mfaVerified: auth.mfaVerified,
    mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
    platformRoles: auth.platformRoles,
  };
}

function actorContext(auth: AuthContext): TenantContext {
  const actor = actorFrom(auth);
  return {
    tenantId: auth.activeTenant?.id ?? null,
    userId: auth.user.id,
    patientId: auth.patientId,
    actorKind: auth.activeTenant ? "staff" : auth.patientId ? "patient" : "staff",
    roles: actor.roles,
    platformRole: auth.platformRoles.includes("platform_operator")
      ? "platform_operator"
      : auth.platformRoles.includes("credential_reviewer") ? "credential_reviewer" : null,
  };
}

export async function withActor<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requireAuth(c);
  return withContext(c.get("deps").sql, actorContext(auth), fn);
}

export const READ_YOUR_WRITES_COOKIE = "mv_ryw";

function readYourWritesUntil(c: Context<AppEnv>): number | null {
  const value = Number(getCookie(c, READ_YOUR_WRITES_COOKIE));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read-only query for data that tolerates bounded staleness (approved reports, dashboards,
 * listings). It runs with the same RLS context as `withActor` inside a READ ONLY transaction,
 * on the replica only when the router measured it healthy, within the lag bound, and this
 * session has not written recently. A replica failure is retried once on the primary, which is
 * safe because the transaction cannot write. Never use this for authorization, consent or
 * clinical reads that must reflect the latest write.
 */
export async function withStaleTolerantRead<T>(
  c: Context<AppEnv>,
  options: { maxStalenessMs?: number },
  fn: (tx: Tx) => Promise<T>,
): Promise<{ value: T; route: Pick<ReadRoute, "target" | "reason" | "maxStalenessMs"> }> {
  const auth = requireAuth(c);
  const deps = c.get("deps");
  const router = deps.db ?? DatabaseRouter.primaryOnly(deps.sql);
  const route = await router.forRead({ consistency: "bounded-staleness", maxStalenessMs: options.maxStalenessMs, readYourWritesUntil: readYourWritesUntil(c) });
  const context = actorContext(auth);
  try {
    const value = await withReadOnlyContext(route.sql, context, fn);
    annotate(c, { dbRead: route.target, dbReadReason: route.reason });
    metric("db.read_route", 1, { target: route.target, reason: route.reason });
    return { value, route: { target: route.target, reason: route.reason, maxStalenessMs: route.maxStalenessMs } };
  } catch (error) {
    if (route.target !== "replica" || !isDatabaseUnavailable(error)) throw error;
    router.markReplicaFailed("query-failed");
    metric("db.read_route", 1, { target: "primary", reason: "replica-failed-fallback" });
    annotate(c, { dbRead: "primary", dbReadReason: "replica-failed-fallback" });
    const value = await withReadOnlyContext(deps.sql, context, fn);
    return { value, route: { target: "primary", reason: "replica-failed-fallback", maxStalenessMs: 0 } };
  }
}

export async function withPlatformActor<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requireAuth(c);
  if (!auth.platformRoles.includes("platform_operator")) {
    throw new ForbiddenError("Platform operator permission is required");
  }
  const deps = c.get("deps");
  return withContext(deps.sql, {
    tenantId: auth.activeTenant?.id ?? null,
    userId: auth.user.id,
    actorKind: "staff",
    roles: auth.activeTenant?.roles ?? [],
    platformRole: "platform_operator",
  }, fn);
}

/** Platform credential review runs as `credential_reviewer` even when the user also operates the platform. */
export async function withReviewerActor<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requirePlatformReviewer(c);
  return withContext(c.get("deps").sql, {
    tenantId: auth.activeTenant?.id ?? null,
    userId: auth.user.id,
    actorKind: "staff",
    roles: auth.activeTenant?.roles ?? [],
    platformRole: "credential_reviewer",
  }, fn);
}

export async function withStaffActor<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  requireStaff(c);
  return withActor(c, fn);
}

export async function revokeCurrentSession(c: Context<AppEnv>): Promise<void> {
  const auth = requireAuth(c);
  await revokeSession(c.get("deps").sql, auth.session.id, "user-logout");
  clearSessionCookie(c);
  // Open live-update connections would otherwise run until their own expiry.
  await c.get("deps").realtime?.revokeUser(auth.user.id, auth.memberships.map((m) => m.tenantId)).catch(() => undefined);
}
