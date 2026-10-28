import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { withContext } from "@medveris/db";
import { createHarness, KAMPALA_TENANT, type Session } from "./support.js";

const h = createHarness("invitations");
const PASSWORD = "Synthetic-Invitee-2026!";
const KAMPALA_NAME = "Kampala Community Clinic (synthetic)";

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

function uniqueEmail(label: string): string {
  return `${label}.${crypto.randomUUID()}@example.test`;
}

/** The token from the exact link emailed to `email` (most recent invitation). */
async function emailedLink(email: string): Promise<{ text: string; path: string; token: string }> {
  const files = (await readdir(h.mailDir).catch(() => [])).filter((name) => name.includes(email)).sort().reverse();
  for (const name of files) {
    const text = await readFile(join(h.mailDir, name), "utf8");
    const match = /http:\/\/localhost:5173(\/accept-invitation\?token=([A-Za-z0-9_-]+))/.exec(text);
    if (match) return { text, path: match[1]!, token: match[2]! };
  }
  throw new Error(`no invitation email for ${email}`);
}

async function anonymous(path: string, body: unknown): Promise<Response> {
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

function cookieFrom(response: Response): string {
  return (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="))!.split(";")[0]!;
}

async function invite(admin: Session, email: string, roles: string[] = ["receptionist"], extra: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  const created = await h.post(admin, "/api/v1/admin/invitations", { email, roles, ...extra });
  return { id: created.invitationId, token: (await emailedLink(email)).token };
}

async function status(token: string, session?: Session): Promise<{ code: number; body: any }> {
  const response = session
    ? await h.call(session, "/api/v1/auth/invitations/status", { method: "POST", body: JSON.stringify({ token }) })
    : await anonymous("/api/v1/auth/invitations/status", { token });
  return { code: response.status, body: await h.json(response) };
}

async function registerInvitee(token: string): Promise<Session> {
  const response = await anonymous("/api/v1/auth/invitations/register", { token, givenName: "Synthetic", familyName: "Invitee", password: PASSWORD });
  const body = await h.json(response);
  expect(response.status, JSON.stringify(body)).toBe(201);
  return { cookie: cookieFrom(response), csrf: body.csrfToken };
}

async function accept(session: Session, token: string, extra: Record<string, unknown> = {}): Promise<{ code: number; body: any }> {
  const response = await h.call(session, "/api/v1/auth/invitations/accept", { method: "POST", body: JSON.stringify({ token, ...extra }) });
  return { code: response.status, body: await h.json(response) };
}

async function signIn(email: string): Promise<{ session: Session; body: any }> {
  const response = await anonymous("/api/v1/auth/login", { email, password: PASSWORD });
  const body = await h.json(response);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { session: { cookie: cookieFrom(response), csrf: body.csrfToken }, body };
}

async function enrollMfa(session: Session): Promise<void> {
  const started = await h.post(session, "/api/v1/auth/mfa/enroll/start", {}, 200);
  await h.post(session, "/api/v1/auth/mfa/enroll/verify", { code: await totpCode(started.secret) }, 200);
}

async function registerFacility(): Promise<{ admin: Session; tenantId: string }> {
  const email = uniqueEmail("admin-b");
  const registered = await anonymous("/api/v1/auth/register/facility", {
    email, password: PASSWORD, givenName: "Synthetic", familyName: "Administrator", facilityName: "Synthetic Second Clinic",
  });
  const body = await h.json(registered);
  expect(registered.status, JSON.stringify(body)).toBe(201);
  const { session } = await signIn(email);
  await enrollMfa(session);
  return { admin: session, tenantId: body.facility.id };
}

async function membershipsFor(tenantId: string, email: string): Promise<any[]> {
  return withContext(h.sql, { tenantId, actorKind: "staff" }, async (tx) => tx`
    select m.id, m.roles, m.status from memberships m join users u on u.id = m.user_id
     where m.tenant_id = ${tenantId} and u.email = ${email}`);
}

async function acceptanceAudits(invitationEmail: string): Promise<number> {
  const rows = await withContext(h.sql, { tenantId: KAMPALA_TENANT, actorKind: "staff", roles: ["auditor"] }, async (tx) => tx`
    select count(*)::int as n from audit_events a join users u on u.id = a.actor_user_id
     where a.action = 'membership.accept-invitation' and u.email = ${invitationEmail}`);
  return Number(rows[0]?.n ?? 0);
}

let admin: Session;

beforeAll(async () => {
  admin = await h.login("admin@medveris.local");
});

describe("invitation link and confirmation", () => {
  it("emails a link to the dedicated confirmation route, and opening it accepts nothing", async () => {
    const email = uniqueEmail("link");
    const { token } = await invite(admin, email);
    const link = await emailedLink(email);
    expect(link.path).toBe(`/accept-invitation?token=${token}`);
    expect(link.text).toContain(KAMPALA_NAME);

    const viewed = await status(token);
    expect(viewed.code).toBe(200);
    expect(viewed.body).toMatchObject({
      status: "pending",
      facility: { name: KAMPALA_NAME, city: "Kampala", country: "Uganda" },
      roles: ["receptionist"],
      viewer: { authenticated: false, matchesRecipient: null },
      recipientHasAccount: false,
    });
    expect(viewed.body.invitedEmail).not.toBe(email);
    expect(JSON.stringify(viewed.body)).not.toContain(token);
    expect(await membershipsFor(KAMPALA_TENANT, email)).toEqual([]);
  });

  it("reports an unknown token as invalid without facility details", async () => {
    const viewed = await status("x".repeat(43));
    expect(viewed.code).toBe(404);
    expect(viewed.body.error.code).toBe("invitation_invalid");
  });
});

describe("accepting an invitation", () => {
  it("registers the invitee, then binds the explicitly accepted assignment to the inviter's facility", async () => {
    const email = uniqueEmail("accept");
    const { token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    expect(await membershipsFor(KAMPALA_TENANT, email)).toEqual([]);

    const viewed = await status(token, invitee);
    expect(viewed.body.viewer).toMatchObject({ authenticated: true, matchesRecipient: true });

    const accepted = await accept(invitee, token);
    expect(accepted.code, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({ outcome: "accepted", facility: { id: KAMPALA_TENANT, name: KAMPALA_NAME }, roles: ["receptionist"] });
    expect(await membershipsFor(KAMPALA_TENANT, email)).toEqual([expect.objectContaining({ roles: ["receptionist"], status: "active" })]);
    expect((await status(token, invitee)).body).toMatchObject({ status: "accepted", viewer: { acceptedByViewer: true } });

    const staff = await h.expectOk(await h.call(admin, "/api/v1/admin/memberships"));
    expect(staff.memberships).toEqual(expect.arrayContaining([expect.objectContaining({ email, roles: ["receptionist"], status: "active" })]));
    const invitations = await h.expectOk(await h.call(admin, "/api/v1/admin/invitations"));
    expect(invitations.invitations).toEqual(expect.arrayContaining([expect.objectContaining({ email, status: "accepted" })]));
  });

  it("ignores client-supplied facility and role fields when inviting and accepting", async () => {
    const other = await registerFacility();
    const email = uniqueEmail("override");
    const { token } = await invite(admin, email, ["receptionist"], { tenantId: other.tenantId, invitedBy: crypto.randomUUID() });
    expect((await status(token)).body.facility.name).toBe(KAMPALA_NAME);
    const invitee = await registerInvitee(token);
    const accepted = await accept(invitee, token, { tenantId: other.tenantId, roles: ["facility_admin"] });
    expect(accepted.code).toBe(200);
    expect(await membershipsFor(KAMPALA_TENANT, email)).toEqual([expect.objectContaining({ roles: ["receptionist"] })]);
    expect(await membershipsFor(other.tenantId, email)).toEqual([]);
  });

  it("refuses a different signed-in account and leaves the invitation pending", async () => {
    const email = uniqueEmail("intended");
    const { token } = await invite(admin, email);
    const stranger = await registerInvitee((await invite(admin, uniqueEmail("stranger"))).token);
    expect((await status(token, stranger)).body.viewer).toMatchObject({ authenticated: true, matchesRecipient: false });
    const attempt = await accept(stranger, token);
    expect(attempt.code).toBe(403);
    expect(attempt.body.error.code).toBe("invitation_recipient_mismatch");
    expect((await status(token)).body.status).toBe("pending");
    expect(await membershipsFor(KAMPALA_TENANT, email)).toEqual([]);
  });

  it("is idempotent for retries and safe under concurrent acceptance", async () => {
    const email = uniqueEmail("concurrent");
    const { token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    const results = await Promise.all(Array.from({ length: 5 }, () => accept(invitee, token)));
    expect(results.map((result) => result.code)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((result) => result.body.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((result) => result.body.outcome === "already-accepted")).toHaveLength(4);
    expect(await membershipsFor(KAMPALA_TENANT, email)).toHaveLength(1);
    expect(await acceptanceAudits(email)).toBe(1);
    expect((await accept(invitee, token)).body.outcome).toBe("already-accepted");
  });

  it("refuses to transfer an accepted invitation to another account", async () => {
    const email = uniqueEmail("taken");
    const { token } = await invite(admin, email);
    await accept(await registerInvitee(token), token);
    const stranger = await registerInvitee((await invite(admin, uniqueEmail("late"))).token);
    const attempt = await accept(stranger, token);
    expect(attempt.code).toBe(409);
    expect(attempt.body.error.code).toBe("invitation_accepted_by_other");
  });

  it("refuses an existing account to register again through the invitation", async () => {
    const email = uniqueEmail("existing");
    const { token } = await invite(admin, email);
    await registerInvitee(token);
    const again = await anonymous("/api/v1/auth/invitations/register", { token, givenName: "Dup", familyName: "Account", password: PASSWORD });
    expect(again.status).toBe(409);
    expect((await h.json(again)).error.code).toBe("invitation_account_exists");
  });
});

describe("invitations that cannot be accepted", () => {
  async function expectRefused(token: string, invitee: Session, code: string, email: string): Promise<void> {
    expect((await status(token)).body.status).toBe(code.replace("invitation_", ""));
    const attempt = await accept(invitee, token);
    expect(attempt.code).toBe(410);
    expect(attempt.body.error.code).toBe(code);
    expect(await membershipsFor(KAMPALA_TENANT, email)).toEqual([]);
  }

  it("refuses expired invitations", async () => {
    const email = uniqueEmail("expired");
    const { id, token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    await withContext(h.sql, { tenantId: KAMPALA_TENANT, actorKind: "staff" }, async (tx) => tx`update invitations set expires_at = now() - interval '1 minute' where id = ${id}`);
    await expectRefused(token, invitee, "invitation_expired", email);
  });

  it("refuses revoked invitations and lets only the issuing facility revoke", async () => {
    const email = uniqueEmail("revoked");
    const { id, token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    const other = await registerFacility();
    expect((await h.call(other.admin, `/api/v1/admin/invitations/${id}/revoke`, { method: "POST" })).status).toBe(404);
    await h.post(admin, `/api/v1/admin/invitations/${id}/revoke`, {}, 200);
    await expectRefused(token, invitee, "invitation_revoked", email);
    const listed = await h.expectOk(await h.call(admin, "/api/v1/admin/invitations"));
    expect(listed.invitations).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "revoked" })]));
  });

  it("refuses declined invitations", async () => {
    const email = uniqueEmail("declined");
    const { token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    await h.expectOk(await anonymous("/api/v1/auth/invitations/decline", { token }));
    await expectRefused(token, invitee, "invitation_declined", email);
  });

  it("refuses roles a facility administrator may not grant", async () => {
    for (const role of ["patient", "credential_reviewer", "proxy"]) {
      const response = await h.call(admin, "/api/v1/admin/invitations", { method: "POST", body: JSON.stringify({ email: uniqueEmail("role"), roles: [role] }) });
      expect(response.status, role).toBe(422);
    }
  });

  it("supersedes an earlier pending invitation to the same address", async () => {
    const email = uniqueEmail("resend");
    const first = await invite(admin, email);
    const second = await invite(admin, email);
    expect((await status(first.token)).body.status).toBe("revoked");
    expect((await status(second.token)).body.status).toBe("pending");
  });
});

describe("facility staff sign-in", () => {
  async function onboardedStaff(): Promise<{ email: string; session: Session }> {
    const email = uniqueEmail("staff");
    const { token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    expect((await accept(invitee, token)).code).toBe(200);
    await enrollMfa(invitee);
    return { email, session: invitee };
  }

  it("does not grant staff access before MFA onboarding is complete", async () => {
    const email = uniqueEmail("onboarding");
    const { token } = await invite(admin, email);
    const invitee = await registerInvitee(token);
    expect((await h.call(invitee, "/api/v1/queues")).status).toBe(403);
    await accept(invitee, token);
    await h.post(invitee, "/api/v1/me/context", { tenantId: KAMPALA_TENANT }, 200);
    expect((await h.call(invitee, "/api/v1/queues")).status).toBe(403);
  });

  it("resolves a single assignment automatically at sign-in", async () => {
    const { email } = await onboardedStaff();
    const challenge = await anonymous("/api/v1/auth/login", { email, password: PASSWORD });
    const challengeBody = await h.json(challenge);
    expect(challengeBody.mfaRequired).toBe(true);
    const { session } = await signInWithMfa(email, challengeBody.challengeId);
    const facilities = await h.expectOk(await h.call(session, "/api/v1/me/facilities"));
    expect(facilities.facilities).toEqual([expect.objectContaining({ tenantId: KAMPALA_TENANT, name: KAMPALA_NAME, roles: ["receptionist"] })]);
    expect(facilities.activeTenantId).toBe(KAMPALA_TENANT);
    expect((await h.call(session, "/api/v1/queues")).status).toBe(200);
  });

  it("asks users with several facilities to choose, and only among their own", async () => {
    const { email, session } = await onboardedStaff();
    const other = await registerFacility();
    const second = await h.post(other.admin, "/api/v1/admin/invitations", { email, roles: ["receptionist"] });
    expect(second.invitationId).toBeTruthy();
    expect((await accept(session, (await emailedLink(email)).token)).code).toBe(200);

    const challenge = await h.json(await anonymous("/api/v1/auth/login", { email, password: PASSWORD }));
    const { session: fresh, body } = await signInWithMfa(email, challenge.challengeId);
    expect(body.activeTenantId).toBeNull();
    const facilities = await h.expectOk(await h.call(fresh, "/api/v1/me/facilities"));
    expect(facilities.facilities.map((facility: any) => facility.tenantId).sort()).toEqual([KAMPALA_TENANT, other.tenantId].sort());
    expect(facilities.activeTenantId).toBeNull();
    expect((await h.call(fresh, "/api/v1/queues")).status).toBe(403);

    expect((await h.call(fresh, "/api/v1/me/context", { method: "POST", body: JSON.stringify({ tenantId: crypto.randomUUID() }) })).status).toBe(404);
    await h.post(fresh, "/api/v1/me/context", { tenantId: other.tenantId }, 200);
    expect((await h.call(fresh, "/api/v1/queues")).status).toBe(200);
  });

  it("denies staff access without an active assignment and explains a removed one", async () => {
    const { email, session } = await onboardedStaff();
    const staff = await h.expectOk(await h.call(admin, "/api/v1/admin/memberships"));
    const membership = staff.memberships.find((row: any) => row.email === email);
    await h.expectOk(await h.call(admin, `/api/v1/admin/memberships/${membership.id}`, { method: "DELETE" }));

    const challenge = await h.json(await anonymous("/api/v1/auth/login", { email, password: PASSWORD }));
    const { session: fresh } = await signInWithMfa(email, challenge.challengeId);
    const facilities = await h.expectOk(await h.call(fresh, "/api/v1/me/facilities"));
    expect(facilities.facilities).toEqual([]);
    expect(facilities.inactive).toEqual([expect.objectContaining({ name: KAMPALA_NAME, reason: "removed" })]);
    expect((await h.call(fresh, "/api/v1/me/context", { method: "POST", body: JSON.stringify({ tenantId: KAMPALA_TENANT }) })).status).toBe(404);
    expect((await h.call(fresh, "/api/v1/queues")).status).toBe(403);
    expect((await h.call(session, "/api/v1/queues")).status).toBe(403);
  });

  it("keeps facility staff lists isolated between facilities", async () => {
    const { email } = await onboardedStaff();
    const other = await registerFacility();
    const theirs = await h.expectOk(await h.call(other.admin, "/api/v1/admin/memberships"));
    expect(theirs.memberships.map((row: any) => row.email)).not.toContain(email);
    const theirInvitations = await h.expectOk(await h.call(other.admin, "/api/v1/admin/invitations"));
    expect(theirInvitations.invitations.map((row: any) => row.email)).not.toContain(email);
  });
});

async function signInWithMfa(email: string, challengeId: string): Promise<{ session: Session; body: any }> {
  const { code } = await h.json(await h.app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`)));
  const response = await anonymous("/api/v1/auth/login/mfa", { challengeId, code });
  const body = await h.json(response);
  expect(response.status, JSON.stringify(body)).toBe(200);
  return { session: { cookie: cookieFrom(response), csrf: body.csrfToken }, body };
}
