import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  randomToken,
  sha256Hex,
  totpCode,
  verifyPassword,
  verifyTotp,
} from "@medveris/auth";
import {
  invitationAcceptSchema,
  loginSchema,
  mfaEnrollVerifySchema,
  mfaLoginSchema,
  passwordForgotSchema,
  passwordResetSchema,
  registerFacilitySchema,
  registerPatientSchema,
  verifyEmailSchema,
} from "@medveris/contracts";
import { randomPatientPublicId } from "@medveris/domain";
import { withAnonymous, withContext, withRegistration } from "@medveris/db";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../lib/errors.js";
import { auditMeta, parseJson, requestMeta } from "../lib/http.js";
import { rateLimit, clientKey } from "../lib/rate-limit.js";
import { writeAudit } from "../lib/audit.js";
import { setSessionCookie, revokeCurrentSession } from "../auth/middleware.js";
import { createSession, loadAuthContext, SESSION_COOKIE } from "../auth/session.js";
import type { Tx } from "@medveris/db";
import type { AppEnv } from "../types.js";

export const authRoutes = new Hono<AppEnv>();

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${base || "facility"}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
}

async function firstTenantId(sql: Parameters<typeof withRegistration>[0], userId: string): Promise<string | null> {
  return withContext(sql, { userId, actorKind: "staff" }, async (tx) => {
    const rows = await tx`select tenant_id from memberships where user_id = ${userId} and status = 'active' order by created_at limit 1`;
    return (rows[0]?.tenantId as string | undefined) ?? null;
  });
}

async function createEmailToken(
  tx: Tx,
  userId: string,
  purpose: "verify-email" | "reset-password",
): Promise<{ token: string; id: string }> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  await tx`
    insert into email_tokens (id, user_id, purpose, token_hash, expires_at)
    values (${id}, ${userId}, ${purpose}, ${tokenHash}, ${new Date(Date.now() + 24 * 60 * 60 * 1000)})
  `;
  return { token, id };
}

async function deliver(c: Parameters<typeof setSessionCookie>[0], to: string, subject: string, text: string, tokenId: string, sqlUserScope: string) {
  const deps = c.get("deps");
  const result = await deps.email.send({ to, subject, text });
  await deps.sql`
    update email_tokens set delivery_status = ${result.delivered ? "delivered" : "failed"}, delivery_detail = ${result.detail}
     where id = ${tokenId} and user_id = ${sqlUserScope}
  `;
  return result;
}

authRoutes.post("/register/patient", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "register"), 10, 60_000);
  const body = await parseJson(c, registerPatientSchema);
  const meta = requestMeta(c);
  const userId = crypto.randomUUID();
  const patientId = crypto.randomUUID();
  const publicId = randomPatientPublicId();
  const passwordHash = await hashPassword(body.password);
  const emailToken = await withRegistration(deps.sql, async (tx) => {
    const existing = await tx`select id from users where email = ${body.email} limit 1`;
    if (existing.length) throw new ConflictError("An account with this email already exists");
    await tx`
      insert into users (id, email, password_hash, display_name, given_name, family_name)
      values (${userId}, ${body.email}, ${passwordHash}, ${`${body.givenName} ${body.familyName}`}, ${body.givenName}, ${body.familyName})
    `;
    await tx`
      insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, email, phone, created_via)
      values (${patientId}, ${publicId}, ${body.givenName}, ${body.familyName}, ${body.dateOfBirth}, ${body.sex},
        ${body.email}, ${body.phone || null}, 'self-registration')
    `;
    await tx`insert into patient_accounts (id, user_id, patient_id, verified_at) values (${crypto.randomUUID()}, ${userId}, ${patientId}, ${new Date()})`;
    const token = await createEmailToken(tx, userId, "verify-email");
    await writeAudit(tx, deps.config, {
      actorKind: "registration",
      actorUserId: userId,
      action: "patient.register",
      subjectPatientId: patientId,
      resourceType: "Patient",
      resourceId: patientId,
      ...meta,
      metadata: { publicId },
    });
    return token;
  });
  const delivery = await deliver(
    c,
    body.email,
    "Verify your Medveris email",
    `Welcome to Medveris. Verify your email: ${deps.config.origin}/verify-email?token=${emailToken.token}`,
    emailToken.id,
    userId,
  );
  return c.json({
    ok: true,
    patient: { publicId },
    verificationEmail: { delivered: delivery.delivered, detail: delivery.detail },
  }, 201);
});

