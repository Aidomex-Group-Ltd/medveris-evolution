import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "./support.js";

const h = createHarness("clinical-notes-stage2");

let clinician: Awaited<ReturnType<typeof h.login>>;
let reception: Awaited<ReturnType<typeof h.login>>;
let patientId = "";
let encounterId = "";
let entryId = "";

beforeAll(async () => {
  [clinician, reception] = await Promise.all([
    h.login("clinician@medveris.local"),
    h.login("reception@medveris.local"),
  ]);
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("clinical notes stage 2", () => {
  it("creates a patient, encounter and a typed draft note", async () => {
    const patient = await h.post(reception, "/api/v1/reception/patients", {
      givenName: "Stage2",
      familyName: `Note${Date.now()}`,
      dateOfBirth: "1988-05-05",
      sex: "male",
      identityConfidence: "confirmed-verbal",
    });
    patientId = patient.patient.patientId as string;

    const encounter = await h.post(reception, "/api/v1/encounters", {
      patientId,
      type: "walk-in",
      reason: "stage 2 note type test",
    });
    encounterId = encounter.encounterId as string;

    // Move the encounter into a note-able state via triage-complete is not required here;
    // the clinical route will transition triaged->in-progress on first note creation.
    const triage = await h.call(clinician, `/api/v1/encounters/${encounterId}/triage`, {
      method: "POST",
      body: JSON.stringify({
        complaint: "routine check",
        urgency: "routine",
        notes: "stage 2",
        allergyState: "none",
      }),
    });
    expect(triage.status).toBe(200);

    const created = await h.post(
      clinician,
      `/api/v1/encounters/${encounterId}/entries`,
      {
        title: "Admission note",
        subjective: "Admitted for observation",
        objective: "Stable",
        assessment: "Observe overnight",
        plan: "Recheck in the morning",
        clinicalOccurredAt: new Date().toISOString(),
        changeNote: "stage 2 note type",
        noteType: "admission",
      },
      201,
    );
    entryId = created.entryId as string;
    expect(created.version).toBe(1);
  });

  it("returns note type, archived and void fields on the encounter read", async () => {
    const detail = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}`));
    const entry = detail.entries.find((e: any) => e.id === entryId);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("created entry not in encounter detail");
    expect(entry.noteType).toBe("admission");
    expect(entry.archivedAt).toBeNull();
    expect(entry.voidReason).toBeNull();
    expect(entry.attachmentCount).toBe(0);
    expect(entry.latestVersion).toBe(1);
  });

  it("lists the encounter timeline with the typed note", async () => {
    const timeline = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}/timeline`));
    expect(Array.isArray(timeline.entries)).toBe(true);
    const row = timeline.entries.find((e: any) => e.id === entryId);
    expect(row).toBeDefined();
    if (!row) throw new Error("timeline missing created entry");
    expect(row.noteType).toBe("admission");
    expect(row.status).toBe("draft");
    expect(row.archivedAt).toBeNull();
    expect(row.voidReason).toBeNull();
    expect(row.attachmentCount).toBe(0);
  });

  it("records a signed note version with note type retained", async () => {
    const signed = await h.call(clinician, `/api/v1/entries/${entryId}/sign`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(signed.status).toBe(200);
    await h.json(signed);

    const versions = await h.expectOk(await h.call(clinician, `/api/v1/entries/${entryId}/versions`));
    const latest = versions.versions[versions.versions.length - 1] as any;
    expect(latest.status).toBe("signed");
    expect(latest.noteType).toBe("admission");
  });

  it("reflects signed state and note type in timeline", async () => {
    const timeline = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}/timeline`));
    const row = timeline.entries.find((e: any) => e.id === entryId) as any;
    expect(row.status).toBe("signed");
    expect(row.noteType).toBe("admission");
    expect(row.signedAt).toBeDefined();
  });

  it("allows archiving the note and shows it in timeline as archived", async () => {
    const archived = await h.call(clinician, `/api/v1/entries/${entryId}/archive`, {
      method: "POST",
      body: JSON.stringify({ reason: "Superseded by a later consultation" }),
    });
    expect(archived.status).toBe(200);

    const timeline = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}/timeline`));
    const row = timeline.entries.find((e: any) => e.id === entryId) as any;
    expect(row.archivedAt).toBeDefined();
    expect(new Date(row.archivedAt!).toISOString()).toBe(row.archivedAt);
  });

  it("allows unarchiving is not provided; re-archive is rejected as already archived", async () => {
    const again = await h.call(clinician, `/api/v1/entries/${entryId}/archive`, {
      method: "POST",
      body: JSON.stringify({ reason: "duplicate" }),
    });
    expect(again.status).toBe(409);
  });

  it("rejects voiding an archived note", async () => {
    const voided = await h.call(clinician, `/api/v1/entries/${entryId}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, reason: "This should not succeed" }),
    });
    expect(voided.status).toBe(409);
  });

  it("creates a fresh note so voiding can be tested on a non-archived record", async () => {
    const created = await h.post(
      clinician,
      `/api/v1/encounters/${encounterId}/entries`,
      {
        title: "Progress note",
        subjective: "Improved overnight",
        objective: "Afebrile",
        assessment: "Continuing recovery",
        plan: "Continue current plan",
        clinicalOccurredAt: new Date().toISOString(),
        changeNote: "progress note for void test",
        noteType: "progress",
      },
      201,
    );
    const progressId = created.entryId as string;

    await h.call(clinician, `/api/v1/entries/${progressId}/sign`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    // Void the progress note
    const voided = await h.call(clinician, `/api/v1/entries/${progressId}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, reason: "Documentation error; entered in error after review" }),
    });
    expect(voided.status).toBe(200);
    const body = await h.json(voided);
    expect(body.voided.version).toBe(2);

    // Timeline should exclude voided notes
    const timeline = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}/timeline`));
    expect(timeline.entries.some((e: any) => e.id === progressId)).toBe(false);

    // Void again should be rejected
    const again = await h.call(clinician, `/api/v1/entries/${progressId}/void`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 2, reason: "duplicate attempt" }),
    });
    expect(again.status).toBe(409);
  });

  it("attaches an upload to a note and removes it", async () => {
    // Create a fresh note for attachment tests (the earlier notes are archived/voided)
    const created = await h.post(
      clinician,
      `/api/v1/encounters/${encounterId}/entries`,
      {
        title: "Nursing note",
        subjective: "Morning round",
        objective: "Onwards",
        assessment: "Stable",
        plan: "Continue",
        clinicalOccurredAt: new Date().toISOString(),
        changeNote: "attachment test note",
        noteType: "nursing",
      },
      201,
    );
    const attachEntryId = created.entryId as string;

    // Upload a small file in the same tenant
    const upload = await h.post(
      clinician,
      "/api/v1/uploads",
      {
        filename: "stage2-attach.png",
        declaredType: "image/png",
        patientId,
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64"),
      },
      201,
    );
    const uploadId = upload.upload.id as string;

    // Link the upload to the note
    const linked = await h.call(clinician, `/api/v1/entries/${attachEntryId}/attachments`, {
      method: "POST",
      body: JSON.stringify({ uploadId }),
    });
    expect(linked.status).toBe(201);
    const linkBody = await h.json(linked);
    expect(linkBody.attachmentId).toBeDefined();

    // Verify attachment count in timeline
    const timeline = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}/timeline`));
    const row = timeline.entries.find((e: any) => e.id === attachEntryId) as any;
    expect(row.attachmentCount).toBe(1);

    // Remove the attachment
    const removed = await h.call(clinician, `/api/v1/entries/${attachEntryId}/attachments/${uploadId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const timeline2 = await h.expectOk(await h.call(clinician, `/api/v1/encounters/${encounterId}/timeline`));
    const row2 = timeline2.entries.find((e: any) => e.id === attachEntryId) as any;
    expect(row2.attachmentCount).toBe(0);

    // Removing again is not found
    const again = await h.call(clinician, `/api/v1/entries/${attachEntryId}/attachments/${uploadId}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("rejects linking an upload from a different patient", async () => {
    // Create another patient and upload in the same tenant
    const other = await h.post(reception, "/api/v1/reception/patients", {
      givenName: "Other",
      familyName: `Patient${Date.now()}`,
      dateOfBirth: "1999-12-31",
      sex: "female",
      identityConfidence: "confirmed-verbal",
    });
    const otherPatientId = other.patient.patientId as string;

    const otherEncounter = await h.post(reception, "/api/v1/encounters", {
      patientId: otherPatientId,
      type: "walk-in",
      reason: "other patient",
    });

    // Triage the other encounter so a note can be created
    await h.call(clinician, `/api/v1/encounters/${otherEncounter.encounterId}/triage`, {
      method: "POST",
      body: JSON.stringify({ complaint: "other", urgency: "routine", allergyState: "none" }),
    });

    await h.post(
      clinician,
      `/api/v1/encounters/${otherEncounter.encounterId}/entries`,
      {
        title: "Other note",
        subjective: "x",
        objective: "x",
        assessment: "x",
        plan: "x",
        clinicalOccurredAt: new Date().toISOString(),
        changeNote: "other",
        noteType: "consultation",
      },
      201,
    );

    const otherUpload = await h.post(
      clinician,
      "/api/v1/uploads",
      {
        filename: "other.png",
        declaredType: "image/png",
        patientId: otherPatientId,
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]).toString("base64"),
      },
      201,
    );

    const bad = await h.call(clinician, `/api/v1/entries/${entryId}/attachments`, {
      method: "POST",
      body: JSON.stringify({ uploadId: otherUpload.upload.id }),
    });
    expect(bad.status).toBe(403);
  });
});
