import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@medveris/db";
import { CLINICIAN_ID, KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("radiology");
const NURSE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RADIOLOGIST_ID = "dededede-dede-4ded-8ded-dededededede";

let reception: Session;
let clinician: Session;
let nurse: Session;
let radiographer: Session;
let radiologist: Session;

let orderItemId = "";
let studyId = "";
let studyVersion = 1;
let templateId = "";
let reportId = "";
let draftVersion = 1;

const completeChest = {
  indication: "Synthetic: cough and fever for five days.",
  technique: "PA and lateral projections.",
  imageQuality: "adequate",
  lungs: "Synthetic finding text entered by the test.",
  pleura: "Synthetic pleura text.",
  heartMediastinum: "Synthetic mediastinum text.",
  bonesSoftTissues: "Synthetic bones text.",
  impression: "Synthetic impression entered by the test.",
};

beforeAll(async () => {
  reception = await h.login("reception@medveris.local");
  clinician = await h.login("clinician@medveris.local");
  nurse = await h.login("nurse@medveris.local");
  radiographer = await h.login("radiographer@medveris.local");
  radiologist = await h.login("radiology@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("radiology order to worklist", () => {
  it("places an imaging order that appears in the worklist awaiting a study", async () => {
    const patientId = await h.registerPatient(reception);
    const encounter = await h.post(reception, "/api/v1/encounters", { patientId, type: "walk-in", reason: "Synthetic imaging" });
    const order = await h.post(clinician, "/api/v1/diagnostic-orders", {
      patientId, encounterId: encounter.encounterId, orderType: "imaging", priority: "urgent",
      clinicalNote: "Synthetic chest imaging request.", items: [{ name: "Chest X-ray" }],
    });
    const detail = await h.expectOk(await h.call(radiographer, `/api/v1/diagnostic-orders/${order.order.id}`));
    orderItemId = detail.items[0].id;
    const worklist = await h.expectOk(await h.call(radiographer, "/api/v1/radiology/worklist?status=awaiting-study&priority=urgent"));
    expect(worklist.items.some((item: { orderItemId: string }) => item.orderItemId === orderItemId)).toBe(true);
  });

  it("registers a study with a server-generated accession and records acquisition", async () => {
    const study = await h.post(radiographer, "/api/v1/radiology/studies", {
      orderItemId, modality: "XR", bodySite: "Chest", protocol: "PA and lateral",
    });
    studyId = study.study.id;
    expect(study.study.accession).toMatch(/^RAD-[A-Z0-9]+-\d{8}-[0-9A-F]{6}$/);
    expect(study.study.acquisitionStatus).toBe("registered");
    const duplicate = await h.call(radiographer, "/api/v1/radiology/studies", {
      method: "POST", body: JSON.stringify({ orderItemId, modality: "XR", bodySite: "Chest" }),
    });
    expect(duplicate.status).toBe(409);
    await h.post(radiographer, `/api/v1/radiology/studies/${studyId}/acquisition`, { status: "acquired", expectedVersion: studyVersion }, 200);
    studyVersion += 1;
  });
});

describe("templates", () => {
  it("refuses template approval by a radiographer and records a radiologist's approval", async () => {
    const denied = await h.call(radiographer, "/api/v1/radiology/templates", {
      method: "POST", body: JSON.stringify({ code: "chest-xray", approvalNote: "Synthetic attempt by a radiographer" }),
    });
    expect(denied.status).toBe(403);
    const approved = await h.post(radiologist, "/api/v1/radiology/templates", {
      code: "chest-xray", approvalNote: "Synthetic approval for automated testing only",
    });
    templateId = approved.template.id;
    const templates = await h.expectOk(await h.call(radiographer, "/api/v1/radiology/templates"));
    const chest = templates.templates.find((item: { id: string }) => item.id === templateId);
    expect(chest.definition.code).toBe("chest-xray");
    expect(chest.definition.fields.find((field: { key: string }) => field.key === "lungs").required).toBe(true);
  });
});

describe("structured report drafting and sign-off", () => {
  it("creates a draft from the approved template with no pre-filled findings", async () => {
    const created = await h.post(radiographer, "/api/v1/radiology/reports", { studyId, templateId });
    reportId = created.report.id;
    const detail = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/reports/${reportId}`));
    expect(detail.report.status).toBe("draft");
    expect(detail.report.templateCode).toBe("chest-xray");
    expect(detail.report.content).toEqual({ fields: {}, measurements: [] });
    expect(detail.images).toMatchObject({ state: "unavailable", available: false });
  });

  it("autosaves drafts with conflict protection and keeps them across sessions", async () => {
    const saved = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/reports/${reportId}/draft`, {
      method: "PUT", body: JSON.stringify({
        content: { fields: { indication: completeChest.indication, lungs: "Partial draft" }, measurements: [] },
        urgency: "routine", expectedVersion: draftVersion,
      }),
    }));
    draftVersion = saved.draftVersion;
    const stale = await h.call(radiologist, `/api/v1/radiology/reports/${reportId}/draft`, {
      method: "PUT", body: JSON.stringify({ content: { fields: {}, measurements: [] }, urgency: "routine", expectedVersion: 1 }),
    });
    expect(stale.status).toBe(409);
    const invalid = await h.call(radiographer, `/api/v1/radiology/reports/${reportId}/draft`, {
      method: "PUT", body: JSON.stringify({ content: { fields: { imageQuality: "excellent" }, measurements: [] }, urgency: "routine", expectedVersion: draftVersion }),
    });
    expect(invalid.status).toBe(422);
    const freshSession = await h.login("radiographer@medveris.local");
    const detail = await h.expectOk(await h.call(freshSession, `/api/v1/radiology/reports/${reportId}`));
    expect(detail.report.content.fields.lungs).toBe("Partial draft");
    expect(detail.report.draftVersion).toBe(draftVersion);
  });

  it("does not let a radiographer sign and rejects incomplete required sections", async () => {
    const byRadiographer = await h.call(radiographer, `/api/v1/radiology/reports/${reportId}/sign`, {
      method: "POST", body: JSON.stringify({ kind: "final", expectedVersion: draftVersion, attest: true }),
    });
    expect(byRadiographer.status).toBe(403);
    const incomplete = await h.call(radiologist, `/api/v1/radiology/reports/${reportId}/sign`, {
      method: "POST", body: JSON.stringify({ kind: "final", expectedVersion: draftVersion, attest: true }),
    });
    expect(incomplete.status).toBe(422);
    const details = (await h.json(incomplete)).error.details.map((item: { message: string }) => item.message);
    expect(details).toContain("Technique and protocol is required");
    const unattested = await h.call(radiologist, `/api/v1/radiology/reports/${reportId}/sign`, {
      method: "POST", body: JSON.stringify({ kind: "final", expectedVersion: draftVersion }),
    });
    expect(unattested.status).toBe(422);
  });

  it("signs a complete critical report once and refuses silent overwrites", async () => {
    const saved = await h.expectOk(await h.call(radiologist, `/api/v1/radiology/reports/${reportId}/draft`, {
      method: "PUT", body: JSON.stringify({
        content: { fields: completeChest, measurements: [{ label: "Synthetic opacity", value: 23, unit: "mm" }] },
        urgency: "critical", expectedVersion: draftVersion,
      }),
    }));
    draftVersion = saved.draftVersion;
    const signed = await h.post(radiologist, `/api/v1/radiology/reports/${reportId}/sign`, { kind: "final", expectedVersion: draftVersion, attest: true }, 200);
    expect(signed.signedVersion).toBe(1);
    expect(signed.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const overwrite = await h.call(radiologist, `/api/v1/radiology/reports/${reportId}/draft`, {
      method: "PUT", body: JSON.stringify({ content: { fields: completeChest, measurements: [] }, urgency: "routine", expectedVersion: draftVersion + 1 }),
    });
    expect(overwrite.status).toBe(409);
    await expect(withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: RADIOLOGIST_ID, actorKind: "staff", roles: ["radiology"] },
      async (tx) => tx`update radiology_report_versions set content = '{}'::jsonb where report_id = ${reportId}`)).rejects.toThrow();
  });
});

