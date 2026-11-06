import { expect } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

export const KAMPALA_TENANT = "11111111-1111-4111-8111-111111111111";

export const KAMPALA_FACILITY_SLUG = "kampala-general";
export const CLINICIAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export interface Session { cookie: string; csrf: string }

/**
 * Sign-in reopens the facility the user last worked in, or the only one; otherwise the user chooses, as the
 * facility selector does through /me/context. Switches to `tenantId` (Kampala by default) when it is one of them.
 * Setting an explicit facility slug helps when the account has multiple facilities and the test wants the
 * canonical one instead of whatever was last selected.
 *
 * Post-login sessions pick up whichever facility was active in the DB-backed session record; in the current
 * test data only Kampala has a facility selected, so all other tenants still end up on Kampala once the
 * context is switched. The artificial delay below prevents this route from racing with the auth rewrite.
 */
export async function chooseFacility(app: { fetch(request: Request): Response | Promise<Response> }, session: Session, tenantId = KAMPALA_TENANT, facilitySlug = KAMPALA_FACILITY_SLUG): Promise<void> {
  const facilities = await (await app.fetch(new Request("http://localhost/api/v1/me/facilities", { headers: { cookie: session.cookie } }))).json() as any;
  const listed: Array<{ tenantId: string }> = Array.isArray(facilities.facilities) ? facilities.facilities : [];
  // A platform operator or any account without an active facility assignment signs in with no
  // facility context; there is nothing to choose and /me/context would (correctly) refuse.
  if (listed.length === 0) return;
  if (facilities.activeTenantId === tenantId) return;
  // Never ask /me/context for a facility the account does not hold; leave the sign-in selection alone.
  if (!listed.some((facility) => facility.tenantId === tenantId)) return;
  const switched = await app.fetch(new Request("http://localhost/api/v1/me/context", {
    method: "POST",
    headers: { cookie: session.cookie, "x-medveris-csrf": session.csrf, "content-type": "application/json" },
    body: JSON.stringify({ tenantId, facilitySlug }),
  }));
  if (switched.status !== 200) {
    const body = (await switched.clone().json().catch(() => ({}))) as any;
    throw new Error(`chooseFacility(${tenantId}, ${facilitySlug}) failed: ${switched.status} ${JSON.stringify(body)}`);
  }
  // Defer body reads until after the auth route has settled to avoid a race with the new auth rewrite.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await switched.clone().text();
}

export interface HarnessOptions {
  /** Extra environment for loadConfig, e.g. integration settings. */
  env?: Record<string, string>;
  /** Dependencies built from the loaded config, e.g. a PACS client with a fake transport. */
  deps?: (config: AppConfig) => Partial<AppDeps>;
}

/** One app instance per test file against the local test database, with dev TOTP enabled. */
export function createHarness(label: string, options: HarnessOptions = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is required for ${label} tests`);
  const sql = createSql(url, { max: 8 });
  const config = loadConfig({ ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DEV_SHOW_TOTP_SECRETS: "true", ...options.env });
  config.terminologyMode = "synthetic";
  const tmp = process.env.TMPDIR ?? "/tmp";
  const mailDir = `${tmp}/medveris-${label}-mail-${crypto.randomUUID()}`;
  const deps: AppDeps = {
    sql,
    config,
    email: new LocalMailSink(mailDir),
    storage: new LocalStorage(`${tmp}/medveris-${label}-storage-${crypto.randomUUID()}`),
    ...options.deps?.(config),
  };
  const app = createApp(deps);

  /**
   * A platform operator or any account without an active facility assignment signs in with no
   * facility context, which is a valid state: /me/context only accepts a membership the account
   * really holds. Everyone else is moved to the requested facility.
   */
  async function selectFacility(session: Session, tenantId: string, facilitySlug: string): Promise<void> {
    const facilities = await json(await app.fetch(new Request("http://localhost/api/v1/me/facilities", { headers: { cookie: session.cookie } })));
    const listed: Array<{ tenantId: string }> = Array.isArray(facilities.facilities) ? facilities.facilities : [];
    if (listed.length === 0) return;
    if (facilities.activeTenantId === tenantId) return;
    if (!listed.some((facility) => facility.tenantId === tenantId)) return;
    await chooseFacility(app, session, tenantId, facilitySlug);
  }

  async function json(response: Response): Promise<any> {
    const text = await response.text().catch(() => (response.status >= 500 ? "[server error]" : response.statusText));
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`expected JSON, received ${response.status}: ${text.slice(0, 500)}`);
    }
  }

  function sessionCookie(response: Response): string {
    const match = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="));
    if (!match) throw new Error("no session cookie");
    return match.split(";")[0]!;
  }

  /** Signs in; a user with several facilities chooses `tenantId` (Kampala by default), as the facility selector does. */
  async function login(email: string, tenantId = KAMPALA_TENANT, opts?: { facilitySlug?: string }): Promise<Session> {
    const wantedSlug = opts?.facilitySlug ?? KAMPALA_FACILITY_SLUG;
    const challenge = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ email, password: "Medveris!2026" }),
    }));
    const body = await json(challenge);
    expect(challenge.status, JSON.stringify(body)).toBe(200);
    // Dev TOTP users are pre-enrolled, so non-MFA logins land on the remembered/first membership;
    // choose the requested facility explicitly when it differs from what the session guessed.
    if (!body.mfaRequired) {
      const session = { cookie: sessionCookie(challenge), csrf: body.csrfToken };
      await selectFacility(session, tenantId, wantedSlug);
      return session;
    }
    const { code } = await json(await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`)));
    const mfa = await app.fetch(new Request("http://localhost/api/v1/auth/login/mfa", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: body.challengeId, code }),
    }));
    const verified = await json(mfa);
    expect(mfa.status, JSON.stringify(verified)).toBe(200);
    const session = { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
    await selectFacility(session, tenantId, wantedSlug);
    return session;
  }

  async function call(session: Session, path: string, init: RequestInit & { idempotencyKey?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", session.cookie);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(init.method ?? "GET")) headers.set("x-medveris-csrf", session.csrf);
    if (init.body) headers.set("content-type", "application/json");
    if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
    return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
  }

  async function expectOk(response: Response, status = 200): Promise<any> {
    const body = await json(response);
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  }

  async function post(session: Session, path: string, body: unknown, status = 201, idempotencyKey?: string): Promise<any> {
    return expectOk(await call(session, path, { method: "POST", body: JSON.stringify(body), idempotencyKey }), status);
  }

  async function registerPatient(session: Session, familyName = `Synthetic${Date.now()}`): Promise<string> {
    const created = await post(session, "/api/v1/reception/patients", {
      givenName: "Synthetic", familyName, dateOfBirth: "1990-01-01", sex: "female", identityConfidence: "confirmed-verbal",
    });
    return created.patient.patientId as string;
  }

  return { app, sql, config, mailDir, json, login, call, expectOk, post, registerPatient };
}
