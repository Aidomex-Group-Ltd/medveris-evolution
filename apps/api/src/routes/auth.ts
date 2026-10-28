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
  invitationRegisterSchema,
  invitationTokenSchema,
  loginSchema,
  mfaEmailCodeSchema,
  mfaEnrollVerifySchema,
  mfaLoginSchema,
  passwordForgotSchema,
  passwordResetSchema,
  registerFacilitySchema,
  registerPatientSchema,
  verifyEmailSchema,
} from "@medveris/contracts";
import { randomPatientPublicId } from "@medveris/domain";
import { setLocalContext, withAnonymous, withContext, withRegistration } from "@medveris/db";
import { AppError, ConflictError, DependencyError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../lib/errors.js";
import { auditMeta, parseJson, requestMeta } from "../lib/http.js";
import { rateLimit, clientKey } from "../lib/rate-limit.js";
import { writeAudit } from "../lib/audit.js";
import { requireAuth, setSessionCookie, revokeCurrentSession } from "../auth/middleware.js";
import { acceptInvitation, declineInvitation, describeInvitation, maskEmail, registerInvitee } from "../services/invitations.js";
import { createSession, loadAuthContext, SESSION_COOKIE } from "../auth/session.js";
import type { Tx } from "@medveris/db";
import type { AppEnv } from "../types.js";

export const authRoutes = new Hono<AppEnv>();

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${base || "facility"}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
}

/** The facility a sign-in opens: only an unambiguous single active assignment; several require a choice. */
async function defaultTenantId(sql: Parameters<typeof withRegistration>[0], userId: string): Promise<string | null> {
  return withContext(sql, { userId, actorKind: "staff" }, async (tx) => {
    const rows = await tx`
      select m.tenant_id from memberships m join tenants t on t.id = m.tenant_id
       where m.user_id = ${userId} and m.status = 'active' and t.status = 'active' limit 2`;
    return rows.length === 1 ? String(rows[0]!.tenantId) : null;
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
    // memberships RLS only accepts rows for the current tenant; scope the rest of this transaction to the new one.
    await setLocalContext(tx, { actorKind: "registration", tenantId, userId });
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
  const activeTenantId = await defaultTenantId(deps.sql, user.id);
  const meta = requestMeta(c);
  const session = await createSession(deps.sql, deps.config, user.id, {
    mfaVerified: false,
    activeTenantId,
    ...meta,
  });
  setSessionCookie(c, session);
  return c.json({ ok: true, csrfToken: session.csrfToken, activeTenantId: session.activeTenantId, mfaEnrollmentRequired: Boolean(activeTenantId) });
});

const EMAIL_CODE_TTL_MS = 10 * 60_000;
const EMAIL_CODE_RESEND_MS = 30_000;
const EMAIL_CODE_MAX_SENDS = 3;
const MFA_MAX_FAILED_ATTEMPTS = 5;
const CHALLENGE_EXPIRED = "Sign-in has expired. Enter your email and password again.";

function sixDigitCode(): string {
  // Largest multiple of 1,000,000 below 2^32, so every code is equally likely.
  const limit = 4_294_000_000;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0]! >= limit);
  return String(value[0]! % 1_000_000).padStart(6, "0");
}

function emailCodeHash(challengeId: string, code: string): Promise<string> {
  return sha256Hex(`login-email-code:${challengeId}:${code}`);
}

interface RecoveryCode { hash: string; used: boolean }

