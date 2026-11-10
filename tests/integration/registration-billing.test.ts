import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, withContext } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { chooseFacility } from "./support.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for registration billing tests");
const sql = createSql(url, { max: 5 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DEV_SHOW_TOTP_SECRETS: "true",
});
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-regbill-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-regbill-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

interface Session { cookie: string; csrf: string }

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const match = cookies.find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error(`no session cookie in ${cookies.join(", ")}`);
  return match.split(";")[0]!;
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`expected JSON, received ${response.status}: ${text.slice(0, 300)}`); }
}

async function login(email: string): Promise<Session> {
  const challenge = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Medveris!2026" }),
  }));
  expect(challenge.status).toBe(200);
  const body = await json(challenge);
  if (!body.mfaRequired) return { cookie: sessionCookie(challenge), csrf: body.csrfToken };
  const dev = await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  const { code } = await json(dev);
  const mfa = await app.fetch(new Request("http://localhost/api/v1/auth/login/mfa", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: body.challengeId, code }),
  }));
  expect(mfa.status).toBe(200);
  const verified = await json(mfa);
  const session = { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
  await chooseFacility(app, session);
  return session;
}

async function call(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", session.cookie);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(init.method ?? "GET")) headers.set("x-medveris-csrf", session.csrf);
  if (init.body) headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

async function expectOk(response: Response, status = 200): Promise<any> {
  const body = await json(response);
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

let reception: Session;
let admin: Session;

beforeAll(async () => {
  reception = await login("reception@medveris.local");
  admin = await login("admin@medveris.local");
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("registration initial billing (5.1)", () => {
  it("creates an idempotent initial registration charge when configured and does not duplicate on replay/enroll", async () => {
    // Configure: create approved consultation catalog item and enable registration charge
    const code = `REG-CONS-${Date.now()}`;
    const item = await expectOk(await call(admin, "/api/v1/service-catalog", {
      method: "POST",
      body: JSON.stringify({ code, name: "Registration consultation", category: "consultation", itemType: "service", price: 5000, currency: "UGX", active: true, priceStatus: "approved" }),
    }), 201);
    const itemId = item.service.id as string;

    const settings = await expectOk(await call(admin, "/api/v1/billing-settings"));
    await expectOk(await call(admin, "/api/v1/billing-settings", {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: settings.settings.version,
        allowedCurrencies: settings.settings.allowedCurrencies,
        allowZeroPrices: settings.settings.allowZeroPrices,
        allowManualCharges: settings.settings.allowManualCharges,
        significantChangePercent: settings.settings.significantChangePercent,
        registrationChargeEnabled: true,
        registrationChargeCatalogId: itemId,
      }),
    }));

    const familyName = `RegBill${Date.now()}`;
    const body = JSON.stringify({ givenName: "Synthetic", familyName, dateOfBirth: "1991-02-03", sex: "female", identityConfidence: "confirmed-verbal" });
    const key = `regbill-${crypto.randomUUID()}`;
    const first = await expectOk(await call(reception, "/api/v1/reception/patients", { method: "POST", headers: { "idempotency-key": key }, body }), 201);
    expect(first.patient.registrationBilling?.status).toBe("billed");
    expect(first.patient.registrationBilling?.invoiceId).toBeTruthy();

    const replay = await expectOk(await call(reception, "/api/v1/reception/patients", { method: "POST", headers: { "idempotency-key": key }, body }), 201);
    expect(replay.patient.registrationBilling?.status).toBe("already_billed");

    // verify only one marker/invoice for patient+tenant
    const markers = await withContext(sql, {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorKind: "staff",
      roles: ["facility_admin"],
    }, async (tx) => tx`select id, invoice_id from patient_registration_billing where patient_id = ${first.patient.patientId}`);
    expect(markers.length).toBe(1);

    // disable to avoid affecting other tests
    const after = await expectOk(await call(admin, "/api/v1/billing-settings"));
    await expectOk(await call(admin, "/api/v1/billing-settings", {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: after.settings.version,
        allowedCurrencies: after.settings.allowedCurrencies,
        allowZeroPrices: after.settings.allowZeroPrices,
        allowManualCharges: after.settings.allowManualCharges,
        significantChangePercent: after.settings.significantChangePercent,
        registrationChargeEnabled: false,
        registrationChargeCatalogId: null,
      }),
    }));
  });
});
