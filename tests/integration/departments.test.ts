import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for department tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true", FEATURE_DEVICES: "true", FEATURE_AI: "false", FEATURE_TELEMEDICINE: "false",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-dept-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-dept-storage-${crypto.randomUUID()}`),
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

let clinician: Session;
let reception: Session;
let nurse: Session;
let laboratory: Session;
let pharmacist: Session;
let finance: Session;
let radiology: Session;
let publicHealth: Session;
let admin: Session;
let patientId = "";
let encounterId = "";
let admissionId = "";
let admissionVersion = 1;
let theatreCaseId = "";
let theatreVersion = 1;
let labTestId = "";
let labItemId = "";
let labResultId = "";
let labOrderId = "";
let medicineId = "";
let lotId = "";
let medicationOrderId = "";
let invoiceId = "";
let programmeId = "";
let enrolmentId = "";
let deviceId = "";

beforeAll(async () => {
  clinician = await login("clinician@medveris.local");
  reception = await login("reception@medveris.local");
  nurse = await login("nurse@medveris.local");
  laboratory = await login("lab@medveris.local");
  pharmacist = await login("pharmacist@medveris.local");
  finance = await login("finance@medveris.local");
  radiology = await login("radiology@medveris.local");
  publicHealth = await login("publichealth@medveris.local");
  admin = await login("admin@medveris.local");
  const created = await expectOk(await call(reception, "/api/v1/reception/patients", {
    method: "POST",
    body: JSON.stringify({
      givenName: "Test", familyName: `Patient${Date.now()}`, dateOfBirth: "1991-03-04", sex: "female",
      identityConfidence: "confirmed-verbal",
    }),
  }), 201);
  patientId = created.patient.patientId;
  const encounter = await expectOk(await call(reception, "/api/v1/encounters", {
    method: "POST", body: JSON.stringify({ patientId, type: "walk-in", reason: "Department integration flow" }),
  }), 201);
  encounterId = encounter.encounterId;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("M2/M3 department workflows", () => {
  it("admits a patient, assigns a bed, documents nursing care and hands off", async () => {
    const wards = await expectOk(await call(clinician, "/api/v1/wards"));
    expect(wards.wards.length).toBeGreaterThan(0);
    const wardId = wards.wards[0].id;
    const createdBed = await expectOk(await call(clinician, `/api/v1/wards/${wardId}/beds`, {
      method: "POST", body: JSON.stringify({ label: `T-${Date.now()}` }),
    }), 201);
    const beds = await expectOk(await call(clinician, `/api/v1/beds?wardId=${wardId}`));
    const bed = beds.beds.find((row: any) => row.id === createdBed.bed.id && row.status === "available");
    expect(bed).toBeTruthy();

    const admission = await expectOk(await call(clinician, "/api/v1/admissions", {
      method: "POST", body: JSON.stringify({
        patientId, encounterId, wardType: "general", reason: "Observation for abdominal pain (synthetic)",
      }),
    }), 201);
    admissionId = admission.admission.id;
    const list = await expectOk(await call(clinician, "/api/v1/admissions?status=admitted"));
    const row = list.admissions.find((item: any) => item.id === admissionId);
    expect(row).toBeTruthy();
    admissionVersion = Number(row.version);

    await expectOk(await call(clinician, `/api/v1/admissions/${admissionId}/bed`, {
      method: "POST", body: JSON.stringify({ bedId: bed.id, expectedVersion: admissionVersion, reason: "Initial allocation" }),
    }));
    await expectOk(await call(nurse, `/api/v1/admissions/${admissionId}/assessments`, {
      method: "POST", body: JSON.stringify({ shift: "day", notes: "Alert, hydrated, pain controlled.", painScore: 3 }),
    }), 201);
    const task = await expectOk(await call(nurse, `/api/v1/admissions/${admissionId}/tasks`, {
      method: "POST", body: JSON.stringify({ description: "Recheck observations in four hours" }),
    }), 201);
    await expectOk(await call(nurse, `/api/v1/admissions/${admissionId}/tasks/${task.task.id}`, {
      method: "PATCH", body: JSON.stringify({ status: "completed", note: "Observations stable" }),
    }));
    await expectOk(await call(nurse, `/api/v1/admissions/${admissionId}/handoffs`, {
      method: "POST", body: JSON.stringify({ toUserId: CLINICIAN_ID, summary: "Stable; awaiting laboratory results." }),
    }), 201);
    const detail = await expectOk(await call(clinician, `/api/v1/admissions/${admissionId}`));
    expect(detail.beds.some((item: any) => item.releasedAt === null)).toBe(true);
    expect(detail.assessments.length).toBeGreaterThan(0);
  });

  it("runs a theatre case through safety checkpoints and recovery", async () => {
    const created = await expectOk(await call(clinician, "/api/v1/theatre-cases", {
      method: "POST", body: JSON.stringify({
        patientId, encounterId, procedureName: "Examination under anaesthesia (synthetic)",
        laterality: "not-applicable", site: "Abdomen", urgency: "routine",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), surgeonUserId: CLINICIAN_ID,
      }),
    }), 201);
    theatreCaseId = created.case.id;
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/preop`, {
      method: "POST", body: JSON.stringify({ investigationsReviewed: true, fitness: "Fit for procedure" }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/consent`, {
      method: "POST", body: JSON.stringify({ procedureConsent: true, siteMarked: true, consentReference: "SYNTH-CONSENT-1" }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/transitions`, {
      method: "POST", body: JSON.stringify({ status: "preop-ready", expectedVersion: theatreVersion }),
    }));
    theatreVersion += 1;
    for (const stage of ["sign-in", "time-out"]) {
      await expectOk(await call(nurse, `/api/v1/theatre-cases/${theatreCaseId}/checklist`, {
        method: "POST", body: JSON.stringify({ stage, items: { identity: true, allergies: true, site: true } }),
      }), 201);
    }
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/transitions`, {
      method: "POST", body: JSON.stringify({ status: "in-theatre", expectedVersion: theatreVersion }),
    }));
    theatreVersion += 1;
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/anesthesia`, {
      method: "POST", body: JSON.stringify({
        anesthesiaType: "General anaesthesia", notes: "Airway maintained; vitals stable.",
        startedAt: new Date().toISOString(), endedAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    }), 201);
    await expectOk(await call(nurse, `/api/v1/theatre-cases/${theatreCaseId}/checklist`, {
      method: "POST", body: JSON.stringify({ stage: "sign-out", items: { counts: true, specimens: true, wounds: true } }),
    }), 201);
    await expectOk(await call(nurse, `/api/v1/theatre-cases/${theatreCaseId}/counts`, {
      method: "POST", body: JSON.stringify({ itemType: "Swabs", expectedCount: 10, actualCount: 10 }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/transitions`, {
      method: "POST", body: JSON.stringify({ status: "recovery", expectedVersion: theatreVersion }),
    }));
    theatreVersion += 1;
    await expectOk(await call(nurse, `/api/v1/theatre-cases/${theatreCaseId}/recovery`, {
      method: "POST", body: JSON.stringify({
        respiratory: "SpO2 99% on air", circulation: "HR 78, BP 118/74", consciousness: "Alert", pain: "Mild",
        occurredAt: new Date().toISOString(),
      }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}/transitions`, {
      method: "POST", body: JSON.stringify({ status: "completed", expectedVersion: theatreVersion }),
    }));
    const detail = await expectOk(await call(clinician, `/api/v1/theatre-cases/${theatreCaseId}`));
    expect(detail.case.status).toBe("completed");
    expect(detail.checklists).toHaveLength(3);
  });

  it("orders diagnostics, receives specimens, verifies, corrects and communicates a critical result", async () => {
    const tests = await expectOk(await call(laboratory, "/api/v1/lab-tests"));
    labTestId = tests.tests[0].id;
    expect(labTestId).toBeTruthy();
    const order = await expectOk(await call(clinician, "/api/v1/diagnostic-orders", {
      method: "POST", body: JSON.stringify({
        patientId, encounterId, orderType: "laboratory", priority: "urgent",
        clinicalNote: "Rule out hyperglycaemia (synthetic).",
        items: [{ labTestId, name: "Blood glucose", specimenType: "capillary blood" }],
      }),
    }), 201);
    labOrderId = order.order.id;
    const detail = await expectOk(await call(laboratory, `/api/v1/diagnostic-orders/${labOrderId}`));
    expect(detail.items).toHaveLength(1);
    labItemId = detail.items[0].id;
    await expectOk(await call(laboratory, `/api/v1/diagnostic-orders/${labOrderId}/transitions`, {
      method: "POST", body: JSON.stringify({ status: "collected", expectedVersion: 1 }),
    }));
    const specimen = await expectOk(await call(laboratory, "/api/v1/specimens", {
      method: "POST", body: JSON.stringify({ orderItemId: labItemId, specimenType: "capillary blood" }),
    }), 201);
    await expectOk(await call(laboratory, `/api/v1/specimens/${specimen.specimen.id}`, {
      method: "PATCH", body: JSON.stringify({ status: "received" }),
    }));
    const preliminary = await expectOk(await call(laboratory, "/api/v1/lab-results", {
      method: "POST", body: JSON.stringify({
        orderItemId: labItemId, valueNum: 19.4, unitCode: "mg/dL", referenceRange: "70-140 mg/dL",
        interpretation: "critical", critical: true, status: "preliminary",
      }),
    }), 201);
    labResultId = preliminary.result.id;
    const finalCreate = await call(laboratory, "/api/v1/lab-results", {
      method: "POST", body: JSON.stringify({
        orderItemId: labItemId, valueNum: 19.4, unitCode: "mg/dL", interpretation: "critical", critical: true, status: "final",
      }),
    });
    expect([403, 409]).toContain(finalCreate.status);
    await expectOk(await call(clinician, `/api/v1/lab-results/${labResultId}/finalize`, {
      method: "POST", body: JSON.stringify({ expectedVersion: 1, note: "Critical value verified" }),
    }));
    await expectOk(await call(clinician, `/api/v1/lab-results/${labResultId}/correct`, {
      method: "POST", body: JSON.stringify({
        valueNum: 19.4, unitCode: "mg/dL", referenceRange: "70-140 mg/dL", interpretation: "critical",
        critical: true, changeReason: "Verified against analyser printout", expectedVersion: 1,
      }),
    }));
    await expectOk(await call(clinician, `/api/v1/lab-results/${labResultId}/critical-communications`, {
      method: "POST", body: JSON.stringify({ recipientUserId: CLINICIAN_ID, method: "phone", notes: "Read back confirmed" }),
    }), 201);
    const imaging = await expectOk(await call(clinician, "/api/v1/diagnostic-orders", {
      method: "POST", body: JSON.stringify({
        patientId, encounterId, orderType: "imaging", priority: "routine",
        clinicalNote: "Abdominal ultrasound (synthetic).",
        items: [{ name: "Abdominal ultrasound" }],
      }),
    }), 201);
    const imagingDetail = await expectOk(await call(radiology, `/api/v1/diagnostic-orders/${imaging.order.id}`));
    const imagingItemId = imagingDetail.items[0].id;
    const study = await expectOk(await call(radiology, "/api/v1/imaging-studies", {
      method: "POST", body: JSON.stringify({ orderItemId: imagingItemId, modality: "US", bodySite: "Abdomen" }),
    }), 201);
    const report = await expectOk(await call(radiology, "/api/v1/diagnostic-reports", {
      method: "POST", body: JSON.stringify({
        orderItemId: imagingItemId, studyId: study.study.id, findings: "No free fluid.", impression: "Normal study.",
        critical: false, status: "final",
      }),
    }), 201);
    await expectOk(await call(radiology, `/api/v1/diagnostic-reports/${report.report.id}/correct`, {
      method: "POST", body: JSON.stringify({
        findings: "No free fluid or focal lesion.", impression: "Normal study.", critical: false,
        changeReason: "Clarified wording after specialist review", expectedVersion: 1,
      }),
    }));
  });

  it("reviews, dispenses and administers medication with stock controls", async () => {
    const medicine = await expectOk(await call(pharmacist, "/api/v1/medicines", {
      method: "POST", body: JSON.stringify({
        name: `Synthetic medicine ${Date.now()}`, strength: "5 mg", form: "tablet", route: "oral",
      }),
    }), 201);
    medicineId = medicine.medicine.id;
    const lot = await expectOk(await call(pharmacist, "/api/v1/stock/lots", {
      method: "POST", body: JSON.stringify({
        medicineId, lotNumber: `SYNTH-${Date.now()}`,
        expiresOn: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
        quantity: 50, location: "Pharmacy main",
      }),
    }), 201);
    lotId = lot.lot.id;
    const order = await expectOk(await call(clinician, "/api/v1/medication-orders", {
      method: "POST", body: JSON.stringify({
        patientId, encounterId, medicineId, doseText: "5 mg", route: "oral", frequency: "once daily", durationDays: 5,
      }),
    }), 201);
    medicationOrderId = order.order.id;
    await expectOk(await call(pharmacist, `/api/v1/medication-orders/${medicationOrderId}/review`, {
      method: "POST", body: JSON.stringify({ decision: "approved", note: "No interaction identified in synthetic review" }),
    }));
    await expectOk(await call(pharmacist, "/api/v1/dispenses", {
      method: "POST", body: JSON.stringify({ orderId: medicationOrderId, lotId, quantity: 5 }),
    }), 201);
    await expectOk(await call(nurse, "/api/v1/medication-administrations", {
      method: "POST", body: JSON.stringify({
        orderId: medicationOrderId, doseText: "5 mg", administeredAt: new Date().toISOString(),
        site: "oral", status: "administered", witnessedBy: CLINICIAN_ID,
      }),
    }), 201);
    const meds = await expectOk(await call(nurse, `/api/v1/patients/${patientId}/medication`));
    expect(meds.administrations.length).toBeGreaterThan(0);
  });

  it("issues, pays and reverses an invoice without losing ledger state", async () => {
    const invoice = await expectOk(await call(finance, "/api/v1/invoices", {
      method: "POST", body: JSON.stringify({
        patientId, encounterId, items: [{ description: "Synthetic procedure fee", quantity: 1, unitPrice: 25000 }],
      }),
    }), 201);
    invoiceId = invoice.invoice.id;
    const payment = await expectOk(await call(finance, `/api/v1/invoices/${invoiceId}/payments`, {
      method: "POST", body: JSON.stringify({ invoiceId, amount: 25000, method: "cash", reference: "SYNTH-RCPT-1" }),
    }), 201);
    let detail = await expectOk(await call(finance, `/api/v1/invoices/${invoiceId}`));
    expect(detail.invoice.status).toBe("paid");
    expect(detail.payments).toHaveLength(1);
    await expectOk(await call(finance, `/api/v1/payments/${payment.payment.id}/reverse`, {
      method: "POST", body: JSON.stringify({ reason: "Synthetic test reversal with reason" }),
    }));
    detail = await expectOk(await call(finance, `/api/v1/invoices/${invoiceId}`));
    expect(detail.invoice.status).toBe("open");
    expect(detail.payments[0].reversedAt).toBeTruthy();
  });

  it("maintains programme care plans, events and advance-care documents", async () => {
    const created = await expectOk(await call(clinician, "/api/v1/programmes", {
      method: "POST", body: JSON.stringify({
        name: `Synthetic programme ${Date.now()}`, programmeType: "chronic",
        description: "Synthetic continuing care", conditionCoding: { system: "http://snomed.info/sct", version: "20240131-medveris-synthetic", code: "38341003", display: "Hypertension" },
      }),
    }), 201);
    programmeId = created.programme.id;
    const enrolment = await expectOk(await call(clinician, `/api/v1/programmes/${programmeId}/enrolments`, {
      method: "POST", body: JSON.stringify({ patientId, notes: "Enrolled for structured review" }),
    }), 201);
    enrolmentId = enrolment.enrolment.id;
    const plan = await expectOk(await call(clinician, `/api/v1/enrolments/${enrolmentId}/care-plans`, {
      method: "POST", body: JSON.stringify({
        goals: [{ description: "Maintain home BP below 140/90", targetDate: "2027-01-01" }],
        interventions: "Monthly review and medication adherence support.", reviewDue: "2026-12-01",
        changeNote: "Initial plan agreed with patient",
      }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/care-plans/${plan.carePlan.id}`, {
      method: "PUT", body: JSON.stringify({
        goals: [{ description: "Maintain home BP below 135/85", targetDate: "2027-01-01" }],
        interventions: "Monthly review, adherence support and home readings.", reviewDue: "2026-11-15",
        changeNote: "Tightened goal after review", expectedVersion: 1,
      }),
    }));
    await expectOk(await call(clinician, `/api/v1/enrolments/${enrolmentId}/events`, {
      method: "POST", body: JSON.stringify({
        eventType: "review", details: "Home readings reviewed; continue current plan.",
        occurredAt: new Date().toISOString(),
      }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/patients/${patientId}/advance-care`, {
      method: "POST", body: JSON.stringify({
        documentType: "treatment-preference", content: "Prefers oral treatment where clinically appropriate.",
        witnessedBy: "Nurse Sarah Atim",
      }),
    }), 201);
    const summary = await expectOk(await call(clinician, `/api/v1/patients/${patientId}/programmes`));
    expect(summary.carePlans[0].version).toBe(2);
    expect(summary.advanceCare.length).toBeGreaterThan(0);
  });

  it("generates aggregate-only public-health reports with small-cell suppression", async () => {
    const report = await expectOk(await call(publicHealth, "/api/v1/public-health/reports", {
      method: "POST", body: JSON.stringify({
        title: "Synthetic monthly hypertension aggregate", periodStart: "2020-01-01", periodEnd: "2030-12-31",
        conditionSystem: "http://snomed.info/sct", conditionCode: "38341003",
        caseDefinitionVersion: "synthetic-case-definition-1", minCell: 5,
      }),
    }), 201);
    const reports = await expectOk(await call(publicHealth, "/api/v1/public-health/reports"));
    const row = reports.reports.find((item: any) => item.id === report.report.id);
    expect(row).toBeTruthy();
    expect(JSON.stringify(row.aggregate)).not.toContain("patient");
    expect(JSON.stringify(row.aggregate)).not.toContain("MV-");
    await expectOk(await call(publicHealth, `/api/v1/public-health/reports/${report.report.id}/review`, {
      method: "POST", body: JSON.stringify({ decision: "reviewed", note: "Aggregate checked for suppression", expectedVersion: 1 }),
    }));
    await expectOk(await call(publicHealth, `/api/v1/public-health/reports/${report.report.id}/release`, {
      method: "POST", body: JSON.stringify({ recipient: "Synthetic District Health Office", purpose: "Statutory aggregate reporting" }),
    }), 201);
  });

  it("records telehealth consent while clearly degrading an unconfigured media adapter", async () => {
    const session = await expectOk(await call(clinician, "/api/v1/telehealth/sessions", {
      method: "POST", body: JSON.stringify({
        patientId, clinicianUserId: CLINICIAN_ID, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    }), 201);
    await expectOk(await call(clinician, `/api/v1/telehealth/sessions/${session.session.id}/consent`, {
      method: "POST", body: JSON.stringify({ consent: true, notes: "Synthetic consent for remote review" }),
    }));
    const join = await call(clinician, `/api/v1/telehealth/sessions/${session.session.id}/join`, { method: "POST", body: "{}" });
    expect(join.status).toBe(503);
    const body = await json(join);
    expect(body.error.code).toBe("dependency_unavailable");
    await expectOk(await call(clinician, `/api/v1/telehealth/sessions/${session.session.id}/complete`, {
      method: "POST", body: JSON.stringify({ connectionStatus: "failed", notes: "Media adapter unavailable" }),
    }));
  });

  it("ingests device observations through reviewed mappings and raises quality alerts", async () => {
    const created = await expectOk(await call(admin, "/api/v1/devices", {
      method: "POST", body: JSON.stringify({
        serial: `SYNTH-${Date.now()}`, manufacturer: "Synthetic Devices", model: "Monitor-1", firmware: "1.0",
        supportedMetrics: [{
          nativeCode: "HR", loincSystem: "http://loinc.org", loincVersion: "2.80-medveris-synthetic",
          loincCode: "8867-4", display: "Heart rate", unitCode: "/min",
        }],
      }),
    }), 201);
    deviceId = created.device.id;
    await expectOk(await call(clinician, `/api/v1/devices/${deviceId}/assign`, {
      method: "POST", body: JSON.stringify({ patientId, encounterId }),
    }));
    const first = await expectOk(await call(nurse, `/api/v1/devices/${deviceId}/ingest`, {
      method: "POST", body: JSON.stringify({
        eventId: `event-${crypto.randomUUID()}`, sequence: 1, nativeCode: "HR", value: 76, unit: "/min",
        measuredAt: new Date().toISOString(), quality: "valid",
      }),
    }), 201);
    expect(first.observation.id).toBeTruthy();
    await expectOk(await call(nurse, `/api/v1/devices/${deviceId}/ingest`, {
      method: "POST", body: JSON.stringify({
        eventId: `event-${crypto.randomUUID()}`, sequence: 2, nativeCode: "HR", value: 210, unit: "/min",
        measuredAt: new Date().toISOString(), quality: "questionable",
      }),
    }), 201);
    const alerts = await expectOk(await call(nurse, "/api/v1/device-alerts"));
    expect(alerts.alerts.length).toBeGreaterThan(0);
    await expectOk(await call(nurse, `/api/v1/device-alerts/${alerts.alerts[0].id}/acknowledge`, {
      method: "POST", body: JSON.stringify({ note: "Sensor repositioned and reading verified" }),
    }));
  });

  it("returns an explicit dependency error when no AI provider is configured", async () => {
    const response = await call(clinician, "/api/v1/ai/jobs", {
      method: "POST", body: JSON.stringify({ taskType: "record-summary", patientId, evidenceEntryIds: [] }),
    });
    expect(response.status).toBe(503);
    expect((await json(response)).error.code).toBe("dependency_unavailable");
  });

  it("enforces department role boundaries and tenant isolation", async () => {
    expect((await call(reception, "/api/v1/wards")).status).toBe(403);
    expect((await call(finance, "/api/v1/diagnostic-orders")).status).toBe(403);
    expect((await call(laboratory, "/api/v1/invoices")).status).toBe(403);
    expect((await call(pharmacist, "/api/v1/theatre-cases")).status).toBe(403);
    const other = await login("clinician.b@medveris.local");
    expect((await call(other, `/api/v1/admissions/${admissionId}`)).status).toBe(404);
  });
});