authRoutes.post("/login/mfa/email", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "login-mfa-email"), 6, 15 * 60_000);
  const body = await parseJson(c, mfaEmailCodeSchema);
  const rows = await deps.sql`
    select ch.id, ch.user_id, ch.email_code_sends, ch.email_code_sent_at, ch.failed_attempts, u.email, u.status
      from auth_challenges ch join users u on u.id = ch.user_id
     where ch.id = ${body.challengeId} and ch.purpose = 'login-mfa' and ch.consumed_at is null and ch.expires_at > now()
     limit 1
  `;
  const challenge = rows[0];
  if (!challenge || challenge.status !== "active" || Number(challenge.failedAttempts) >= MFA_MAX_FAILED_ATTEMPTS) {
    throw new UnauthorizedError(CHALLENGE_EXPIRED);
  }
  const sends = Number(challenge.emailCodeSends);
  if (sends >= EMAIL_CODE_MAX_SENDS) throw new AppError(429, "rate_limited", "Too many codes requested. Enter your email and password again to request another.");
  if (challenge.emailCodeSentAt && Date.now() - new Date(challenge.emailCodeSentAt as Date).getTime() < EMAIL_CODE_RESEND_MS) {
    throw new AppError(429, "rate_limited", "A code was sent a moment ago. Wait 30 seconds before requesting another.");
  }
  const code = sixDigitCode();
  const sentAt = new Date();
  const expiresAt = new Date(sentAt.getTime() + EMAIL_CODE_TTL_MS);
  const updated = await deps.sql`
    update auth_challenges
       set email_code_hash = ${await emailCodeHash(String(challenge.id), code)}, email_code_expires_at = ${expiresAt},
           email_code_sent_at = ${sentAt}, email_code_sends = email_code_sends + 1, expires_at = greatest(expires_at, ${expiresAt})
     where id = ${challenge.id} and consumed_at is null and email_code_sends = ${sends}
     returning id
  `;
  if (!updated.length) throw new ConflictError("Another code was requested at the same time. Check your email.");
  const to = String(challenge.email);
  const result = await deps.email.send({
    to,
    subject: `${code} is your Medveris sign-in code`,
    text: `Your Medveris sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in, someone may know your password. Reset it at ${deps.config.origin}/forgot-password.`,
  });
  await withAnonymous(deps.sql, async (tx) => {
    await writeAudit(tx, deps.config, {
      actorKind: "anonymous",
      actorUserId: String(challenge.userId),
      action: "auth.mfa.email-code.send",
      decision: result.delivered ? "allow" : "deny",
      reasonCode: result.delivered ? null : "delivery_failed",
      ...auditMeta(c),
      metadata: { adapter: result.adapter, detail: result.detail },
    });
  });
  if (!result.delivered) throw new DependencyError("The sign-in code could not be emailed. Try again shortly or use your authenticator app.");
  return c.json({ ok: true, sentTo: maskEmail(to), expiresAt: expiresAt.toISOString() });
});

authRoutes.post("/login/mfa", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "login-mfa"), 15, 60_000);
  const body = await parseJson(c, mfaLoginSchema);
  const challenges = await deps.sql`
    select ch.id, ch.user_id, ch.failed_attempts, ch.email_code_hash, ch.email_code_expires_at,
           u.totp_secret_enc, u.recovery_codes, u.status
      from auth_challenges ch join users u on u.id = ch.user_id
     where ch.id = ${body.challengeId} and ch.purpose = 'login-mfa' and ch.consumed_at is null and ch.expires_at > now()
     limit 1
  `;
  const challenge = challenges[0];
  if (!challenge || challenge.status !== "active" || Number(challenge.failedAttempts) >= MFA_MAX_FAILED_ATTEMPTS) {
    throw new UnauthorizedError(CHALLENGE_EXPIRED);
  }
  let method: "totp" | "email" | "recovery" | null = null;
  let recoveryHash: string | null = null;
  if (/^\d{6}$/.test(body.code)) {
    if (challenge.totpSecretEnc) {
      const secret = await decryptSecret(String(challenge.totpSecretEnc), deps.config.mfaEncryptionKey);
      if (await verifyTotp(secret, body.code)) method = "totp";
    }
    if (!method && challenge.emailCodeHash && new Date(challenge.emailCodeExpiresAt as Date).getTime() > Date.now()
      && (await emailCodeHash(String(challenge.id), body.code)) === challenge.emailCodeHash) {
      method = "email";
    }
  } else {
    const hash = await sha256Hex(body.code);
    const codes = (challenge.recoveryCodes ?? []) as RecoveryCode[];
    if (codes.some((entry) => entry.hash === hash && !entry.used)) {
      method = "recovery";
      recoveryHash = hash;
    }
  }
  if (!method) {
    const failed = await deps.sql`
      update auth_challenges set failed_attempts = failed_attempts + 1 where id = ${challenge.id} returning failed_attempts
    `;
    if (Number(failed[0]?.failedAttempts ?? MFA_MAX_FAILED_ATTEMPTS) >= MFA_MAX_FAILED_ATTEMPTS) throw new UnauthorizedError(`Too many incorrect codes. ${CHALLENGE_EXPIRED}`);
    throw new UnauthorizedError("Invalid verification code");
  }
  const userId = String(challenge.userId);
  await deps.sql.begin(async (tx) => {
    const consumed = await tx`
      update auth_challenges set consumed_at = now(), verified_method = ${method} where id = ${body.challengeId} and consumed_at is null returning id
    `;
    if (!consumed.length) throw new UnauthorizedError("MFA challenge has already been used");
    if (recoveryHash) {
      const users = await tx`select recovery_codes from users where id = ${userId} for update`;
      const codes = (users[0]?.recoveryCodes ?? []) as RecoveryCode[];
      if (!codes.some((entry) => entry.hash === recoveryHash && !entry.used)) throw new UnauthorizedError("Recovery code has already been used");
      const next = codes.map((entry) => (entry.hash === recoveryHash ? { ...entry, used: true } : entry));
      await tx`update users set recovery_codes = ${tx.json(next as never)}, updated_at = now() where id = ${userId}`;
    }
    // Receiving the code proves the user controls the address.
    if (method === "email") await tx`update users set email_verified_at = coalesce(email_verified_at, now()) where id = ${userId}`;
  });
  if (method !== "totp") {
    await withAnonymous(deps.sql, async (tx) => {
      await writeAudit(tx, deps.config, {
        actorKind: "anonymous",
        actorUserId: userId,
        action: method === "email" ? "auth.mfa.email-code.verify" : "auth.mfa.recovery-code.use",
        ...auditMeta(c),
      });
    });
  }
  const activeTenantId = await defaultTenantId(deps.sql, String(challenge.userId));
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
    // Delivery failures are recorded on the token only; the response must not reveal whether the account exists.
    await deliver(
      c,
      body.email,
      "Reset your Medveris password",
      `Reset your password: ${deps.config.origin}/reset-password?token=${token.token}`,
      token.id,
      userId,
    );
  }
  return c.json({ ok: true, message: "If an account exists for this email, a password reset link has been sent." });
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
    const consumed = await tx`update email_tokens set consumed_at = now() where id = ${token.id} and consumed_at is null returning id`;
    if (!consumed.length) throw new ValidationError("Recovery link is invalid or expired");
    await tx`
      update email_tokens set consumed_at = now()
       where user_id = ${token.userId} and purpose = 'reset-password' and consumed_at is null
    `;
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