authRoutes.post("/register/facility", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "facility-register"), 8, 60_000);
  const body = await parseJson(c, registerFacilitySchema);
  const userId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const passwordHash = await hashPassword(body.password);
  const meta = requestMeta(c);
  const emailToken = await withRegistration(deps.sql, async (tx) => {
    const existing = await tx`select id from users where email = ${body.email} limit 1`;
    if (existing.length) throw new ConflictError("An account with this email already exists");
    await tx`
      insert into users (id, email, password_hash, display_name, given_name, family_name)
      values (${userId}, ${body.email}, ${passwordHash}, ${`${body.givenName} ${body.familyName}`}, ${body.givenName}, ${body.familyName})
    `;
    await tx`
      insert into tenants (id, name, slug, facility_type, city, country, email)
      values (${tenantId}, ${body.facilityName}, ${slugify(body.facilityName)}, ${body.facilityType},
        ${body.city || null}, ${body.country}, ${body.email})
    `;
    await tx`
      insert into memberships (id, tenant_id, user_id, roles) values (${membershipId}, ${tenantId}, ${userId}, ${["facility_admin"]})
    `;
    const token = await createEmailToken(tx, userId, "verify-email");
    await writeAudit(tx, deps.config, {
      tenantId,
      actorKind: "registration",
      actorUserId: userId,
      action: "facility.register",
      resourceType: "Organization",
      resourceId: tenantId,
      ...meta,
      metadata: { facilityName: body.facilityName },
    });
    return token;
  });
  const delivery = await deliver(
    c,
    body.email,
    "Verify your Medveris facility email",
    `Your facility is registered. Verify your email: ${deps.config.origin}/verify-email?token=${emailToken.token}`,
    emailToken.id,
    userId,
  );
  return c.json({
    ok: true,
    facility: { id: tenantId, name: body.facilityName },
    verificationEmail: { delivered: delivery.delivered, detail: delivery.detail },
  }, 201);
});

authRoutes.post("/login", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "login"), 12, 60_000);
  const body = await parseJson(c, loginSchema);
  const rows = await deps.sql`
    select id, email, password_hash, display_name, mfa_enrolled_at, status, totp_secret_enc
      from users where email = ${body.email} limit 1
  `;
  const user = rows[0];
  const ok = user ? await verifyPassword(body.password, String(user.passwordHash)) : false;
  if (!user || !ok || user.status !== "active") {
    await withAnonymous(deps.sql, async (tx) => {
      await writeAudit(tx, deps.config, {
        actorKind: "anonymous",
        action: "auth.login",
        decision: "deny",
        reasonCode: "invalid_credentials",
        ...auditMeta(c),
      });
    });
    throw new UnauthorizedError("Email or password is incorrect");
  }
  if (user.mfaEnrolledAt) {
    if (!user.totpSecretEnc) throw new ForbiddenError("MFA is configured incorrectly; contact support");
    const challengeId = crypto.randomUUID();
    await deps.sql`
      insert into auth_challenges (id, user_id, purpose, expires_at) values (${challengeId}, ${user.id}, 'login-mfa', ${new Date(Date.now() + 5 * 60_000)})
    `;
    return c.json({ mfaRequired: true, challengeId });
  }
  const activeTenantId = await firstTenantId(deps.sql, user.id);
  const meta = requestMeta(c);
  const session = await createSession(deps.sql, deps.config, user.id, {
    mfaVerified: false,
    activeTenantId,
    ...meta,
  });
  setSessionCookie(c, session);
  return c.json({ ok: true, csrfToken: session.csrfToken, activeTenantId: session.activeTenantId, mfaEnrollmentRequired: Boolean(activeTenantId) });
});

