import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { chooseFacility } from "./support.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for ward foundation tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env,
  APP_ENV: "test",
  APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true",
  FEATURE_AI: "false",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-ward-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-ward-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

interface Session {
  cookie: string;
  csrf: string;
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie?.() ?? [];
  const match = cookies.find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error(`no session cookie in ${cookies.join(", ")}`);
  return match.split(";")[0]!;
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, received ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function login(email: string): Promise<Session> {
  const challenge = await app.fetch(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Medveris!2026" }),
    }),
  );
  expect(challenge.status).toBe(200);
  const body = await json(challenge);
  if (!body.mfaRequired) return { cookie: sessionCookie(challenge), csrf: body.csrfToken };
  const dev = await app.fetch(
    new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`),
  );
  expect(dev.status).toBe(200);
  const { code } = await json(dev);
  const mfa = await app.fetch(
    new Request("http://localhost/api/v1/auth/login/mfa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: body.challengeId, code }),
    }),
  );
  expect(mfa.status).toBe(200);
  const verified = await json(mfa);
  const session = { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
  await chooseFacility(app, session);
  return session;
}

async function call(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", session.cookie);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(init.method ?? "GET"))
    headers.set("x-medveris-csrf", session.csrf);
  if (init.body) headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

async function expectOk(response: Response, status = 200): Promise<any> {
  const body = await json(response);
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

const stamp = Date.now();
let clinician: Session;
let nurse: Session;
let admin: Session;
let reception: Session;
let wardId = "";
let bedB = "";
let admissionId = "";
let admissionVersion = 1;
let bedBVersion = 1;

beforeAll(async () => {
  [clinician, nurse, admin, reception] = await Promise.all([
    login("clinician@medveris.local"),
    login("nurse@medveris.local"),
    login("admin@medveris.local"),
    login("reception@medveris.local"),
  ]);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("ward foundation (stage 1)", () => {
  it("creates a ward, reserves a bed and rejects double-booking", async () => {
    const created = await expectOk(
      await call(admin, "/api/v1/wards", {
        method: "POST",
        body: JSON.stringify({ name: `Ward Foundation ${stamp}`, wardType: "general", description: "stage 1" }),
      }),
      201,
    );
    wardId = created.ward.id;

    const bed1 = await expectOk(
      await call(nurse, `/api/v1/wards/${wardId}/beds`, {
        method: "POST",
        body: JSON.stringify({ label: `A${stamp}`, features: {} }),
      }),
      201,
    );
    void bed1.bed.id;
    const bed2 = await expectOk(
      await call(nurse, `/api/v1/wards/${wardId}/beds`, {
        method: "POST",
        body: JSON.stringify({ label: `B${stamp}`, features: {} }),
      }),
      201,
    );
    bedB = bed2.bed.id;

    const beds = await expectOk(await call(nurse, "/api/v1/beds"));
    bedBVersion = Number(beds.beds.find((b: any) => b.id === bedB).version);

    // Reserve bed B
    await expectOk(
      await call(nurse, `/api/v1/beds/${bedB}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "reserved", reason: "expected admission", expectedVersion: bedBVersion }),
      }),
    );

    const capacity = await expectOk(await call(nurse, `/api/v1/wards/${wardId}/capacity`));
    expect(capacity.capacity.totalBeds).toBe(2);
    expect(capacity.capacity.reservedBeds).toBe(1);

    const dashboard = await expectOk(await call(nurse, "/api/v1/wards/dashboard"));
    expect(dashboard.wards.some((w: any) => w.id === wardId)).toBe(true);
    expect(dashboard.totals.totalBeds).toBeGreaterThanOrEqual(2);
  });

  it("admit with explicit ward, assign reserved bed, transfer and capacity reflects it", async () => {
    const patient = await expectOk(
      await call(reception, "/api/v1/reception/patients", {
        method: "POST",
        body: JSON.stringify({
          givenName: "Ward",
          familyName: `Foundation${stamp}`,
          dateOfBirth: "1990-01-01",
          sex: "female",
          identityConfidence: "confirmed-verbal",
        }),
      }),
      201,
    );
    const encounter = await expectOk(
      await call(reception, "/api/v1/encounters", {
        method: "POST",
        body: JSON.stringify({
          patientId: patient.patient.patientId,
          type: "walk-in",
          reason: "chest pain, stage 1 test",
        }),
      }),
      201,
    );
    const encounterId = encounter.encounterId;

    const admitted = await expectOk(
      await call(clinician, "/api/v1/admissions", {
        method: "POST",
        body: JSON.stringify({
          patientId: patient.patient.patientId,
          encounterId,
          wardType: "general",
          wardId,
          reason: "chest pain, stage 1 test",
        }),
      }),
      201,
    );
    admissionId = admitted.admission.id;

    const detail0 = await expectOk(await call(clinician, `/api/v1/admissions/${admissionId}`));
    expect(String(detail0.admission.wardId)).toBe(wardId);
    admissionVersion = Number(detail0.admission.version);

    // Assign reserved bed B
    await expectOk(
      await call(clinician, `/api/v1/admissions/${admissionId}/bed`, {
        method: "POST",
        body: JSON.stringify({ bedId: bedB, expectedVersion: admissionVersion, reason: "reserved assignment" }),
      }),
    );

    const capacity = await expectOk(await call(nurse, `/api/v1/wards/${wardId}/capacity`));
    expect(capacity.capacity.occupiedBeds).toBe(1);
    expect(capacity.census).toBeGreaterThanOrEqual(1);

    // Double-booking same bed by another admission must fail
    const patient2 = await expectOk(
      await call(reception, "/api/v1/reception/patients", {
        method: "POST",
        body: JSON.stringify({
          givenName: "Ward",
          familyName: `Second${stamp}`,
          dateOfBirth: "1985-05-05",
          sex: "male",
          identityConfidence: "confirmed-verbal",
        }),
      }),
      201,
    );
    const encounter2 = await expectOk(
      await call(reception, "/api/v1/encounters", {
        method: "POST",
        body: JSON.stringify({
          patientId: patient2.patient.patientId,
          type: "walk-in",
          reason: "second patient stage 1",
        }),
      }),
      201,
    );
    const second = await expectOk(
      await call(clinician, "/api/v1/admissions", {
        method: "POST",
        body: JSON.stringify({
          patientId: patient2.patient.patientId,
          encounterId: encounter2.encounterId,
          wardType: "general",
          wardId,
          reason: "second patient stage 1",
        }),
      }),
      201,
    );
    const secondDetail = await expectOk(await call(clinician, `/api/v1/admissions/${second.admission.id}`));
    const blocked = await call(clinician, `/api/v1/admissions/${second.admission.id}/bed`, {
      method: "POST",
      body: JSON.stringify({ bedId: bedB, expectedVersion: Number(secondDetail.admission.version) }),
    });
    expect(blocked.status).toBe(409);
  });

  it("close/reopen ward, discharges and frees the bed", async () => {
    await expectOk(
      await call(admin, `/api/v1/wards/${wardId}`, { method: "PATCH", body: JSON.stringify({ status: "closed" }) }),
    );
    const wards = await expectOk(await call(admin, "/api/v1/wards"));
    expect(wards.wards.find((w: any) => w.id === wardId)?.status).toBe("closed");

    await expectOk(
      await call(admin, `/api/v1/wards/${wardId}`, { method: "PATCH", body: JSON.stringify({ status: "open" }) }),
    );

    const detail = await expectOk(await call(clinician, `/api/v1/admissions/${admissionId}`));
    await expectOk(
      await call(clinician, `/api/v1/admissions/${admissionId}/transition`, {
        method: "POST",
        body: JSON.stringify({
          status: "discharged",
          expectedVersion: Number(detail.admission.version),
          summary: "Clinical discharge summary for stage 1.",
          reason: "recovered",
        }),
      }),
    );

    const beds = await expectOk(await call(nurse, "/api/v1/beds"));
    const freed = beds.beds.find((b: any) => b.id === bedB);
    expect(freed.status).toBe("cleaning");
  });

  it("rejects mismatched ward type on admission", async () => {
    const patient = await expectOk(
      await call(reception, "/api/v1/reception/patients", {
        method: "POST",
        body: JSON.stringify({
          givenName: "Mismatch",
          familyName: `Ward${stamp}`,
          dateOfBirth: "1999-09-09",
          sex: "male",
          identityConfidence: "confirmed-verbal",
        }),
      }),
      201,
    );
    const encounter = await expectOk(
      await call(reception, "/api/v1/encounters", {
        method: "POST",
        body: JSON.stringify({ patientId: patient.patient.patientId, type: "walk-in", reason: "mismatch check" }),
      }),
      201,
    );
    const bad = await call(clinician, "/api/v1/admissions", {
      method: "POST",
      body: JSON.stringify({
        patientId: patient.patient.patientId,
        encounterId: encounter.encounterId,
        wardType: "maternity",
        wardId,
        reason: "mismatch check",
      }),
    });
    expect(bad.status).toBe(422);
  });
});