authRoutes.post("/invitations/status", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "invitation-status"), 60, 60_000);
  const body = await parseJson(c, invitationTokenSchema);
  const auth = c.get("auth");
  return c.json(await describeInvitation(deps.sql, body.token, auth ? { id: auth.user.id, email: auth.user.email } : null));
});

authRoutes.post("/invitations/register", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "invitation-register"), 20, 60_000);
  const body = await parseJson(c, invitationRegisterSchema);
  rateLimit(`invitation-register:${await sha256Hex(body.token)}`, 5, 15 * 60_000);
  if (c.get("auth")) throw new AppError(409, "invitation_signed_in", "Sign out before creating a new account for this invitation");
  const { userId } = await registerInvitee(deps.sql, deps.config, { ...body, meta: auditMeta(c) });
  const session = await createSession(deps.sql, deps.config, userId, { mfaVerified: false, activeTenantId: null, ...requestMeta(c) });
  setSessionCookie(c, session);
  return c.json({ ok: true, csrfToken: session.csrfToken }, 201);
});

authRoutes.post("/invitations/accept", async (c) => {
  const deps = c.get("deps");
  const auth = requireAuth(c);
  rateLimit(clientKey(c.req.raw.headers, `invitation-accept:${auth.user.id}`), 20, 60_000);
  if (auth.user.mfaEnrolledAt && !auth.mfaVerified) throw new ForbiddenError("Complete two-step verification before accepting the invitation");
  const body = await parseJson(c, invitationTokenSchema);
  const accepted = await acceptInvitation(deps.sql, deps.config, {
    token: body.token,
    user: { id: auth.user.id, email: auth.user.email },
    meta: auditMeta(c),
  });
  return c.json({ ok: true, ...accepted });
});

authRoutes.post("/invitations/decline", async (c) => {
  const deps = c.get("deps");
  rateLimit(clientKey(c.req.raw.headers, "invitation-decline"), 20, 60_000);
  const body = await parseJson(c, invitationTokenSchema);
  await declineInvitation(deps.sql, deps.config, { token: body.token, userId: c.get("auth")?.user.id ?? null, meta: auditMeta(c) });
  return c.json({ ok: true });
});

authRoutes.get("/totp/dev", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.devShowTotpSecrets || deps.config.appEnv === "production") throw new NotFoundError();
  const email = c.req.query("email") ?? "";
  const rows = await deps.sql`select totp_secret_enc from users where email = ${email} limit 1`;
  if (!rows[0]?.totpSecretEnc) throw new NotFoundError();
  const secret = await decryptSecret(String(rows[0].totpSecretEnc), deps.config.mfaEncryptionKey);
  return c.json({ secret, code: await totpCode(secret) });
});
