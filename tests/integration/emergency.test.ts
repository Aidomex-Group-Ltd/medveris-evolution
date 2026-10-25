import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for emergency tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173", DEV_SHOW_TOTP_SECRETS: "true",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-emergency-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-emergency-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);
const CLINICIAN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Session { cookie: string; csrf: string }

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
  const challenge = await app.fetch(new Request("http://localhost/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Medveris!2026" }),
  }));
  expect(challenge.status).toBe(200);
  const body = await json(challenge);
  if (!body.mfaRequired) return { cookie: sessionCookie(challenge), csrf: body.csrfToken };
  const dev = await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  expect(dev.status).toBe(200);
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

const TRIAGE = {
  complaint: "Collapsed at home with reduced consciousness (synthetic)",
  urgency: "emergency",
  notes: "Emergency team activated.",
  observations: [{
    coding: { system: "http://loinc.org", version: "2.80-medveris-synthetic", code: "8867-4", display: "Heart rate" },
    value: 122, unit: { code: "/min", system: "http://unitsofmeasure.org" }, occurredAt: new Date().toISOString(),
  }],
  allergyState: "none",
  allergy: null,
};

let nurse: Session;
let clinician: Session;
let reception: Session;
let admin: Session;
let lab: Session;

beforeAll(async () => {
  [nurse, clinician, reception, admin, lab] = await Promise.all([
    login("nurse@medveris.local"),
    login("clinician@medveris.local"),
    login("reception@medveris.local"),
    login("admin@medveris.local"),
    login("lab@medveris.local"),
  ]);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("emergency care workflow", () => {
  it("registers a temporary patient, triages, records observations, hands off and discharges", async () => {
    const created = await expectOk(await call(nurse, "/api/v1/emergency/cases", {
      method: "POST",
      body: JSON.stringify({
        temporaryPatient: {
          givenName: "Unidentified", familyName: `Emergency${Date.now()}`,
          dateOfBirth: "1990-01-01", sex: "unknown",
        },
        reason: "Collapsed at home; identity not yet confirmed (synthetic)",
        arrivalMode: "ambulance", location: "Resus bay 1", assignedUserId: CLINICIAN_ID,
      }),
    }), 201);
    expect(created.case.publicId).toMatch(/^MV-/);
    expect(created.case.temporaryIdentity).toBe(true);
    const caseId = created.case.id as string;
    const encounterId = created.case.encounterId as string;

    const board = await expectOk(await call(clinician, "/api/v1/emergency/cases?status=active"));
    const row = board.cases.find((item: any) => item.id === caseId);
    expect(row).toBeTruthy();
    expect(row.createdVia).toBe("temporary-emergency");
    expect(row.observationCount).toBe(0);

    await expectOk(await call(nurse, `/api/v1/encounters/${encounterId}/triage`, {
      method: "POST", body: JSON.stringify(TRIAGE),
    }));
    const afterTriage = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}`));
    expect(afterTriage.triage.length).toBe(1);
    expect(afterTriage.triage[0].urgency).toBe("emergency");
    expect(afterTriage.observations.length).toBe(1);

    await expectOk(await call(nurse, `/api/v1/emergency/cases/${caseId}/observations`, {
      method: "POST",
      body: JSON.stringify({
        coding: { system: "http://loinc.org", version: "2.80-medveris-synthetic", code: "9279-1", display: "Respiratory rate" },
        value: 28, unit: { code: "/min", system: "http://unitsofmeasure.org" }, occurredAt: new Date().toISOString(),
      }),
    }), 201);
    await expectOk(await call(nurse, `/api/v1/emergency/cases/${caseId}/handoffs`, {
      method: "POST", body: JSON.stringify({ toUserId: CLINICIAN_ID, summary: "Emergency team aware; airway maintained, awaiting results." }),
    }), 201);
    const handoffDetail = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}`));
    expect(handoffDetail.handoffs.length).toBe(1);
    expect(handoffDetail.observations.length).toBe(2);

    const rejected = await call(clinician, `/api/v1/emergency/cases/${caseId}/disposition`, {
      method: "POST", body: JSON.stringify({
        disposition: "discharged", note: "Synthetic discharge after observation.", expectedVersion: handoffDetail.case.encounterVersion,
      }),
    });
    expect(rejected.status).toBe(409);

    await expectOk(await call(clinician, `/api/v1/encounters/${encounterId}/transitions`, {
      method: "POST", body: JSON.stringify({ state: "in-progress", expectedVersion: handoffDetail.case.encounterVersion }),
    }));
    const current = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}`));
    const closed = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}/disposition`, {
      method: "POST", body: JSON.stringify({
        disposition: "discharged", note: "Synthetic discharge after observation and review.", expectedVersion: current.case.encounterVersion,
      }),
    }));
    expect(closed.case.disposition).toBe("discharged");
    expect(closed.case.encounterState).toBe("completed");

    const stale = await call(clinician, `/api/v1/emergency/cases/${caseId}/disposition`, {
      method: "POST", body: JSON.stringify({
        disposition: "discharged", note: "Repeated synthetic discharge attempt.", expectedVersion: current.case.encounterVersion,
      }),
    });
    expect(stale.status).toBe(409);
  });

  it("requires an admission before recording an admitted emergency disposition", async () => {
    const created = await expectOk(await call(clinician, "/api/v1/emergency/cases", {
      method: "POST", body: JSON.stringify({
        temporaryPatient: { givenName: "Unidentified", familyName: `Admit${Date.now()}`, dateOfBirth: "1988-05-10", sex: "male" },
        reason: "Road traffic injury requiring admission (synthetic)", arrivalMode: "police",
      }),
    }), 201);
    const caseId = created.case.id as string;
    const encounterId = created.case.encounterId as string;
    const patientId = created.case.patientId as string;
    await expectOk(await call(clinician, `/api/v1/encounters/${encounterId}/triage`, {
      method: "POST", body: JSON.stringify({ ...TRIAGE, complaint: "Road traffic injury (synthetic)" }),
    }));
    await expectOk(await call(clinician, `/api/v1/encounters/${encounterId}/transitions`, {
      method: "POST", body: JSON.stringify({ state: "in-progress", expectedVersion: 2 }),
    }));
    let detail = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}`));
    const blocked = await call(clinician, `/api/v1/emergency/cases/${caseId}/disposition`, {
      method: "POST", body: JSON.stringify({ disposition: "admitted", note: "Synthetic admission disposition.", expectedVersion: detail.case.encounterVersion }),
    });
    expect(blocked.status).toBe(409);

    await expectOk(await call(clinician, "/api/v1/admissions", {
      method: "POST", body: JSON.stringify({ patientId, encounterId, wardType: "surgical", reason: "Synthetic emergency surgical admission" }),
    }), 201);
    detail = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}`));
    const admitted = await expectOk(await call(clinician, `/api/v1/emergency/cases/${caseId}/disposition`, {
      method: "POST", body: JSON.stringify({ disposition: "admitted", note: "Admitted to surgical ward.", expectedVersion: detail.case.encounterVersion }),
    }));
    expect(admitted.case.disposition).toBe("admitted");
    expect(admitted.case.encounterState).toBe("in-progress");
  });

  it("denies the emergency board to non-clinical and administrative roles", async () => {
    for (const session of [reception, admin, lab]) {
      const response = await call(session, "/api/v1/emergency/cases");
      expect(response.status).toBe(403);
    }
  });
});
