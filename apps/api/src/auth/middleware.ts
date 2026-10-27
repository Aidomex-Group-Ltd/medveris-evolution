import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { withContext, type Tx } from "@medveris/db";
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

export async function withActor<T>(c: Context<AppEnv>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requireAuth(c);
  const deps = c.get("deps");
  const actor = actorFrom(auth);
  const actorKind = auth.activeTenant ? "staff" : auth.patientId ? "patient" : "staff";
  return withContext(deps.sql, {
    tenantId: auth.activeTenant?.id ?? null,
    userId: auth.user.id,
    patientId: auth.patientId,
    actorKind,
    roles: actor.roles,
    platformRole: auth.platformRoles.includes("platform_operator")
      ? "platform_operator"
      : auth.platformRoles.includes("credential_reviewer") ? "credential_reviewer" : null,
  }, fn);
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
}
