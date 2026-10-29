import { expect, test, type Browser, type Page } from "./fixtures.js";

/**
 * Department journeys A–G. Every journey runs in real browser sessions signed in through the UI with MFA.
 * Steps marked "UI" are performed by clicking through the interface; steps marked "session API" call the
 * same /api/v1 endpoints the UI uses from that authenticated browser session (cookie + CSRF), and each
 * journey ends by checking the resulting state in the department's own page.
 */

const PASSWORD = "Medveris!2026";

interface Session {
  page: Page;
  api: <T = any>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown, expected?: number) => Promise<T>;
  close: () => Promise<void>;
}

async function signInStaff(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function session(browser: Browser, email: string, tenantId?: string): Promise<Session> {
  const context = await browser.newContext({ baseURL: "http://localhost:5173" });
  const page = await context.newPage();
  await signInStaff(page, email);
  let csrf = (await (await page.request.get("/api/v1/me")).json()).csrfToken as string;
  const api: Session["api"] = async (method, path, body, expected) => {
    const response = await page.request.fetch(`/api/v1${path}`, { method, data: body, headers: { "x-medveris-csrf": csrf } });
    const text = await response.text();
    expect(response.status(), `${method} ${path}: ${text.slice(0, 300)}`).toBe(expected ?? (method === "POST" ? 201 : 200));
    return text ? JSON.parse(text) : null;
  };
  if (tenantId) {
    await api("POST", "/me/context", { tenantId }, 200);
    csrf = (await (await page.request.get("/api/v1/me")).json()).csrfToken as string;
    await page.goto("/");
  }
  return { page, api, close: () => context.close() };
}

async function newPatient(reception: Session, label: string) {
  const familyName = `${label}${Date.now()}`;
  const created = await reception.api<{ patient: { patientId: string; publicId: string } }>("POST", "/reception/patients", {
    givenName: "Journey", familyName, dateOfBirth: "1990-05-05", sex: "female", identityConfidence: "confirmed-verbal",
  });
  const encounter = await reception.api<{ encounterId: string }>("POST", "/encounters", { patientId: created.patient.patientId, type: "walk-in", reason: `${label} journey` });
  return { familyName, patientId: created.patient.patientId, publicId: created.patient.publicId, encounterId: encounter.encounterId };
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test("Journey A — outpatient: registration, walk-in encounter and clinician worklist", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const familyName = `Outpatient${Date.now()}`;
  const page = reception.page;
  await page.goto("/patients");
  await page.getByLabel("Given name").fill("Journey");
  await page.getByLabel("Family name", { exact: true }).last().fill(familyName);
  await page.locator("#reg-dob").fill("1988-03-03");
  await page.getByRole("button", { name: "Register patient" }).click();
  await expect(page.getByText(/Registered MV-/)).toBeVisible();
  await page.getByLabel("Encounter reason").fill("Journey A walk-in consultation");
  await page.getByRole("button", { name: "Start walk-in encounter" }).click();
  await expect(page).toHaveURL(/\/encounters\/[0-9a-f-]+$/);
  await reception.close();

  const clinician = await session(browser, "clinician@medveris.local");
  await clinician.page.getByRole("link", { name: "Clinical worklist", exact: true }).click();
  const row = clinician.page.getByRole("row", { name: new RegExp(familyName) });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Open" }).click();
  await expect(clinician.page.getByRole("heading", { level: 1 })).toContainText(familyName);
  await clinician.close();
});

test("Journey B — laboratory: order, specimen, result, independent validation, release, clinician review", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const patient = await newPatient(reception, "Lab");
  await reception.close();
  const lab = await session(browser, "lab@medveris.local");
  const clinician = await session(browser, "clinician@medveris.local");
  const tests = await lab.api<{ tests: Array<{ id: string; name: string; specimenType: string }> }>("GET", "/lab-tests");
  const order = await clinician.api<{ order: { id: string } }>("POST", "/diagnostic-orders", {
    patientId: patient.patientId, encounterId: patient.encounterId, orderType: "laboratory", priority: "routine",
    clinicalNote: "Journey B synthetic request.", items: [{ labTestId: tests.tests[0]!.id, name: tests.tests[0]!.name, specimenType: "capillary blood" }],
  });
  const detail = await lab.api<{ items: Array<{ id: string }> }>("GET", `/diagnostic-orders/${order.order.id}`);
  await lab.api("POST", `/diagnostic-orders/${order.order.id}/transitions`, { status: "collected", expectedVersion: 1 }, 200);
  const specimen = await lab.api<{ specimen: { id: string } }>("POST", "/specimens", { orderItemId: detail.items[0]!.id, specimenType: "capillary blood" });
  await lab.api("PATCH", `/specimens/${specimen.specimen.id}`, { status: "received" }, 200);
  const result = await lab.api<{ result: { id: string } }>("POST", "/lab-results", {
    orderItemId: detail.items[0]!.id, valueNum: 101, unitCode: "mg/dL", referenceRange: "70-140 mg/dL", interpretation: "normal", critical: false, status: "preliminary",
  });
  await lab.api("POST", `/lab-results/${result.result.id}/finalize`, { expectedVersion: 1 }, 403);
  await lab.close();
  const validator = await session(browser, "labvalidator@medveris.local");
  await validator.api("POST", `/lab-results/${result.result.id}/finalize`, { expectedVersion: 1, note: "Journey B technical validation" }, 200);
  await validator.close();
  await clinician.api("POST", `/lab-results/${result.result.id}/release`, { releaseNote: "Journey B release" }, 200);

  await clinician.page.goto(`/diagnostics/orders/${order.order.id}`);
  await expect(clinician.page.getByRole("heading", { level: 1 })).toContainText(patient.familyName);
  await expect(clinician.page.getByText(/101/).first()).toBeVisible();
  await expect(clinician.page.getByText(/final/i).first()).toBeVisible();
  await clinician.close();
});

