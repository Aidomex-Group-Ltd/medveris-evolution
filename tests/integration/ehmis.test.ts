import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previousPeriod } from "@medveris/domain";
import { createHarness, type Session } from "./support.js";

const uid = () => `A${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
const ROOT_UNIT = uid();
const ORG_UNIT = uid();
const DATASET = uid();
const BASE_URL = `https://dhis2-${crypto.randomUUID().slice(0, 8)}.example.test`;
const PASSWORD = "synthetic-dhis2-password";

/** A DHIS2 server stand-in that records every request; it never reaches a real eHMIS instance. */
class FakeDhis2 {
  requests: Array<{ method: string; path: string; authorization: string | null; body: unknown }> = [];
  conflict = false;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.requests.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, authorization: new Headers(init?.headers).get("authorization"), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/system/info") return json({ version: "2.41.1" });
    if (url.pathname === "/api/me") return json({ id: "U1", organisationUnits: [{ id: ROOT_UNIT }] });
    if (url.pathname === `/api/organisationUnits/${ORG_UNIT}`) return json({ id: ORG_UNIT, name: "Synthetic Kampala Clinic", path: `/${ROOT_UNIT}/${ORG_UNIT}` });
    if (url.pathname === "/api/dataValueSets") {
      const values = (body as { dataValues: unknown[] }).dataValues.length;
      if (this.conflict) return json({ httpStatus: "Conflict", status: "WARNING", response: { status: "WARNING", importCount: { imported: 0, updated: 0, ignored: values, deleted: 0 }, conflicts: [{ object: "x", value: "Period is locked" }] } }, 409);
      return json({ httpStatus: "OK", status: "OK", response: { status: "SUCCESS", importCount: { imported: values, updated: 0, ignored: 0, deleted: 0 }, conflicts: [] } });
    }
    return json({ message: "not found" }, 404);
  };

  posts(): number {
    return this.requests.filter((request) => request.path.startsWith("/api/dataValueSets")).length;
  }
}

const dhis2 = new FakeDhis2();
const h = createHarness("ehmis", {
  env: {
    FEATURE_EHMIS: "true",
    EHMIS_DEPLOYMENT_AUTHORIZATION_REF: "SYNTHETIC-TEST-ONLY",
    EHMIS_CREDENTIALS_KEY: "synthetic-ehmis-credential-key-0123456789abcdef",
    EHMIS_ALLOWED_HOSTS: new URL(BASE_URL).hostname,
  },
  deps: () => ({ dhis2Transport: dhis2.fetch }),
});
const off = createHarness("ehmis-off");

let admin: Session;
let operator: Session;
let nurse: Session;
let mappingId = "";
let periodId = "";
const period = previousPeriod("Monthly", new Date().toISOString().slice(0, 10));

async function get(session: Session, path: string, status = 200): Promise<any> {
  return h.expectOk(await h.call(session, path), status);
}

beforeAll(async () => {
  [admin, operator, nurse] = await Promise.all([
    h.login("admin@medveris.local"),
    h.login("reviewer@medveris.local"),
    h.login("nurse@medveris.local"),
  ]);
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
  await off.sql.end({ timeout: 5 });
});