authRoutes.post("/login/mfa", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "login-mfa"), 15, 60_000);
  const body = await parseJson(c, mfaLoginSchema);
  const challenges = await deps.sql`
    select ch.id, ch.user_id, u.totp_secret_enc, u.status
      from auth_challenges ch join users u on u.id = ch.user_id
     where ch.id = ${body.challengeId} and ch.purpose = 'login-mfa' and ch.consumed_at is null and ch.expires_at > now()
     limit 1
  `;
  const challenge = challenges[0];
  if (!challenge || challenge.status !== "active" || !challenge.totpSecretEnc) throw new UnauthorizedError("MFA challenge is invalid or expired");
  const secret = await decryptSecret(String(challenge.totpSecretEnc), deps.config.mfaEncryptionKey);
  const valid = await verifyTotp(secret, body.code);
  if (!valid) throw new UnauthorizedError("Invalid verification code");
  await deps.sql.begin(async (tx) => {
    const consumed = await tx`update auth_challenges set consumed_at = now() where id = ${body.challengeId} and consumed_at is null returning id`;
    if (!consumed.length) throw new UnauthorizedError("MFA challenge has already been used");
  });
  const activeTenantId = await firstTenantId(deps.sql, String(challenge.userId));
  const meta = requestMeta(c);
  const session = await createSession(deps.sql, deps.config, String(challenge.userId), {
    mfaVerified: true,
    activeTenantId,
    ...meta,
  });
  setSessionCookie(c, session);
  return c.json({ ok: true, csrfToken: session.csrfToken, activeTenantId: session.activeTenantId });
});

authRoutes.post("/logout", async (c) => {
  await revokeCurrentSession(c);
  return c.json({ ok: true });
});

authRoutes.get("/session", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ authenticated: false });
  const auth = await loadAuthContext(c.get("deps").sql, token);
  if (!auth) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ authenticated: false });
  }
  return c.json({
    authenticated: true,
    user: {
      id: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      emailVerified: Boolean(auth.user.emailVerifiedAt),
      mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
      mfaVerified: auth.mfaVerified,
    },
    memberships: auth.memberships.map((m) => ({ id: m.id, tenantId: m.tenantId, tenantName: m.tenantName, tenantSlug: m.tenantSlug, roles: m.roles })),
    activeTenant: auth.activeTenant,
    patientId: auth.patientId,
    platformRoles: auth.platformRoles,
    csrfToken: auth.session.csrfToken,
  });
});

authRoutes.post("/verify-email", async (c) => {
  const deps = c.get("deps");
  const body = await parseJson(c, verifyEmailSchema);
  const tokenHash = await sha256Hex(body.token);
  const rows = await deps.sql`
    select et.id, et.user_id from email_tokens et
     where et.token_hash = ${tokenHash} and et.purpose = 'verify-email' and et.consumed_at is null and et.expires_at > now()
     limit 1
  `;
  const token = rows[0];
  if (!token) throw new ValidationError("Verification link is invalid or expired");
  await deps.sql.begin(async (tx) => {
    await tx`update users set email_verified_at = now(), updated_at = now() where id = ${token.userId}`;
    await tx`update email_tokens set consumed_at = now() where id = ${token.id}`;
    await writeAudit(tx, deps.config, {
      actorKind: "registration",
      actorUserId: String(token.userId),
      action: "auth.email.verify",
      ...auditMeta(c),
    });
  });
  return c.json({ ok: true });
});

authRoutes.post("/verify-email/resend", async (c) => {
  const deps = c.get("deps");
  const auth = c.get("auth");
  if (!auth) throw new UnauthorizedError();
  if (auth.user.emailVerifiedAt) return c.json({ ok: true, alreadyVerified: true });
  rateLimit(clientKey(c.req.raw.headers, `resend:${auth.user.id}`), 3, 15 * 60_000);
  const token = await withContext(deps.sql, { actorKind: "registration" }, async (tx) => createEmailToken(tx, auth.user.id, "verify-email"));
  const delivery = await deliver(
    c,
    auth.user.email,
    "Verify your Medveris email",
    `Verify your email: ${deps.config.origin}/verify-email?token=${token.token}`,
    token.id,
    auth.user.id,
  );
  return c.json({ ok: true, delivered: delivery.delivered, detail: delivery.detail });
});