test("Journey C — radiology: order, study, structured report, radiologist sign-off, release, clinician view", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const patient = await newPatient(reception, "Rad");
  await reception.close();
  const clinician = await session(browser, "clinician@medveris.local");
  const order = await clinician.api<{ order: { id: string } }>("POST", "/diagnostic-orders", {
    patientId: patient.patientId, encounterId: patient.encounterId, orderType: "imaging", priority: "urgent",
    clinicalNote: "Journey C synthetic chest imaging.", items: [{ name: "Chest X-ray" }],
  });

  // UI: the radiologist approves the chest X-ray template for the facility if it is not yet approved.
  const radiologist = await session(browser, "radiology@medveris.local");
  await radiologist.page.goto("/radiology");
  await radiologist.page.getByRole("tab", { name: "Templates" }).click();
  const chestRow = radiologist.page.getByRole("row", { name: /Chest X-ray/ });
  if (await chestRow.getByText("not approved").count()) {
    await chestRow.getByRole("button", { name: "Review and approve" }).click();
    await radiologist.page.getByLabel("Approval note").fill("Synthetic approval for browser journey testing only.");
    await radiologist.page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(radiologist.page.getByText("Template approved for this facility.")).toBeVisible();
  }

  // UI: the radiographer registers the study, marks it acquired, starts and drafts the structured report.
  const radiographer = await session(browser, "radiographer@medveris.local");
  const rpage = radiographer.page;
  await rpage.goto("/radiology");
  const row = () => rpage.getByRole("row", { name: new RegExp(patient.familyName) });
  await row().getByRole("button", { name: "Register study" }).click();
  await row().getByLabel("Body site").fill("Chest");
  await row().getByRole("button", { name: "Register", exact: true }).click();
  await row().getByRole("button", { name: "Mark acquired" }).click();
  const templateValue = await row().getByLabel("Template").locator("option", { hasText: "Chest X-ray" }).first().getAttribute("value");
  await row().getByLabel("Template").selectOption(templateValue!);
  await row().getByRole("button", { name: "Start report" }).click();
  await expect(rpage).toHaveURL(/\/radiology\/reports\/[0-9a-f-]+$/);
  const reportUrl = rpage.url();
  await expect(rpage.getByText(/DICOMweb unavailable/)).toBeVisible();
  await rpage.getByLabel("Clinical indication (required)").fill("Journey C: synthetic cough.");
  await rpage.getByLabel("Technique and protocol (required)").fill("PA projection.");
  await rpage.getByLabel("Image quality (required)").selectOption("adequate");
  for (const label of ["Lungs and airways", "Pleura", "Heart and mediastinum", "Bones and soft tissues"]) {
    await rpage.getByLabel(`${label} (required)`).fill(`Journey C synthetic text for ${label.toLowerCase()}.`);
  }
  await rpage.getByLabel("Impression (required)").fill("Journey C synthetic impression.");
  await expect(rpage.getByText("All required sections are complete.")).toBeVisible();
  await expect(rpage.getByText(/^Saved /)).toBeVisible({ timeout: 20_000 });
  await expect(rpage.getByRole("button", { name: "Sign final report" })).toHaveCount(0);
  await radiographer.close();

  // UI: the radiologist reopens the persisted draft, signs it final and releases it.
  const page = radiologist.page;
  await page.goto(reportUrl);
  await expect(page.getByLabel("Impression (required)")).toHaveValue("Journey C synthetic impression.");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Sign final report" }).click();
  await expect(page.getByRole("heading", { name: "Signed report actions" })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept("Released to the requesting clinician (journey C)"));
  await page.getByRole("button", { name: "Release report" }).click();
  await expect(page.getByText(/^Released /)).toBeVisible();
  await radiologist.close();

  // UI: the requesting clinician sees the signed structured report on the order.
  await clinician.page.goto(`/diagnostics/orders/${order.order.id}`);
  await expect(clinician.page.getByText("Journey C synthetic impression.")).toBeVisible();
  await expect(clinician.page.getByText(/Images: unavailable/)).toBeVisible();
  await clinician.close();
});