describe("eHMIS works locally without a live connection", () => {
  it("reports the connector as not requested and refuses connection tests in a deployment without authorization", async () => {
    const session = await off.login("admin@medveris.local");
    const overview = await off.expectOk(await off.call(session, "/api/v1/ehmis"));
    expect(overview.deployment.state).toBe("not_requested");
    expect(overview.readiness.ready).toBe(false);
    expect(overview.notices.join(" ")).toMatch(/does not claim Ministry of Health certification/);
    const test = await off.call(session, "/api/v1/ehmis/connection-test", { method: "POST", body: "{}" });
    expect(test.status).toBe(503);
  });

  it("limits eHMIS reporting to facility administrators and public-health officers", async () => {
    expect((await h.call(nurse, "/api/v1/ehmis")).status).toBe(403);
  });

  it("prepares, validates, approves and exports an aggregate period for manual entry", async () => {
    await h.expectOk(await h.call(admin, "/api/v1/ehmis/settings", { method: "PUT", body: JSON.stringify({ nhfrId: "NHFR-SYNTH-KLA", dhis2OrgUnitUid: ORG_UNIT, dhis2BaseUrl: null }) }));
    const mapping = await h.post(admin, "/api/v1/ehmis/mappings", {
      datasetCode: `HMIS105-${DATASET}`, datasetName: "HMIS 105 OPD monthly (synthetic mapping)", dhis2DataSetUid: DATASET, periodType: "Monthly",
      elements: [
        { metric: "opd.new-attendance", sex: "female", ageBand: "20y+", dataElementUid: uid(), categoryOptionComboUid: uid(), label: "New attendance, female 20+" },
        { metric: "ipd.admissions", dataElementUid: uid(), categoryOptionComboUid: uid() },
      ],
    });
    mappingId = mapping.id;
    const unapproved = await h.post(admin, "/api/v1/ehmis/periods", { mappingId, period });
    expect(unapproved.period.status).toBe("validation-failed");
    expect(unapproved.period.issues.map((issue: any) => issue.message).join(" ")).toMatch(/not been approved/);
    const duplicate = await h.call(admin, "/api/v1/ehmis/periods", { method: "POST", body: JSON.stringify({ mappingId, period }) });
    expect(duplicate.status).toBe(409);

    await h.post(admin, `/api/v1/ehmis/mappings/${mappingId}/approve`, { approvalReference: "District biostatistician email (synthetic)", expectedVersion: 1 }, 200);
    const reopened = await h.post(admin, `/api/v1/ehmis/periods/${unapproved.period.id}/reopen`, { expectedVersion: 1, reason: "Mapping approved after first draft" });
    expect(reopened.period).toMatchObject({ revision: 2, status: "generated" });
    periodId = reopened.period.id;
    const future = await h.call(admin, "/api/v1/ehmis/periods", { method: "POST", body: JSON.stringify({ mappingId, period: previousPeriod("Monthly", "2099-01-15") }) });
    expect((await h.json(future)).period.status).toBe("validation-failed");

    const blocked = await h.call(admin, `/api/v1/ehmis/periods/${periodId}/export?format=csv`);
    expect(blocked.status).toBe(409);
    await h.post(admin, `/api/v1/ehmis/periods/${periodId}/approve`, { expectedVersion: 1 }, 200);
    const csv = await h.call(admin, `/api/v1/ehmis/periods/${periodId}/export?format=csv`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("dataelement,period,orgunit,categoryoptioncombo,attributeoptioncombo,value");
    expect(text).toContain(`,${period},${ORG_UNIT},`);
    expect(dhis2.requests).toHaveLength(0);
  });

  it("refuses live submission until the facility is verified, connected and switched on, and records the refusal", async () => {
    const refused = await h.call(admin, `/api/v1/ehmis/periods/${periodId}/submit`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    const overview = await get(admin, "/api/v1/ehmis");
    expect(overview.ledger[0]).toMatchObject({ kind: "live", outcome: "refused" });
    expect(dhis2.posts()).toBe(0);
  });
});

describe("live submission for a verified facility", () => {
  it("needs a platform operator other than the requester to verify eligibility", async () => {
    await h.expectOk(await h.call(admin, "/api/v1/ehmis/settings", { method: "PUT", body: JSON.stringify({ nhfrId: "NHFR-SYNTH-KLA", dhis2OrgUnitUid: ORG_UNIT, dhis2BaseUrl: BASE_URL }) }));
    await h.post(admin, "/api/v1/ehmis/credentials", { kind: "basic", username: "synthetic.clinic", password: PASSWORD }, 200);
    await h.post(admin, "/api/v1/ehmis/eligibility-request", { authorizationReference: "MOH/EMRS/SYNTHETIC/001", authorizationIssuer: "Synthetic Ministry of Health test" }, 200);
    expect((await h.call(admin, `/api/v1/ehmis/eligibility/${"11111111-1111-4111-8111-111111111111"}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "verified", note: "Self-verification must be refused" }),
    })).status).toBe(403);
    const requests = await get(operator, "/api/v1/ehmis/eligibility-requests");
    expect(requests.requests.some((request: any) => request.eligibilityStatus === "pending-verification")).toBe(true);
    await h.post(operator, "/api/v1/ehmis/eligibility/11111111-1111-4111-8111-111111111111/decision", { decision: "verified", note: "Synthetic authorization letter checked" }, 200);
  });

  it("tests the connection with server-side credentials that never reach the browser", async () => {
    const early = await h.call(admin, "/api/v1/ehmis/live-submission", { method: "POST", body: JSON.stringify({ enabled: true }) });
    expect(early.status).toBe(409);
    const tested = await h.post(admin, "/api/v1/ehmis/connection-test", {}, 200);
    expect(tested).toMatchObject({ ok: true, connectionStatus: "verified" });
    expect(dhis2.requests.every((request) => request.authorization === `Basic ${btoa(`synthetic.clinic:${PASSWORD}`)}`)).toBe(true);
    await h.post(admin, "/api/v1/ehmis/live-submission", { enabled: true }, 200);
    const overview = await h.call(admin, "/api/v1/ehmis");
    const text = await overview.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("credentialCiphertext");
    expect(JSON.parse(text).readiness).toMatchObject({ ready: true, problems: [] });
  });

  it("dry-runs then imports once, and never sends the same period revision twice", async () => {
    const submitted = await h.post(admin, `/api/v1/ehmis/periods/${periodId}/submit`, {}, 200);
    expect(submitted).toMatchObject({ ok: true, status: "submitted", replayed: false });
    const posts = dhis2.requests.filter((request) => request.path.startsWith("/api/dataValueSets"));
    expect(posts.map((request) => new URL(`https://x${request.path}`).searchParams.get("dryRun"))).toEqual(["true", "false"]);
    expect(posts[1]!.body).toMatchObject({ dataSet: DATASET, period, orgUnit: ORG_UNIT });

    const replay = await h.post(admin, `/api/v1/ehmis/periods/${periodId}/submit`, {}, 200);
    expect(replay).toMatchObject({ replayed: true, status: "submitted" });
    expect(dhis2.posts()).toBe(2);
    const overview = await get(admin, "/api/v1/ehmis");
    expect(overview.ledger.slice(0, 3).map((entry: any) => `${entry.kind}:${entry.outcome}`)).toEqual(["live:skipped-duplicate", "live:succeeded", "dry-run:succeeded"]);
  });

  it("keeps a period importable after DHIS2 reports conflicts, without importing it", async () => {
    const next = await h.post(admin, `/api/v1/ehmis/periods/${periodId}/reopen`, { expectedVersion: 4, reason: "Late encounter entered after submission" });
    await h.post(admin, `/api/v1/ehmis/periods/${next.period.id}/approve`, { expectedVersion: 1 }, 200);
    dhis2.conflict = true;
    const rejected = await h.post(admin, `/api/v1/ehmis/periods/${next.period.id}/submit`, {}, 200);
    expect(rejected).toMatchObject({ ok: false, status: "failed" });
    expect(rejected.error).toMatch(/dry run/);
    expect(dhis2.requests.filter((request) => request.path.includes("dryRun=false"))).toHaveLength(1);
    dhis2.conflict = false;
    const retried = await h.post(admin, `/api/v1/ehmis/periods/${next.period.id}/submit`, {}, 200);
    expect(retried.status).toBe("submitted");
    await h.post(admin, "/api/v1/ehmis/live-submission", { enabled: false }, 200);
  });
});
