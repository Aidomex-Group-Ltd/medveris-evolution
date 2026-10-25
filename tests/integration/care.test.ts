import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, withContext } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for care coordination tests");
const sql = createSql(url, { max: 5 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DEV_SHOW_TOTP_SECRETS: "true",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-care-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-care-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

interface Session { cookie: string; csrf: string }
interface FollowUp { id: string; status: string; version: number; overdue: boolean }
interface Referral { id: string; status: string; version: number }

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
  return { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
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

let clinician: Session;
let reception: Session;
let encounterId = "";
let followUpId = "";
let referralId = "";

beforeAll(async () => {
  clinician = await login("clinician@medveris.local");
  reception = await login("reception@medveris.local");
  const patient = await expectOk(await call(reception, "/api/v1/reception/patients", {
    method: "POST",
    body: JSON.stringify({
      givenName: "Care", familyName: `Coordination${Date.now()}`, dateOfBirth: "1987-02-11", sex: "female",
      identityConfidence: "confirmed-verbal",
    }),
  }), 201);
  const encounter = await expectOk(await call(reception, "/api/v1/encounters", {
    method: "POST", body: JSON.stringify({ patientId: patient.patient.patientId, type: "walk-in", reason: "Care coordination test" }),
  }), 201);
  encounterId = encounter.encounterId;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("follow-up and referral tracking", () => {
  it("tracks an overdue follow-up through completion with optimistic concurrency", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const created = await expectOk(await call(clinician, `/api/v1/encounters/${encounterId}/follow-ups`, {
      method: "POST", body: JSON.stringify({ dueDate: yesterday, instructions: "Review blood pressure and adherence." }),
    }), 201);
    followUpId = created.followUpId;

    const overdue = await expectOk(await call(clinician, "/api/v1/care/follow-ups?status=pending&due=overdue"));
    const row = overdue.followUps.find((followUp: FollowUp) => followUp.id === followUpId) as FollowUp;
    expect(row.overdue).toBe(true);
    expect(row.version).toBe(1);

    const completed = await expectOk(await call(clinician, `/api/v1/care/follow-ups/${followUpId}/status`, {
      method: "POST", body: JSON.stringify({ status: "completed", note: "Patient reviewed; plan unchanged.", expectedVersion: 1 }),
    }));
    expect(completed.followUp.version).toBe(2);

    const stale = await call(clinician, `/api/v1/care/follow-ups/${followUpId}/status`, {
      method: "POST", body: JSON.stringify({ status: "cancelled", note: "Attempted stale transition.", expectedVersion: 1 }),
    });
    expect(stale.status).toBe(409);

    const terminal = await call(clinician, `/api/v1/care/follow-ups/${followUpId}/status`, {
      method: "POST", body: JSON.stringify({ status: "cancelled", note: "A completed follow-up cannot be cancelled.", expectedVersion: 2 }),
    });
    expect(terminal.status).toBe(409);
  });

  it("tracks a referral locally without claiming external transmission", async () => {
    const created = await expectOk(await call(clinician, `/api/v1/encounters/${encounterId}/referrals`, {
      method: "POST",
      body: JSON.stringify({ toFacility: "Synthetic Regional Hospital", reason: "Cardiology assessment", priority: "urgent" }),
    }), 201);
    referralId = created.referralId;

    const pending = await expectOk(await call(clinician, "/api/v1/care/referrals?status=pending"));
    const row = pending.referrals.find((referral: Referral) => referral.id === referralId) as Referral;
    expect(row.version).toBe(1);

    const accepted = await expectOk(await call(clinician, `/api/v1/care/referrals/${referralId}/status`, {
      method: "POST", body: JSON.stringify({ status: "accepted", note: "Receiving team contacted by telephone (synthetic).", expectedVersion: 1 }),
    }));
    expect(accepted.referral.version).toBe(2);

    const completed = await expectOk(await call(clinician, `/api/v1/care/referrals/${referralId}/status`, {
      method: "POST", body: JSON.stringify({ status: "completed", note: "Assessment appointment recorded as attended (synthetic).", expectedVersion: 2 }),
    }));
    expect(completed.referral.version).toBe(3);

    const stale = await call(clinician, `/api/v1/care/referrals/${referralId}/status`, {
      method: "POST", body: JSON.stringify({ status: "cancelled", note: "Attempted stale cancellation.", expectedVersion: 2 }),
    });
    expect(stale.status).toBe(409);

    const audit = await withContext(sql, {
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorKind: "staff",
      roles: ["facility_admin"],
    }, async (tx) => tx`
      select action, resource_id from audit_events
       where action in ('follow-up.status-change', 'referral.status-change')
         and resource_id in (${followUpId}, ${referralId})
    `);
    expect(audit.filter((row) => row.action === "follow-up.status-change")).toHaveLength(1);
    expect(audit.filter((row) => row.action === "referral.status-change")).toHaveLength(2);
  });

  it("denies care coordination to reception", async () => {
    const followUps = await call(reception, "/api/v1/care/follow-ups");
    expect(followUps.status).toBe(403);
    const referrals = await call(reception, "/api/v1/care/referrals");
    expect(referrals.status).toBe(403);
  });
});