test("Journey D — pharmacy: order, pharmacist review, dispense with stock update", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const patient = await newPatient(reception, "Pharm");
  await reception.close();
  const pharmacist = await session(browser, "pharmacist@medveris.local");
  const clinician = await session(browser, "clinician@medveris.local");
  const lotNumber = `JRN-${Date.now()}`;
  const medicine = await pharmacist.api<{ medicine: { id: string } }>("POST", "/medicines", { name: `Journey medicine ${Date.now()}`, strength: "5 mg", form: "tablet", route: "oral" });
  const lot = await pharmacist.api<{ lot: { id: string } }>("POST", "/stock/lots", {
    medicineId: medicine.medicine.id, lotNumber, expiresOn: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10), quantity: 50, location: "Pharmacy main",
  });
  const order = await clinician.api<{ order: { id: string } }>("POST", "/medication-orders", {
    patientId: patient.patientId, encounterId: patient.encounterId, medicineId: medicine.medicine.id, doseText: "5 mg", route: "oral", frequency: "once daily", durationDays: 5,
  });
  await clinician.close();
  await pharmacist.api("POST", "/dispenses", { orderId: order.order.id, lotId: lot.lot.id, quantity: 5 }, 409);
  await pharmacist.api("POST", `/medication-orders/${order.order.id}/review`, { decision: "approved", note: "Journey D synthetic review" }, 200);
  await pharmacist.api("POST", "/dispenses", { orderId: order.order.id, lotId: lot.lot.id, quantity: 5 });

  await pharmacist.page.getByRole("link", { name: "Pharmacy", exact: true }).click();
  await pharmacist.page.getByRole("tab", { name: "Stock", exact: true }).click();
  const lotRow = pharmacist.page.getByRole("row", { name: new RegExp(lotNumber) });
  await expect(lotRow).toBeVisible();
  await expect(lotRow).toContainText("45");
  await pharmacist.close();
});