authRoutes.post("/forgot-password", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "forgot"), 6, 15 * 60_000);
  const body = await parseJson(c, passwordForgotSchema);
  const rows = await deps.sql`select id from users where email = ${body.email} and status = 'active' limit 1`;
  if (rows[0]) {
    const userId = String(rows[0].id);
    const token = await withContext(deps.sql, { actorKind: "registration" }, async (tx) => createEmailToken(tx, userId, "reset-password"));
    const delivery = await deliver(
      c,
      body.email,
      "Reset your Medveris password",
      `Reset your password: ${deps.config.origin}/reset-password?token=${token.token}`,
      token.id,
      String(rows[0].id),
    );
    return c.json({ ok: true, message: "If the account exists, a recovery message has been requested.", delivery: delivery.delivered ? "requested" : "provider-failed" });
  }
  return c.json({ ok: true, message: "If the account exists, a recovery message has been requested.", delivery: "requested" });
});

authRoutes.post("/reset-password", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "reset"), 8, 15 * 60_000);
  const body = await parseJson(c, passwordResetSchema);
  const tokenHash = await sha256Hex(body.token);
  const rows = await deps.sql`
    select id, user_id from email_tokens
     where token_hash = ${tokenHash} and purpose = 'reset-password' and consumed_at is null and expires_at > now() limit 1
  `;
  const token = rows[0];
  if (!token) throw new ValidationError("Recovery link is invalid or expired");
  const passwordHash = await hashPassword(body.password);
  await deps.sql.begin(async (tx) => {
    await tx`update users set password_hash = ${passwordHash}, updated_at = now() where id = ${token.userId}`;
    await tx`update email_tokens set consumed_at = now() where id = ${token.id}`;
    await tx`update sessions set revoked_at = now(), revoked_reason = 'password-reset' where user_id = ${token.userId} and revoked_at is null`;
    await writeAudit(tx, deps.config, {
      actorKind: "registration",
      actorUserId: String(token.userId),
      action: "auth.password.reset",
      ...auditMeta(c),
    });
  });
  return c.json({ ok: true });
});

