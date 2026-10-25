import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for hospital tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true", FEATURE_DEVICES: "true", FEATURE_AI: "false", FEATURE_TELEMEDICINE: "false",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-hospital-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-hospital-storage-${crypto.randomUUID()}`),
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

const today = new Date().toISOString().slice(0, 10);
const stamp = Date.now();

let clinician: Session;
let nurse: Session;
let reception: Session;
let hr: Session;
let housekeeping: Session;
let porter: Session;
let mortuary: Session;
let cssd: Session;
let biomedical: Session;
let patientId = "";

beforeAll(async () => {
  [clinician, nurse, reception, hr, housekeeping, porter, mortuary, cssd, biomedical] = await Promise.all([
    login("clinician@medveris.local"),
    login("nurse@medveris.local"),
    login("reception@medveris.local"),
    login("hr@medveris.local"),
    login("housekeeping@medveris.local"),
    login("porter@medveris.local"),
    login("mortuary@medveris.local"),
    login("cssd@medveris.local"),
    login("biomedical@medveris.local"),
  ]);
  const created = await expectOk(await call(reception, "/api/v1/reception/patients", {
    method: "POST",
    body: JSON.stringify({
      givenName: "Hospital", familyName: `Flow${stamp}`, dateOfBirth: "1994-02-11", sex: "female",
      identityConfidence: "confirmed-verbal",
    }),
  }), 201);
  patientId = created.patient.patientId;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("organisation and workforce onboarding", () => {
  it("provisions a department and carries a new hire through onboarding to active", async () => {
    const code = `QA-${String(stamp).slice(-6)}`;
    await expectOk(await call(clinician, "/api/v1/organization/departments", {
      method: "POST",
      body: JSON.stringify({ code, name: "Quality assurance test department", departmentType: "ipc-quality" }),
    }), 403);

    const department = await expectOk(await call(hr, "/api/v1/organization/departments", {
      method: "POST",
      body: JSON.stringify({ code, name: "Quality assurance test department", departmentType: "ipc-quality", enabled: true }),
    }), 201);
    const departmentId = department.department.id;

    await expectOk(await call(hr, `/api/v1/organization/departments/${departmentId}/units`, {
      method: "POST",
      body: JSON.stringify({ code: "QA-UNIT", name: "Quality unit", unitType: "general" }),
    }), 201);

    const started = await expectOk(await call(hr, "/api/v1/workforce/onboarding", {
      method: "POST",
      body: JSON.stringify({
        givenName: "Test", familyName: `Hire${stamp}`, email: `hire${stamp}@example.test`,
        engagementType: "employee", startDate: today, primaryDepartmentId: departmentId,
        appointmentTitle: "Quality officer",
      }),
    }), 201);
    const caseId = started.onboarding.caseId;

    for (const status of ["identity", "employment", "professional", "assignments", "credentials", "privileges", "review"]) {
      await expectOk(await call(hr, `/api/v1/workforce/onboarding/${caseId}`, {
        method: "PATCH", body: JSON.stringify({ status, currentStep: 2 }),
      }));
    }
    await expectOk(await call(hr, `/api/v1/workforce/onboarding/${caseId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "All onboarding checks completed for synthetic test" }),
    }));

    const detail = await expectOk(await call(hr, `/api/v1/workforce/onboarding/${caseId}`));
    expect(detail.onboarding.status).toBe("active");
    expect(detail.assignments).toHaveLength(1);

    const summary = await expectOk(await call(hr, "/api/v1/workforce/summary"));
    expect(summary.summary.activeStaff).toBeGreaterThan(0);
  });
});

describe("documentation registry", () => {
  it("publishes a template, records a patient document and signs it", async () => {
    const template = await expectOk(await call(clinician, "/api/v1/document-templates", {
      method: "POST",
      body: JSON.stringify({
        templateKey: `qa.note.${stamp}`, name: "QA clinical note", context: "clinical",
        fields: [
          { key: "summary", label: "Summary", type: "textarea", required: true },
          { key: "plan", label: "Plan", type: "textarea", required: false },
        ],
        authorRoles: ["clinician", "nurse"], signingRequired: true,
      }),
    }), 201);
    const templateId = template.template.id;

    await expectOk(await call(clinician, `/api/v1/document-templates/${templateId}/publish`, {
      method: "POST", body: JSON.stringify({ expectedVersion: 1, approvalNote: "Approved for QA use" }),
    }));

    const document = await expectOk(await call(clinician, "/api/v1/documents", {
      method: "POST",
      body: JSON.stringify({
        templateId, subjectType: "patient", patientId, title: "QA clinical note",
        occurredAt: new Date().toISOString(), content: { summary: "Stable on review", plan: "Follow up in clinic" },
        changeNote: "Initial QA draft",
      }),
    }), 201);
    const documentId = document.document.id;

    const signed = await expectOk(await call(clinician, `/api/v1/documents/${documentId}/sign`, {
      method: "POST", body: JSON.stringify({ expectedVersion: 1, note: "Signed by QA clinician" }),
    }));
    expect(signed.signed.version).toBe(2);
    expect(signed.signed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const detail = await expectOk(await call(clinician, `/api/v1/documents/${documentId}`));
    expect(detail.document.status).toBe("signed");
    expect(detail.versions).toHaveLength(2);
  });
});

describe("maternity workflow", () => {
  it("records labour, delivery and a newborn on the episode", async () => {
    const episode = await expectOk(await call(nurse, "/api/v1/maternity/episodes", {
      method: "POST",
      body: JSON.stringify({ patientId, gravidity: 2, parity: 1, riskLevel: "low", datingBasis: "ultrasound" }),
    }), 201);
    const episodeId = episode.episode.id;

    await expectOk(await call(nurse, `/api/v1/maternity/episodes/${episodeId}/observations`, {
      method: "POST",
      body: JSON.stringify({
        templateType: "partograph", clinicalOccurredAt: new Date().toISOString(),
        maternal: { pulse: 82, systolic: 118, diastolic: 74, cervicalDilationCm: 6 },
        fetal: { heartRate: 142, position: "cephalic" },
      }),
    }), 201);

    await expectOk(await call(nurse, `/api/v1/maternity/episodes/${episodeId}/delivery`, {
      method: "POST",
      body: JSON.stringify({
        deliveredAt: new Date().toISOString(), mode: "spontaneous-vaginal", outcome: "live-birth",
        bloodLossMl: 250,
      }),
    }), 201);

    await expectOk(await call(nurse, `/api/v1/maternity/episodes/${episodeId}/newborns`, {
      method: "POST",
      body: JSON.stringify({ familyName: `Baby${stamp}`, sex: "female", weightG: 3150, apgar1: 9, apgar5: 10 }),
    }), 201);

    const detail = await expectOk(await call(nurse, `/api/v1/maternity/episodes/${episodeId}`));
    expect(detail.observations).toHaveLength(1);
    expect(detail.delivery.mode).toBe("spontaneous-vaginal");
    expect(detail.newborns).toHaveLength(1);
  });
});

describe("support services", () => {
  it("turns a bed around through housekeeping", async () => {
    const task = await expectOk(await call(housekeeping, "/api/v1/housekeeping/tasks", {
      method: "POST",
      body: JSON.stringify({ zone: `QA-zone-${stamp}`, taskType: "routine", riskLevel: "low" }),
    }), 201);
    const taskId = task.task.id;
    for (const status of ["in-progress", "completed"]) {
      await expectOk(await call(housekeeping, `/api/v1/housekeeping/tasks/${taskId}/transition`, {
        method: "POST", body: JSON.stringify({ status }),
      }));
    }
    const tasks = await expectOk(await call(housekeeping, "/api/v1/housekeeping/tasks"));
    expect(tasks.tasks.find((row: any) => row.id === taskId)?.status).toBe("completed");
  });

  it("moves a patient with identity verification", async () => {
    const task = await expectOk(await call(nurse, "/api/v1/porter/tasks", {
      method: "POST",
      body: JSON.stringify({ requestType: "patient-transfer", patientId, fromLocation: "Ward A", toLocation: "Theatre" }),
    }), 201);
    const taskId = task.task.id;
    await expectOk(await call(porter, `/api/v1/porter/tasks/${taskId}/transition`, {
      method: "POST", body: JSON.stringify({ status: "accepted" }),
    }));
    await expectOk(await call(porter, `/api/v1/porter/tasks/${taskId}/transition`, {
      method: "POST", body: JSON.stringify({ status: "in-progress" }),
    }));
    await expectOk(await call(porter, `/api/v1/porter/tasks/${taskId}/transition`, {
      method: "POST", body: JSON.stringify({ status: "completed", identityChecked: true }),
    }));
    const tasks = await expectOk(await call(porter, "/api/v1/porter/tasks"));
    const stored = tasks.tasks.find((row: any) => row.id === taskId);
    expect(stored?.status).toBe("completed");
    expect(stored?.identityChecked).toBe(true);
  });

  it("guards mortuary release until identity is verified", async () => {
    const created = await expectOk(await call(mortuary, "/api/v1/mortuary/cases", {
      method: "POST",
      body: JSON.stringify({
        deceasedName: `Unknown ${stamp}`, identityStatus: "provisional",
        receivedFrom: "Emergency department", storageLocation: "Mortuary bay 2",
      }),
    }), 201);
    const caseId = created.case.id;

    await expectOk(await call(mortuary, `/api/v1/mortuary/cases/${caseId}/movements`, {
      method: "POST",
      body: JSON.stringify({ movementType: "internal-transfer", toLocation: "Mortuary bay 3", identityChecked: true }),
    }), 201);

    const blocked = await call(mortuary, `/api/v1/mortuary/cases/${caseId}/release`, {
      method: "POST",
      body: JSON.stringify({
        releasedToName: "Family representative", relationship: "sibling",
        authorityReference: `REF-${stamp}`, identificationMethod: "national-id",
        identityVerifiedBy: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", handoverWitness: "Ward clerk",
      }),
    });
    expect(blocked.status).toBe(409);

    const detail = await expectOk(await call(mortuary, `/api/v1/mortuary/cases/${caseId}`));
    expect(detail.release).toBeNull();
  });

  it("maintains engineering assets and releases a passing CSSD load", async () => {
    const asset = await expectOk(await call(biomedical, "/api/v1/technical/assets", {
      method: "POST",
      body: JSON.stringify({ assetRef: `ENG-${stamp}`, name: "QA infusion pump", category: "infusion" }),
    }), 201);
    const assetId = asset.asset.id;
    const order = await expectOk(await call(biomedical, "/api/v1/technical/work-orders", {
      method: "POST",
      body: JSON.stringify({ assetId, fault: "Intermittent occlusion alarm", priority: "urgent" }),
    }), 201);
    const orderId = order.workOrder.id;
    await expectOk(await call(biomedical, `/api/v1/technical/work-orders/${orderId}/transition`, {
      method: "POST", body: JSON.stringify({ status: "in-progress" }),
    }));
    await expectOk(await call(biomedical, `/api/v1/technical/work-orders/${orderId}/transition`, {
      method: "POST", body: JSON.stringify({ status: "completed", releaseNote: "Pump recalibrated and tested" }),
    }));

    const cycle = await expectOk(await call(cssd, "/api/v1/technical/cssd-cycles", {
      method: "POST",
      body: JSON.stringify({ sterilizer: "QA sterilizer", cycleRef: `CSSD-${stamp}`, loadCount: 4, indicatorResult: "pass" }),
    }), 201);
    await expectOk(await call(cssd, `/api/v1/technical/cssd-cycles/${cycle.cycle.id}/release`, {
      method: "POST", body: JSON.stringify({ releaseNote: "Biological indicator passed" }),
    }));
    const cycles = await expectOk(await call(cssd, "/api/v1/technical/cssd-cycles"));
    expect(cycles.cycles.find((row: any) => row.id === cycle.cycle.id)?.status).toBe("released");
  });
});
