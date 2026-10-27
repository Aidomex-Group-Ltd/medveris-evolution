import { afterAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for registration tests");
const sql = createSql(url, { max: 3 });
const config = loadConfig({ ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173" });
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-test-mail-${crypto.randomUUID()}`),
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