authRoutes.post("/mfa/enroll/start", async (c) => {
  const deps = c.get("deps");
  const auth = c.get("auth");
  if (!auth) throw new UnauthorizedError();
  if (auth.user.mfaEnrolledAt) throw new ConflictError("MFA is already enrolled");
  const secret = generateTotpSecret();
  const encrypted = await encryptSecret(secret, deps.config.mfaEncryptionKey);
  await deps.sql`update users set totp_secret_enc = ${encrypted}, updated_at = now() where id = ${auth.user.id}`;
  const label = encodeURIComponent(`Medveris:${auth.user.email}`);
  return c.json({
    secret,
    otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Medveris&digits=6&period=30`,
    note: "Scan with an authenticator app, then verify a code. The secret is shown once.",
  });
});

authRoutes.post("/mfa/enroll/verify", async (c) => {
  const deps = c.get("deps");
  const auth = c.get("auth");
  if (!auth) throw new UnauthorizedError();
  const body = await parseJson(c, mfaEnrollVerifySchema);
  if (!auth.user.totpSecretEnc) throw new ValidationError("Start MFA enrolment first");
  const secret = await decryptSecret(auth.user.totpSecretEnc, deps.config.mfaEncryptionKey);
  if (!(await verifyTotp(secret, body.code))) throw new ValidationError("Invalid verification code");
  const recoveryCodes = Array.from({ length: 8 }, () => randomToken(9));
  const hashes = await Promise.all(recoveryCodes.map(async (code) => ({ hash: await sha256Hex(code), used: false })));
  await deps.sql.begin(async (tx) => {
    await tx`update users set mfa_enrolled_at = now(), recovery_codes = ${tx.json(hashes as never)}, updated_at = now() where id = ${auth.user.id}`;
    await tx`update sessions set mfa_verified_at = now() where id = ${auth.session.id}`;
    await writeAudit(tx, deps.config, {
      actorKind: "staff",
      actorUserId: auth.user.id,
      tenantId: auth.activeTenant?.id ?? null,
      action: "auth.mfa.enroll",
      ...auditMeta(c),
    });
  });
  return c.json({ ok: true, recoveryCodes, warning: "Store these recovery codes securely. They are shown once." });
});

authRoutes.post("/invitations/accept", async (c) => {
  const deps = c.get("deps");
  const body = await parseJson(c, invitationAcceptSchema);
  const tokenHash = await sha256Hex(body.token);
  const rows = await deps.sql`
    select i.id, i.tenant_id, i.email, i.roles, i.expires_at, i.accepted_at, t.name as tenant_name
      from invitations i join tenants t on t.id = i.tenant_id
     where i.token_hash = ${tokenHash} limit 1
  `;
  const invite = rows[0];
  if (!invite || invite.acceptedAt || new Date(invite.expiresAt as Date).getTime() <= Date.now()) {
    throw new ValidationError("Invitation is invalid or expired");
  }
  const existing = await deps.sql`select id, password_hash from users where email = ${invite.email} limit 1`;
  let userId: string;
  if (existing[0]) {
    const valid = await verifyPassword(body.password, String(existing[0].passwordHash));
    if (!valid) throw new UnauthorizedError("Existing account password is incorrect");
    userId = String(existing[0].id);
  } else {
    userId = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password);
    await deps.sql`
      insert into users (id, email, password_hash, display_name, given_name, family_name, email_verified_at)
      values (${userId}, ${invite.email}, ${passwordHash}, ${`${body.givenName} ${body.familyName}`}, ${body.givenName}, ${body.familyName}, now())
    `;
  }
  const membershipId = crypto.randomUUID();
  await deps.sql.begin(async (tx) => {
    await tx`
      insert into memberships (id, tenant_id, user_id, roles, invited_by)
      values (${membershipId}, ${invite.tenantId}, ${userId}, ${invite.roles}, ${null})
      on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active', updated_at = now()
    `;
    await tx`update invitations set accepted_at = now() where id = ${invite.id} and accepted_at is null`;
    await writeAudit(tx, deps.config, {
      tenantId: String(invite.tenantId),
      actorKind: "staff",
      actorUserId: userId,
      action: "membership.accept-invitation",
      resourceType: "Membership",
      resourceId: membershipId,
      ...auditMeta(c),
      metadata: { roles: invite.roles },
    });
  });
  const session = await createSession(deps.sql, deps.config, userId, {
    mfaVerified: false,
    activeTenantId: String(invite.tenantId),
    ...requestMeta(c),
  });
  setSessionCookie(c, session);
  return c.json({ ok: true, csrfToken: session.csrfToken, tenantId: invite.tenantId, mfaEnrollmentRequired: true });
});

authRoutes.get("/invitations/lookup", async (c) => {
  const deps = c.get("deps");
  const token = c.req.query("token") ?? "";
  if (!token) throw new ValidationError("Invitation token is required");
  const tokenHash = await sha256Hex(token);
  const rows = await deps.sql`
    select i.email, i.roles, i.expires_at, i.accepted_at, t.name as tenant_name
      from invitations i join tenants t on t.id = i.tenant_id
     where i.token_hash = ${tokenHash} limit 1
  `;
  const invite = rows[0];
  if (!invite || invite.acceptedAt || new Date(invite.expiresAt as Date).getTime() <= Date.now()) {
    throw new NotFoundError("Invitation is invalid or expired");
  }
  return c.json({ email: invite.email, roles: invite.roles, tenantName: invite.tenantName });
});

export async function sendInvitation(
  c: Parameters<typeof setSessionCookie>[0],
  input: { tenantId: string; email: string; roles: string[]; invitedBy: string; token: string; tokenId: string },
) {
  const deps = c.get("deps");
  const result = await deps.email.send({
    to: input.email,
    subject: "Medveris facility invitation",
    text: `You have been invited to join a Medveris facility. Accept: ${deps.config.origin}/accept-invitation?token=${input.token}`,
  });
  await deps.sql`update invitations set delivery_status = ${result.delivered ? "delivered" : "failed"} where id = ${input.tokenId}`;
  return result;
}

authRoutes.get("/totp/dev", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.devShowTotpSecrets || deps.config.appEnv === "production") throw new NotFoundError();
  const email = c.req.query("email") ?? "";
  const rows = await deps.sql`select totp_secret_enc from users where email = ${email} limit 1`;
  if (!rows[0]?.totpSecretEnc) throw new NotFoundError();
  const secret = await decryptSecret(String(rows[0].totpSecretEnc), deps.config.mfaEncryptionKey);
  return c.json({ secret, code: await totpCode(secret) });
});