test("Journey E — inpatient: admission, bed allocation, nursing care, discharge", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const patient = await newPatient(reception, "Ward");
  await reception.close();
  const clinician = await session(browser, "clinician@medveris.local");
  const nurse = await session(browser, "nurse@medveris.local");
  const wards = await clinician.api<{ wards: Array<{ id: string }> }>("GET", "/wards");
  const bedLabel = `J-${Date.now()}`;
  const bed = await clinician.api<{ bed: { id: string } }>("POST", `/wards/${wards.wards[0]!.id}/beds`, { label: bedLabel });
  const admission = await clinician.api<{ admission: { id: string } }>("POST", "/admissions", {
    patientId: patient.patientId, encounterId: patient.encounterId, wardType: "general", reason: "Journey E synthetic observation",
  });
  await clinician.api("POST", `/admissions/${admission.admission.id}/bed`, { bedId: bed.bed.id, expectedVersion: 1, reason: "Initial allocation" }, 200);
  await nurse.api("POST", `/admissions/${admission.admission.id}/assessments`, { shift: "day", notes: "Journey E synthetic nursing assessment.", painScore: 2 });

  await nurse.page.goto(`/wards/admissions/${admission.admission.id}`);
  await expect(nurse.page.getByRole("heading", { level: 1 })).toContainText(patient.familyName);
  await expect(nurse.page.getByText(bedLabel).first()).toBeVisible();
  await expect(nurse.page.getByText("Journey E synthetic nursing assessment.")).toBeVisible();
  await nurse.close();

  await clinician.api("POST", `/admissions/${admission.admission.id}/transition`, { status: "discharged", expectedVersion: 2, summary: "Journey E synthetic discharge." }, 200);
  await clinician.page.goto(`/wards/admissions/${admission.admission.id}`);
  await expect(clinician.page.getByText(/discharged/i).first()).toBeVisible();
  await clinician.close();
});

test("Journey F — maternity: episode, labour observation, delivery and newborn", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const patient = await newPatient(reception, "Mat");
  await reception.close();
  const nurse = await session(browser, "nurse@medveris.local");
  const episode = await nurse.api<{ episode: { id: string } }>("POST", "/maternity/episodes", { patientId: patient.patientId, gravidity: 1, parity: 0, riskLevel: "low", datingBasis: "ultrasound" });
  await nurse.api("POST", `/maternity/episodes/${episode.episode.id}/observations`, {
    templateType: "partograph", clinicalOccurredAt: new Date().toISOString(), maternal: { pulse: 80, systolic: 116, diastolic: 72, cervicalDilationCm: 5 }, fetal: { heartRate: 140, position: "cephalic" },
  });
  await nurse.api("POST", `/maternity/episodes/${episode.episode.id}/delivery`, { deliveredAt: new Date().toISOString(), mode: "spontaneous-vaginal", outcome: "live-birth", bloodLossMl: 200 });
  const babyName = `Baby${Date.now()}`;
  await nurse.api("POST", `/maternity/episodes/${episode.episode.id}/newborns`, { familyName: babyName, sex: "male", weightG: 3200, apgar1: 9, apgar5: 10 });

  await nurse.page.getByRole("link", { name: "Maternity", exact: true }).click();
  await expect(nurse.page.getByRole("heading", { name: "Maternity and labour" })).toBeVisible();
  await expect(nurse.page.getByRole("row", { name: new RegExp(patient.familyName) })).toBeVisible();
  await nurse.close();
});

test("Journey G — finance: invoice, manual payment, no provider-confirmed payment claimed", async ({ browser }) => {
  const reception = await session(browser, "reception@medveris.local");
  const patient = await newPatient(reception, "Fin");
  await reception.close();
  const finance = await session(browser, "finance@medveris.local");
  const invoice = await finance.api<{ invoice: { id: string } }>("POST", "/invoices", {
    patientId: patient.patientId, encounterId: patient.encounterId, items: [{ description: "Journey G consultation fee", quantity: 1, unitPrice: 15000 }],
  });
  await finance.api("POST", `/invoices/${invoice.invoice.id}/payments`, { invoiceId: invoice.invoice.id, amount: 15000, method: "cash", reference: "JRN-G-RECEIPT" });

  await finance.page.goto(`/finance/invoices/${invoice.invoice.id}`);
  await expect(finance.page.getByText("JRN-G-RECEIPT").first()).toBeVisible();
  await expect(finance.page.getByText(/paid/i).first()).toBeVisible();
  await expect(finance.page.getByText("Fully paid")).toBeVisible();
  // A manually recorded payment is shown as received, never as a confirmed mobile money payment.
  await expect(finance.page.getByRole("table", { name: "Payments" }).getByText(/mobile money/i)).toHaveCount(0);

  await finance.page.goto("/reports");
  await finance.page.getByLabel("Report").selectOption({ label: "Billing and payment reconciliation" });
  await finance.page.getByRole("button", { name: "Run report" }).click();
  await expect(finance.page.getByText("Provider-confirmed payments")).toBeVisible();
  await expect(finance.page.getByText(/unavailable/).first()).toBeVisible();
  await finance.close();
});
