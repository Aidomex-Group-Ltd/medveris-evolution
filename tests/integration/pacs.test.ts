import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@medveris/db";
import { DicomwebClient } from "../../apps/api/src/integrations/dicomweb.js";
import { FakePacs, syntheticStudy } from "./fake-pacs.js";
import { KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function auditRows(action: string, resourceId: string) {
  return withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: ADMIN_ID, actorKind: "staff", roles: ["facility_admin"] },
    async (tx) => tx`select metadata from audit_events where action = ${action} and resource_id = ${resourceId}`);
}

// A fresh endpoint per run, so verification records from earlier runs never apply.
const BASE_URL = `https://pacs-${crypto.randomUUID()}.example.test/dicom-web`;
const pacs = new FakePacs(BASE_URL);
const h = createHarness("pacs", {
  env: {
    FEATURE_DICOMWEB: "true",
    DICOMWEB_BASE_URL: BASE_URL,
    DICOMWEB_AUTH: "basic",
    DICOMWEB_USERNAME: "medveris",
    DICOMWEB_PASSWORD: "synthetic-pacs-password",
  },
  deps: (config) => ({ dicomweb: new DicomwebClient(config.dicomweb, pacs.fetch) }),
});

let reception: Session;
let clinician: Session;
let nurse: Session;
let radiographer: Session;
let laboratory: Session;
let operator: Session;

let studyId = "";
let studyVersion = 1;
let accession = "";
let familyName = "";

async function imagingStudy(name: string): Promise<{ id: string; accession: string; version: number }> {
  const patient = await h.post(reception, "/api/v1/reception/patients", {
    givenName: "Synthetic", familyName: name, dateOfBirth: "1992-06-15", sex: "female", identityConfidence: "confirmed-verbal",
  });
  const encounter = await h.post(reception, "/api/v1/encounters", { patientId: patient.patient.patientId, type: "walk-in", reason: "Synthetic imaging" });
  const order = await h.post(clinician, "/api/v1/diagnostic-orders", {
    patientId: patient.patient.patientId, encounterId: encounter.encounterId, orderType: "imaging", priority: "routine",
    clinicalNote: "Synthetic head CT request.", items: [{ name: "CT head" }],
  });
  const detail = await h.expectOk(await h.call(radiographer, `/api/v1/diagnostic-orders/${order.order.id}`));
  const created = await h.post(radiographer, "/api/v1/radiology/studies", { orderItemId: detail.items[0].id, modality: "CT", bodySite: "Head" });
  return { id: created.study.id, accession: created.study.accession, version: 1 };
}

