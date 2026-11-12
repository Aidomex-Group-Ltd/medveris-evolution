import type { NonPermissionEndpoint } from "../types/index.js";

/**
 * Intentional non-permission endpoints — explicitly listed so matrix coverage
 * can be audited without treating them as permission-protected.
 *
 * These are the routes that have authentication, rate-limit, flow-token or
 * self-scope controls but do not carry a canonical permission mapping.
 */
export const NON_PERMISSION_ENDPOINTS: readonly NonPermissionEndpoint[] = [
  {
    routeFile: "public.ts",
    routePatterns: ["GET /health/live", "GET /public/config", "GET /public/facilities", "GET /public/ai/status", "GET /public/terminology/status", "POST /public/terminology/status"],
    kind: "public",
    controls: ["intentional-public", "read-only", "rate-limit/cache"],
  },
  {
    routeFile: "ops.ts",
    routePatterns: ["GET /health/ready"],
    kind: "health",
    controls: ["intentional-public", "non-sensitive aggregate", "timeout"],
  },
  {
    routeFile: "legal.ts",
    routePatterns: ["GET /public/legal", "GET /public/legal/:kind"],
    kind: "public",
    controls: ["intentional-public", "published-release-digest"],
  },
  {
    routeFile: "legal.ts",
    routePatterns: ["GET /me/legal", "POST /me/legal/accept"],
    kind: "authenticated-self",
    controls: ["requireAuth", "self-scope", "append-only-acceptance"],
  },
  {
    routeFile: "payment-callbacks.ts",
    routePatterns: ["POST /public/payments/livepay/webhook", "POST /public/payments/yo/notifications", "POST /public/payments/yo/subscriptions", "POST /public/payments/yo/failures", "POST /public/payments/yo/subscriptions/failures"],
    kind: "webhook",
    controls: ["signature-verification", "provider-reference-tenant-resolution", "idempotency", "rate-limit"],
  },
  {
    routeFile: "auth.ts",
    routePatterns: ["POST /auth/login", "POST /auth/login/mfa", "POST /auth/register/patient", "POST /auth/register/workspace", "POST /auth/register/facility", "POST /auth/forgot-password", "POST /auth/reset-password", "POST /auth/verify-email", "POST /auth/login/mfa/email", "POST /auth/invitations/register", "POST /auth/invitations/accept", "POST /auth/invitations/status", "POST /auth/invitations/decline", "GET /auth/organizations/search", "POST /auth/join-codes/lookup"],
    kind: "flow-token",
    controls: ["rate-limit", "token-verification", "csrf-exemption-by-design", "server-side-tenant-resolution", "minimal-disclosure"],
  },
  {
    routeFile: "auth.ts",
    routePatterns: ["GET /auth/session", "POST /auth/logout", "POST /auth/mfa/enroll/start", "POST /auth/mfa/enroll/verify", "POST /auth/verify-email/resend", "GET /auth/totp/dev"],
    kind: "authenticated-self",
    controls: ["requireAuth", "self-scope", "session-revocation", "dev-only-guard"],
  },
  {
    routeFile: "me.ts",
    routePatterns: ["GET /me/sessions", "DELETE /me/sessions/:id", "GET /me/facilities", "POST /me/context", "GET /me/access-history"],
    kind: "authenticated-self",
    controls: ["requireAuth", "self-scope", "membership-validation", "audit"],
  },
  {
    routeFile: "notifications.ts",
    routePatterns: ["GET /notifications", "POST /notifications/:id/read"],
    kind: "authenticated-self",
    controls: ["requireAuth", "RLS-recipient-self-scope"],
  },
  {
    routeFile: "realtime.ts",
    routePatterns: ["POST /realtime/tickets", "GET /realtime/connect"],
    kind: "authenticated-self",
    controls: ["requireAuth", "MFA-when-tenant-active", "rate-limit", "server-derived-channel-scope"],
  },
];
