import { expect } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

export const KAMPALA_TENANT = "11111111-1111-4111-8111-111111111111";
export const CLINICIAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export interface Session { cookie: string; csrf: string }

/**
 * Sign-in reopens the facility the user last worked in, or the only one; otherwise the user chooses, as the
 * facility selector does through /me/context. Switches to `tenantId` (Kampala by default) when it is one of them.
 */
export async function chooseFacility(app: { fetch(request: Request): Response | Promise<Response> }, session: Session, tenantId = KAMPALA_TENANT): Promise<void> {
  const facilities = await (await app.fetch(new Request("http://localhost/api/v1/me/facilities", { headers: { cookie: session.cookie } }))).json() as any;
  if (facilities.activeTenantId === tenantId || !facilities.facilities?.some((facility: { tenantId: string }) => facility.tenantId === tenantId)) return;
  const switched = await app.fetch(new Request("http://localhost/api/v1/me/context", {
    method: "POST",
    headers: { cookie: session.cookie, "x-medveris-csrf": session.csrf, "content-type": "application/json" },
    body: JSON.stringify({ tenantId }),
  }));
  expect(switched.status).toBe(200);
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

  async function json(response: Response): Promise<any> {
    const text = await response.text();
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
  async function login(email: string, tenantId = KAMPALA_TENANT): Promise<Session> {
    const challenge = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Medveris!2026" }),
    }));
    const body = await json(challenge);
    expect(challenge.status, JSON.stringify(body)).toBe(200);
    if (!body.mfaRequired) return { cookie: sessionCookie(challenge), csrf: body.csrfToken };
    const { code } = await json(await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`)));
    const mfa = await app.fetch(new Request("http://localhost/api/v1/auth/login/mfa", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: body.challengeId, code }),
    }));
    const verified = await json(mfa);
    expect(mfa.status, JSON.stringify(verified)).toBe(200);
    const session = { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
    await chooseFacility(app, session, tenantId);
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