beforeAll(async () => {
  [reception, clinician, nurse, radiographer, laboratory, operator] = await Promise.all([
    h.login("reception@medveris.local"),
    h.login("clinician@medveris.local"),
    h.login("nurse@medveris.local"),
    h.login("radiographer@medveris.local"),
    h.login("lab@medveris.local"),
    h.login("reviewer@medveris.local"),
  ]);
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("PACS availability is decided by a stored verification run", () => {
  it("keeps a configured but never verified PACS unavailable and refuses PACS operations", async () => {
    const status = await h.expectOk(await h.call(radiographer, "/api/v1/radiology/images/status"));
    expect(status.images).toMatchObject({ state: "verification_failed", available: false });
    familyName = `Pacs${Date.now()}`;
    const study = await imagingStudy(familyName);
    const search = await h.call(radiographer, `/api/v1/radiology/studies/${study.id}/pacs-candidates`);
    expect(search.status).toBe(503);
    expect((await h.json(search)).error.details).toMatchObject({ integration: "dicomweb", state: "verification_failed" });
    expect(pacs.requests).toHaveLength(0);
  });

  it("lets only a platform operator run the verification", async () => {
    const refused = await h.call(radiographer, "/api/v1/admin/integrations/dicomweb/verify", { method: "POST", body: "{}" });
    expect(refused.status).toBe(403);
  });

  it("records a failed run when the PACS cannot be reached and stays unavailable", async () => {
    pacs.offline = true;
    const run = await h.expectOk(await h.call(operator, "/api/v1/admin/integrations/dicomweb/verify", { method: "POST", body: "{}" }));
    pacs.offline = false;
    expect(run.outcome).toBe("failed");
    expect(run.checks.find((check: { passed: boolean }) => !check.passed)).toMatchObject({ name: "credentials-required" });
    expect(run.status.state).toBe("verification_failed");
    expect(run.status.reason).toContain("failed");
  });

  it("fails a PACS that answers searches without credentials", async () => {
    pacs.studies.push(syntheticStudy({ accession: "SYN-VERIFY-1", family: "Verify", given: "Sample", birthDate: "1980-01-01", sex: "M" }));
    pacs.open = true;
    const run = await h.expectOk(await h.call(operator, "/api/v1/admin/integrations/dicomweb/verify", { method: "POST", body: "{}" }));
    pacs.open = false;
    expect(run.outcome).toBe("failed");
    expect(run.checks.at(-1)).toMatchObject({ name: "credentials-required", passed: false });
  });

  it("becomes available after QIDO-RS and WADO-RS checks pass, without storing identifiers", async () => {
    const run = await h.expectOk(await h.call(operator, "/api/v1/admin/integrations/dicomweb/verify", { method: "POST", body: "{}" }));
    expect(run.outcome, JSON.stringify(run.checks)).toBe("passed");
    expect(run.checks.map((check: { name: string }) => check.name)).toEqual([
      "configuration", "credentials-required", "qido-rs-studies", "qido-rs-series", "qido-rs-instances", "wado-rs-rendered",
    ]);
    expect(run.status.state).toBe("available");
    const [stored] = await h.sql`select checks::text as checks from integration_verifications where id = ${run.id}`;
    expect(String(stored!.checks)).not.toMatch(/2\.25\.|Verify|SYN-/);
    const status = await h.expectOk(await h.call(radiographer, "/api/v1/radiology/images/status"));
    expect(status.images).toMatchObject({ state: "available", available: true });
    const config = await h.expectOk(await h.call(reception, "/api/v1/public/config"));
    expect(config.features.dicomweb).toBe(true);
  });
});

describe("linking a Medveris study to a PACS study", () => {
  it("registers new studies as pending once the PACS is available", async () => {
    const study = await imagingStudy(familyName);
    studyId = study.id;
    accession = study.accession;
    const detail = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/studies/${studyId}`));
    expect(detail.study).toMatchObject({ pacsState: "pending", accession });
    expect(detail.permissions).toEqual({ link: true, view: true });
    studyVersion = detail.study.version;
  });

  it("searches the PACS by the study's accession and compares identity", async () => {
    pacs.studies.push(syntheticStudy({ accession, family: familyName, given: "Synthetic", birthDate: "1992-06-15", sex: "F" }));
    pacs.studies.push(syntheticStudy({ accession, family: "Different", given: "Person", birthDate: "1970-02-02", sex: "M" }));
    const found = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/studies/${studyId}/pacs-candidates`));
    expect(found.criteria).toEqual({ accession });
    expect(pacs.requests.at(-1)).toContain(`AccessionNumber=${encodeURIComponent(accession)}`);
    expect(found.candidates).toHaveLength(2);
    const [match, other] = found.candidates;
    expect(match).toMatchObject({ accessionMatches: true, identity: { familyName: "match", birthDate: "match", sex: "match", confirmed: true } });
    expect(other.identity).toMatchObject({ familyName: "mismatch", birthDate: "mismatch", confirmed: false });
    const audit = await auditRows("radiology.pacs.search", studyId);
    expect(audit).toHaveLength(1);
  });

  it("refuses PACS search and linking to staff without study registration rights", async () => {
    expect((await h.call(nurse, `/api/v1/radiology/studies/${studyId}/pacs-candidates`)).status).toBe(403);
    const wildcard = await h.call(radiographer, `/api/v1/radiology/studies/${studyId}/pacs-candidates?patientId=${encodeURIComponent("*")}`);
    expect(wildcard.status).toBe(422);
  });

  it("refuses a link whose demographics do not match unless a reason is recorded", async () => {
    const other = pacs.studies.at(-1)!;
    const refused = await h.call(radiographer, `/api/v1/radiology/studies/${studyId}/pacs-link`, {
      method: "POST", body: JSON.stringify({ studyInstanceUid: other.studyInstanceUid, expectedVersion: studyVersion }),
    });
    expect(refused.status).toBe(409);
    expect((await h.json(refused)).error.details.identity).toMatchObject({ confirmed: false });
  });

  it("links the matching study after re-reading it from the PACS", async () => {
    const match = pacs.studies.at(-2)!;
    const linked = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/studies/${studyId}/pacs-link`, {
      method: "POST", body: JSON.stringify({ studyInstanceUid: match.studyInstanceUid, expectedVersion: studyVersion }),
    }));
    expect(linked.identity.confirmed).toBe(true);
    studyVersion = linked.version;
    const detail = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/studies/${studyId}`));
    expect(detail.study).toMatchObject({ pacsState: "reconciled", studyInstanceUid: match.studyInstanceUid, linkedByName: expect.any(String) });
    expect(detail.study.pacsIdentity.identity.confirmed).toBe(true);
  });

  it("does not link the same PACS study to a second Medveris study at the facility", async () => {
    const second = await imagingStudy(familyName);
    const match = pacs.studies.at(-2)!;
    const conflict = await h.call(radiographer, `/api/v1/radiology/studies/${second.id}/pacs-link`, {
      method: "POST", body: JSON.stringify({ studyInstanceUid: match.studyInstanceUid, expectedVersion: second.version }),
    });
    expect(conflict.status).toBe(409);
    expect((await h.json(conflict)).error.message).toContain("already linked");
  });
});

