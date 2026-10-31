import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, withContext } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { chooseFacility } from "./support.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for patient registration tests");
const sql = createSql(url, { max: 5 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DEV_SHOW_TOTP_SECRETS: "true",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-patients-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-patients-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

interface Session { cookie: string; csrf: string }
interface Patient { patientId: string; publicId: string; duplicateReviewQueued: number }
interface Candidate {
  id: string;
  primaryPublicId: string;
  candidatePublicId: string;
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

async function register(session: Session, familyName: string): Promise<Patient> {
  const body = await expectOk(await call(session, "/api/v1/reception/patients", {
    method: "POST",
    body: JSON.stringify({
      givenName: "Synthetic", familyName, dateOfBirth: "1992-06-15", sex: "female",
      identityConfidence: "confirmed-verbal",
    }),
  }), 201);
  return body.patient;
}

let reception: Session;
let clinicianB: Session;
let admin: Session;
let sameFacilityCandidate: Candidate;

beforeAll(async () => {
  reception = await login("reception@medveris.local");
  clinicianB = await login("clinician.b@medveris.local");
  admin = await login("admin@medveris.local");
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("patient registration and duplicate review", () => {
  it("queues same-facility duplicates and never inspects another facility's patients", async () => {
    const familyName = `Duplicate${Date.now()}`;
    const primary = await register(reception, familyName);
    expect(primary.duplicateReviewQueued).toBe(0);

    const duplicate = await register(reception, familyName);
    expect(duplicate.duplicateReviewQueued).toBe(1);

    const otherFacility = await register(clinicianB, familyName);
    expect(otherFacility.duplicateReviewQueued).toBe(0);

    const candidates = await expectOk(await call(admin, "/api/v1/admin/duplicate-candidates"));
    const matching = candidates.candidates.filter(
      (candidate: Candidate) => candidate.primaryPublicId === primary.publicId || candidate.candidatePublicId === duplicate.publicId,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].candidatePublicId).toBe(duplicate.publicId);
    expect(candidates.candidates.some((candidate: Candidate) =>
      candidate.primaryPublicId === otherFacility.publicId || candidate.candidatePublicId === otherFacility.publicId,
    )).toBe(false);
    sameFacilityCandidate = matching[0];
  });

  it("replays a retried assisted registration without creating a second patient", async () => {
    const familyName = `Retry${Date.now()}`;
    const body = JSON.stringify({ givenName: "Synthetic", familyName, dateOfBirth: "1992-06-15", sex: "female", identityConfidence: "confirmed-verbal" });
    const key = `register-${crypto.randomUUID()}`;
    const first = await expectOk(await call(reception, "/api/v1/reception/patients", { method: "POST", headers: { "idempotency-key": key }, body }), 201);
    const second = await expectOk(await call(reception, "/api/v1/reception/patients", { method: "POST", headers: { "idempotency-key": key }, body }), 201);
    expect(second.patient.publicId).toBe(first.patient.publicId);
    expect(second.patient.patientId).toBe(first.patient.patientId);
  });

  it("records an audited duplicate review without merging identities", async () => {
    const reviewed = await expectOk(await call(admin, `/api/v1/admin/duplicate-candidates/${sameFacilityCandidate.id}/review`, {
      method: "POST",
      body: JSON.stringify({ status: "reviewed-no-merge", note: "Synthetic review: same name and date of birth, identities retained." }),
    }));
    expect(reviewed.automaticMerge).toBe(false);

    const candidates = await expectOk(await call(admin, "/api/v1/admin/duplicate-candidates"));
    expect(candidates.candidates.some((candidate: Candidate) => candidate.id === sameFacilityCandidate.id)).toBe(false);

    const audit = await withContext(sql, {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorKind: "staff",
      roles: ["facility_admin"],
    }, async (tx) => tx`
      select action, resource_id from audit_events
       where action = 'patient.duplicate.review' and resource_id = ${sameFacilityCandidate.id}
    `);
    expect(audit).toHaveLength(1);
  });
});

describe("facility enrolment of an existing patient", () => {
  it("links a patient registered elsewhere without creating a second identity", async () => {
    const familyName = `Enrol${Date.now()}`;
    const registered = await register(clinicianB, familyName);
    const body = JSON.stringify({ publicId: registered.publicId, familyName, dateOfBirth: "1992-06-15" });
    const enrolled = await expectOk(await call(reception, "/api/v1/patients/enroll", { method: "POST", body }), 201);
    expect(enrolled).toMatchObject({ alreadyLinked: false, patient: { publicId: registered.publicId } });

    const replay = await expectOk(await call(reception, "/api/v1/patients/enroll", { method: "POST", body }), 200);
    expect(replay.alreadyLinked).toBe(true);

    const resolved = await expectOk(await call(reception, "/api/v1/patients/resolve", {
      method: "POST",
      body: JSON.stringify({ publicId: registered.publicId, familyName, dateOfBirth: "1992-06-15" }),
    }));
    expect(resolved.matched).toBe(true);
    expect(resolved.patient.linked).toBe(true);
  });

  it("refuses enrolment when the identity details do not match", async () => {
    const familyName = `EnrolMismatch${Date.now()}`;
    const registered = await register(clinicianB, familyName);
    const response = await call(reception, "/api/v1/patients/enroll", {
      method: "POST",
      body: JSON.stringify({ publicId: registered.publicId, familyName, dateOfBirth: "1992-06-16" }),
    });
    expect(response.status).toBe(404);
  });
});

describe("reception patient lookup", () => {
  it("confirms an exact public ID with identity details", async () => {
    const familyName = `Lookup${Date.now()}`;
    const registered = await register(reception, familyName);
    const body = await expectOk(await call(reception, "/api/v1/patients/resolve", {
      method: "POST",
      body: JSON.stringify({ publicId: registered.publicId, familyName: familyName.toUpperCase(), dateOfBirth: "1992-06-15" }),
    }));
    expect(body.matched).toBe(true);
    expect(body.patient.publicId).toBe(registered.publicId);
    expect(body.patient.dateOfBirth).toBe("1992-06-15");
    expect(body.patient.linked).toBe(true);
  });

  it("accepts a public ID typed in lowercase, with spaces or with look-alike characters", async () => {
    const familyName = `Typed${Date.now()}`;
    const registered = await register(reception, familyName);
    const typed = registered.publicId.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    const body = await expectOk(await call(reception, "/api/v1/patients/resolve", {
      method: "POST",
      body: JSON.stringify({ publicId: typed, familyName, dateOfBirth: "1992-06-15" }),
    }));
    expect(body.matched).toBe(true);
    expect(body.patient.publicId).toBe(registered.publicId);
  });

  it("reports a failed identity confirmation as an unmatched lookup, not a missing endpoint", async () => {
    const familyName = `Mismatch${Date.now()}`;
    const registered = await register(reception, familyName);
    const body = await expectOk(await call(reception, "/api/v1/patients/resolve", {
      method: "POST",
      body: JSON.stringify({ publicId: registered.publicId, familyName, dateOfBirth: "1992-06-16" }),
    }));
    expect(body).toEqual({ matched: false, patient: null, message: expect.stringContaining("No patient matched") });
  });

  it("finds patients linked to the active facility by name without exposing other facilities", async () => {
    const familyName = `Searchable${Date.now()}`;
    const here = await register(reception, familyName);
    await register(clinicianB, familyName);
    const body = await expectOk(await call(reception, `/api/v1/patients/search?q=${encodeURIComponent(familyName.slice(0, -1).toLowerCase())}`));
    const matches = body.patients.filter((patient: { familyName: string }) => patient.familyName === familyName);
    expect(matches.map((patient: { publicId: string }) => patient.publicId)).toEqual([here.publicId]);
    expect(matches[0].dateOfBirth).toBe("1992-06-15");

    const tooShort = await call(reception, "/api/v1/patients/search?q=a");
    expect(tooShort.status).toBe(422);
  });
});