describe("release, critical findings, addenda and corrections", () => {
  it("blocks release of a critical report until the finding is communicated", async () => {
    const blocked = await h.call(radiologist, `/api/v1/radiology/reports/${reportId}/release`, {
      method: "POST", body: JSON.stringify({ releaseNote: "Synthetic release" }),
    });
    expect(blocked.status).toBe(409);
    await h.post(radiologist, `/api/v1/radiology/reports/${reportId}/critical-communications`, {
      recipientUserId: NURSE_ID, method: "phone", findingSummary: "Synthetic critical finding read back by the nurse.",
    });
    await h.post(radiologist, `/api/v1/radiology/reports/${reportId}/release`, { releaseNote: "Synthetic release after communication" }, 200);
  });

  it("flags an unacknowledged finding as overdue, escalates it and records acknowledgement by the escalation recipient", async () => {
    await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: RADIOLOGIST_ID, actorKind: "staff", roles: ["radiology"] }, async (tx) => tx`
      update radiology_critical_communications set communicated_at = now() - interval '3 hours' where report_id = ${reportId}
    `);
    const open = await h.expectOk(await h.call(radiologist, "/api/v1/radiology/critical-communications"));
    const communication = open.communications.find((item: { reportId: string }) => item.reportId === reportId);
    expect(communication.overdue).toBe(true);
    const byRadiographer = await h.call(radiographer, `/api/v1/radiology/critical-communications/${communication.id}/acknowledge`, {
      method: "POST", body: JSON.stringify({ note: "Not a clinician" }),
    });
    expect(byRadiographer.status).toBe(403);
    await h.post(radiologist, `/api/v1/radiology/critical-communications/${communication.id}/escalate`, {
      toUserId: CLINICIAN_ID, note: "Synthetic escalation: nurse recipient did not acknowledge.",
    }, 200);
    await h.post(clinician, `/api/v1/radiology/critical-communications/${communication.id}/acknowledge`, { note: "Reviewed and acted on" }, 200);
    const after = await h.expectOk(await h.call(radiologist, "/api/v1/radiology/critical-communications?state=all"));
    const done = after.communications.find((item: { id: string }) => item.id === communication.id);
    expect(done.acknowledgedAt).toBeTruthy();
    expect(done.escalatedToName).toBeTruthy();
    void nurse;
  });

  it("appends an addendum and a correction while preserving the original signed version", async () => {
    await h.post(radiologist, `/api/v1/radiology/reports/${reportId}/addenda`, {
      text: "Synthetic addendum after comparison review.", reason: "Comparison became available", attest: true,
    });
    const corrected = await h.post(radiologist, `/api/v1/radiology/reports/${reportId}/corrections`, {
      content: { fields: { ...completeChest, impression: "Synthetic corrected impression." }, measurements: [] },
      urgency: "critical", reason: "Synthetic correction of the impression wording", expectedSignedVersion: 1, attest: true,
    }, 200);
    expect(corrected.signedVersion).toBe(2);
    const detail = await h.expectOk(await h.call(clinician, `/api/v1/radiology/reports/${reportId}`));
    expect(detail.report.status).toBe("corrected");
    expect(detail.versions.map((version: { version: number; kind: string }) => [version.version, version.kind])).toEqual([[1, "final"], [2, "correction"]]);
    expect(detail.versions[0].content.fields.impression).toBe(completeChest.impression);
    expect(detail.addenda[0].signedByName).toBe("Dr Ruth Radiologist");
    expect(detail.addenda[0].appliesToVersion).toBe(1);
  });

  it("derives turnaround from persisted timestamps and shows the clinician the signed report", async () => {
    const worklist = await h.expectOk(await h.call(radiologist, "/api/v1/radiology/worklist?status=released"));
    const item = worklist.items.find((row: { reportId: string }) => row.reportId === reportId);
    expect(item.stage).toBe("released");
    expect(item.minutesOrderToSign).toBeGreaterThanOrEqual(0);
    expect(item.minutesAcquiredToSign).toBeGreaterThanOrEqual(0);
    const view = await h.expectOk(await h.call(clinician, `/api/v1/radiology/orders/${orderItemId}/report`));
    expect(view.signedReport.latest.kind).toBe("correction");
    expect(view.images.available).toBe(false);
  });
});