describe("relaying images from the PACS", () => {
  it("lists series in series-number order and audits the image access", async () => {
    const images = await h.expectOk(await h.call(clinician, `/api/v1/radiology/studies/${studyId}/images`));
    expect(images.series.map((series: { seriesNumber: number }) => series.seriesNumber)).toEqual([1, 2]);
    expect(images.study.accession).toBe(accession);
    expect(images.notice).toContain("Not a validated diagnostic viewer");
    const audit = await auditRows("radiology.images.view", studyId);
    expect(audit).toHaveLength(1);
  });

  it("refuses image access to roles without radiology.images.view", async () => {
    expect((await h.call(laboratory, `/api/v1/radiology/studies/${studyId}/images`)).status).toBe(403);
  });

  it("lists instances with frame counts and relays rendered frames without caching", async () => {
    const study = pacs.studies.at(-2)!;
    const multiFrame = study.series.find((series) => series.number === 1)!;
    const listed = await h.expectOk(await h.call(nurse, `/api/v1/radiology/studies/${studyId}/images/series/${multiFrame.seriesInstanceUid}`));
    expect(listed.instances[0]).toMatchObject({ frames: 4, rows: 256, columns: 256 });
    const instance = multiFrame.instances[0]!.sopInstanceUid;
    const frame = await h.call(nurse, `/api/v1/radiology/studies/${studyId}/images/series/${multiFrame.seriesInstanceUid}/instances/${instance}/frames/3?windowCenter=40&windowWidth=80`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    expect(frame.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await frame.arrayBuffer())[1]).toBe(0x50);
    expect(pacs.requests.at(-1)).toContain(`/studies/${study.studyInstanceUid}/series/${multiFrame.seriesInstanceUid}/instances/${instance}/frames/3/rendered?window=40%2C80%2Clinear`);
    const thumb = await h.call(nurse, `/api/v1/radiology/studies/${studyId}/images/series/${multiFrame.seriesInstanceUid}/instances/${instance}/frames/1?size=thumb`);
    expect(thumb.status).toBe(200);
    expect(pacs.requests.at(-1)).toContain("viewport=160%2C160");
    const beyond = await h.call(nurse, `/api/v1/radiology/studies/${studyId}/images/series/${multiFrame.seriesInstanceUid}/instances/${instance}/frames/9`);
    expect(beyond.status).toBe(422);
  });

  it("only requests frames under the linked study, so another study's series is not reachable", async () => {
    const foreign = pacs.studies.at(-1)!;
    const series = foreign.series[0]!;
    const response = await h.call(nurse, `/api/v1/radiology/studies/${studyId}/images/series/${series.seriesInstanceUid}/instances/${series.instances[0]!.sopInstanceUid}/frames/1`);
    expect(response.status).toBe(404);
    expect(pacs.requests.at(-1)).toContain(`/studies/${pacs.studies.at(-2)!.studyInstanceUid}/series/${series.seriesInstanceUid}/`);
  });

  it("reports an unreachable PACS as a retryable dependency failure", async () => {
    pacs.offline = true;
    const response = await h.call(clinician, `/api/v1/radiology/studies/${studyId}/images`);
    pacs.offline = false;
    expect(response.status).toBe(502);
    expect((await h.json(response)).error).toMatchObject({ code: "pacs_unavailable", details: { failure: "unreachable", retryable: true } });
  });

  it("unlinks with a reason, after which no images are served", async () => {
    const unlinked = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/studies/${studyId}/pacs-unlink`, {
      method: "POST", body: JSON.stringify({ expectedVersion: studyVersion, reason: "Synthetic test: linked to the wrong examination." }),
    }));
    expect(unlinked.version).toBe(studyVersion + 1);
    expect((await h.call(clinician, `/api/v1/radiology/studies/${studyId}/images`)).status).toBe(409);
    const detail = await h.expectOk(await h.call(radiographer, `/api/v1/radiology/studies/${studyId}`));
    expect(detail.study).toMatchObject({ pacsState: "pending", studyInstanceUid: null });
  });
});
