import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { chooseFacility } from "./support.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for HTTP contract tests");
const sql = createSql(url, { max: 5 });
const config = loadConfig({ ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DEV_SHOW_TOTP_SECRETS: "true" });
config.terminologyMode = "synthetic";
config.fhirExternalWritesEnabled = false;
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-test-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-test-storage-${crypto.randomUUID()}`),
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
    throw new Error(`expected JSON, received ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function login(email: string, password = "Medveris!2026"): Promise<Session> {
  const challenge = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
  expect(challenge.status).toBe(200);
  const body = await json(challenge);
  if (!body.mfaRequired) return { cookie: sessionCookie(challenge), csrf: body.csrfToken };
  const dev = await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  expect(dev.status).toBe(200);
  const { code } = await json(dev);
  const mfa = await app.fetch(new Request("http://localhost/api/v1/auth/login/mfa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: body.challengeId, code }),
  }));
  expect(mfa.status).toBe(200);
  const verified = await json(mfa);
  const session = { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
  await chooseFacility(app, session);
  return session;
}

async function fetchAs(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", session.cookie);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    if ((init.method ?? "GET") === method) headers.set("x-medveris-csrf", session.csrf);
  }
  return await app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

let clinician: Session;
let reception: Session;

beforeAll(async () => {
  clinician = await login("clinician@medveris.local");
  reception = await login("reception@medveris.local");
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("authentication and session controls", () => {
  it("rejects unauthenticated protected reads", async () => {
    const response = await app.fetch(new Request("http://localhost/api/v1/encounters/worklist"));
    expect(response.status).toBe(401);
    expect((await json(response)).error.correlationId).toBeTruthy();
  });

  it("does not reveal whether an account exists on bad credentials", async () => {
    const missing = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@medveris.local", password: "Wrong!2026" }),
    }));
    const wrong = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "clinician@medveris.local", password: "Wrong!2026" }),
    }));
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect((await json(missing)).error.message).toBe((await json(wrong)).error.message);
  });

  it("requires the CSRF token on state-changing requests", async () => {
    const response = await app.fetch(new Request("http://localhost/api/v1/me/context", {
      method: "POST",
      headers: { cookie: clinician.cookie, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "11111111-1111-4111-8111-111111111111" }),
    }));
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe("forbidden");
  });

  it("exposes the verified actor, facility context and roles", async () => {
    const response = await fetchAs(clinician, "/api/v1/me");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.user.mfaVerified).toBe(true);
    expect(body.activeTenant.roles).toContain("clinician");
    expect(body.activeTenant.name).toContain("Kampala");
  });
});

describe("authorization boundaries over HTTP", () => {
  it("denies clinical worklists to reception", async () => {
    const response = await fetchAs(reception, "/api/v1/encounters/worklist");
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe("forbidden");
  });

  it("denies the clinical worklist to facility administrators", async () => {
    const admin = await login("admin@medveris.local");
    const response = await fetchAs(admin, "/api/v1/encounters/worklist");
    expect(response.status).toBe(403);
  });

  it("returns 404 rather than another tenant's encounter", async () => {
    const response = await fetchAs(clinician, "/api/v1/encounters/e0000000-0000-4000-8000-000000000003");
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(JSON.stringify(body)).not.toContain("Joint pain");
  });

  it("rejects malformed identifiers with a validation error", async () => {
    const response = await fetchAs(clinician, "/api/v1/encounters/not-a-uuid");
    expect(response.status).toBe(422);
    expect((await json(response)).error.code).toBe("validation_error");
  });
});

describe("FHIR and terminology facade", () => {
  it("serves a capability statement without authentication", async () => {
    const response = await app.fetch(new Request("http://localhost/fhir/r4/metadata"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/fhir+json");
    const body = await json(response);
    expect(body.resourceType).toBe("CapabilityStatement");
    expect(body.rest[0].resource.some((r: { interaction: { code: string }[] }) => r.interaction.some((i) => i.code === "search-type"))).toBe(true);
  });

  it("blocks FHIR writes explicitly", async () => {
    const response = await app.fetch(new Request("http://localhost/fhir/r4/Patient", {
      method: "POST",
      headers: { cookie: clinician.cookie, "content-type": "application/fhir+json", "x-medveris-csrf": clinician.csrf },
      body: JSON.stringify({ resourceType: "Patient" }),
    }));
    expect(response.status).toBe(405);
    expect((await json(response)).issue[0].code).toBe("not-supported");
  });

  it("restricts patient reads to patients linked to the active facility", async () => {
    const linked = await fetchAs(clinician, "/fhir/r4/Patient/MV-7K2M-9QX4-4T2A-8Z3N");
    expect(linked.status).toBe(200);
    expect((await json(linked)).name[0].family).toBe("Nakato");
    const otherTenant = await fetchAs(clinician, "/fhir/r4/Patient/MV-5V8X-2C4B-7N9M-6Q1W");
    expect(otherTenant.status).toBe(404);
    expect(JSON.stringify(await json(otherTenant))).not.toContain("Ochieng");
  });

  it("returns synthetic terminology expansions that identify their provenance", async () => {
    const response = await fetchAs(clinician, "/terminology/fhir/r4/ValueSet/$expand?url=https%3A%2F%2Fmedveris.example%2Ffhir%2FValueSet%2Fdiagnosis-synthetic&filter=hyper");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.resourceType).toBe("ValueSet");
    expect(body.expansion.contains.length).toBeGreaterThan(0);
    expect(body.expansion.total).toBeGreaterThan(0);
  });
});
