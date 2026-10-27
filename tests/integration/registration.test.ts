import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { UnconfiguredEmailAdapter } from "../../apps/api/src/lib/email.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for registration tests");
const sql = createSql(url, { max: 3 });
const config = loadConfig({ ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173" });
const mailDir = `${process.env.TMPDIR ?? "/tmp"}/medveris-test-mail-${crypto.randomUUID()}`;
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(mailDir),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-test-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);
const password = "Synthetic-Registration-2026!";

async function post(path: string, body: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function resetTokens(email: string): Promise<string[]> {
  const files = (await readdir(mailDir)).filter((name) => name.includes(email)).sort();
  const tokens: string[] = [];
  for (const name of files) {
    const match = /\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(await readFile(join(mailDir, name), "utf8"));
    if (match) tokens.push(match[1]!);
  }
  return tokens;
}

async function registerFacilityAdmin(): Promise<string> {
  const email = `recovery.${crypto.randomUUID()}@example.test`;
  const response = await post("/api/v1/auth/register/facility", {
    email, password, givenName: "Synthetic", familyName: "Recovery", facilityName: "Synthetic Recovery Clinic",
  });
  expect(response.status).toBe(201);
  return email;
}

describe("self-service registration", () => {
  it("registers a facility and makes the registrant its facility administrator", async () => {
    const email = `facility.${crypto.randomUUID()}@example.test`;
    const response = await post("/api/v1/auth/register/facility", {
      email,
      password,
      givenName: "Synthetic",
      familyName: "Registrant",
      facilityName: "Synthetic Registration Clinic",
      facilityType: "outpatient",
      city: "Kampala",
      country: "Uganda",
    });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.facility.name).toBe("Synthetic Registration Clinic");

    const login = await post("/api/v1/auth/login", { email, password });
    const session = await login.json() as any;
    expect(login.status).toBe(200);
    expect(session.activeTenantId).toBe(body.facility.id);

    const cookie = (login.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="))!.split(";")[0]!;
    const me = await (await app.fetch(new Request("http://localhost/api/v1/auth/session", { headers: { cookie } }))).json() as any;
    expect(me.memberships).toEqual([expect.objectContaining({ tenantId: body.facility.id, roles: ["facility_admin"] })]);
  });

  it("rejects a duplicate facility registrant email without creating a second facility", async () => {
    const email = `facility.${crypto.randomUUID()}@example.test`;
    const input = { email, password, givenName: "Dup", familyName: "Check", facilityName: "Synthetic Duplicate Clinic" };
    expect((await post("/api/v1/auth/register/facility", input)).status).toBe(201);
    expect((await post("/api/v1/auth/register/facility", input)).status).toBe(409);
  });

  it("registers a patient", async () => {
    const response = await post("/api/v1/auth/register/patient", {
      email: `patient.${crypto.randomUUID()}@example.test`,
      password,
      givenName: "Synthetic",
      familyName: "Patient",
      dateOfBirth: "1990-01-01",
      sex: "female",
    });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.patient.publicId).toMatch(/^MV-/);
  });
});

describe("password recovery", () => {
  it("answers identically whether or not the account exists", async () => {
    const known = await registerFacilityAdmin();
    const existing = await post("/api/v1/auth/forgot-password", { email: known });
    const unknown = await post("/api/v1/auth/forgot-password", { email: `nobody.${crypto.randomUUID()}@example.test` });
    expect(existing.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await existing.json()).toEqual(await unknown.json());
    expect(await resetTokens(known)).toHaveLength(1);
  });

  it("does not reveal the account when the email provider fails", async () => {
    const known = await registerFacilityAdmin();
    const failing = createApp({ ...deps, email: new UnconfiguredEmailAdapter() });
    const ask = async (email: string) => (await failing.fetch(new Request("http://localhost/api/v1/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ email }),
    }))).json();
    expect(await ask(known)).toEqual(await ask(`nobody.${crypto.randomUUID()}@example.test`));
  });

  it("resets the password once, revokes sessions and invalidates every outstanding link", async () => {
    const email = await registerFacilityAdmin();
    const login = await post("/api/v1/auth/login", { email, password });
    expect(login.status).toBe(200);
    const cookie = (login.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="))!.split(";")[0]!;

    await post("/api/v1/auth/forgot-password", { email });
    await post("/api/v1/auth/forgot-password", { email });
    const [olderToken, latestToken] = await resetTokens(email);
    expect(olderToken && latestToken).toBeTruthy();

    const newPassword = "Synthetic-Recovered-2026!";
    expect((await post("/api/v1/auth/reset-password", { token: latestToken, password: newPassword })).status).toBe(200);

    const session = await (await app.fetch(new Request("http://localhost/api/v1/auth/session", { headers: { cookie } }))).json() as any;
    expect(session.authenticated).toBe(false);
    expect((await post("/api/v1/auth/login", { email, password })).status).toBe(401);
    expect((await post("/api/v1/auth/login", { email, password: newPassword })).status).toBe(200);

    expect((await post("/api/v1/auth/reset-password", { token: latestToken, password: "Another-Password-2026!" })).status).toBe(422);
    expect((await post("/api/v1/auth/reset-password", { token: olderToken, password: "Another-Password-2026!" })).status).toBe(422);
  });

  it("rejects an unknown reset token and a short password", async () => {
    expect((await post("/api/v1/auth/reset-password", { token: "x".repeat(43), password: "Long-Enough-Password-1" })).status).toBe(422);
    expect((await post("/api/v1/auth/reset-password", { token: "x".repeat(43), password: "short" })).status).toBe(422);
  });
});
