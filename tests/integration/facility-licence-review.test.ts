import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { withContext } from "@medveris/db";
import { createHarness, type Session } from "./support.js";

/**
 * The platform reviewer side of optional licence documentation: a reviewer sees recorded
 * licences, records a verification or rejection with notes, cannot verify an expired licence,
 * cannot verify a facility they belong to, and never changes whether the facility can use
 * MedVeris.
 */
const h = createHarness("facility-licence-review");
const PASSWORD = "Synthetic-Licence-Review-2026!";
const run = crypto.randomUUID().slice(0, 8);
const email = `licence.review.${run}@example.test`;
const future = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

let owner: Session;
let reviewer: Session;
let tenantId = "";
let ownerId = "";
let currentLicenceId = "";
let expiredLicenceId = "";

async function anonymous(path: string, body: unknown): Promise<Response> {
  return h.app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 20}` },
    body: JSON.stringify(body),
  }));
}

function cookieFrom(response: Response): string {
  const match = (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="));
  if (!match) throw new Error("no session cookie");
  return match.split(";")[0]!;
}

beforeAll(async () => {
  const registrationResponse = await anonymous("/api/v1/auth/register/workspace", {
    path: "independent",
    owner: { email, password: PASSWORD, givenName: "Synthetic", familyName: "Licence Owner" },
    workspace: {
      name: `Synthetic Licence Review ${run}`,
      workspaceKind: "service-unit",
      serviceCategory: "drug-shop",
      ownership: "private-for-profit",
      levelStatus: "not-applicable",
      district: "Wakiso",
      registrations: [
        { kind: "nda-drug-shop", identifier: `NDA-DS-${run}`, validUntil: future },
        { kind: "nda-drug-shop", identifier: `NDA-DS-OLD-${run}`, validUntil: past },
      ],
    },
    legal: await h.legalAcceptance(),
  });
  const registered = await h.json(registrationResponse);
  expect(registrationResponse.status, JSON.stringify(registered)).toBe(201);
  tenantId = registered.workspace.id;

  const login = await anonymous("/api/v1/auth/login", { email, password: PASSWORD });
  const body = await h.json(login);
  expect(login.status, JSON.stringify(body)).toBe(200);
  owner = { cookie: cookieFrom(login), csrf: body.csrfToken };
  const started = await h.post(owner, "/api/v1/auth/mfa/enroll/start", {}, 200);
  await h.post(owner, "/api/v1/auth/mfa/enroll/verify", { code: await totpCode(started.secret) }, 200);
  ownerId = (await h.expectOk(await h.call(owner, "/api/v1/me"))).user.id;
  const workspace = await h.expectOk(await h.call(owner, "/api/v1/workspace"));
  currentLicenceId = workspace.registrations.find((row: any) => row.identifier === `NDA-DS-${run}`).id;
  expiredLicenceId = workspace.registrations.find((row: any) => row.identifier === `NDA-DS-OLD-${run}`).id;

  reviewer = await h.login("reviewer@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

async function queue(): Promise<{ queue: any[]; rule: string }> {
  return h.expectOk(await h.call(reviewer, "/api/v1/facility-licences/queue"));
}

describe("platform review of optional facility licences", () => {
  it("is reviewer-only", async () => {
    const denied = await h.call(owner, "/api/v1/facility-licences/queue");
    expect(denied.status).toBe(403);
    const decisionDenied = await h.call(owner, `/api/v1/facility-licences/${currentLicenceId}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "verified", notes: "Self verification attempt" }),
    });
    expect(decisionDenied.status).toBe(403);
  });

  it("lists recorded licences with the facility that submitted them", async () => {
    const view = await queue();
    const row = view.queue.find((item) => item.id === currentLicenceId);
    expect(row).toMatchObject({
      facilityName: `Synthetic Licence Review ${run}`,
      serviceCategory: "drug-shop",
      kind: "nda-drug-shop",
      identifier: `NDA-DS-${run}`,
      status: "recorded",
      validUntil: future,
    });
    expect(view.rule).toMatch(/never grants or removes platform access/i);
  });

  it("requires reviewer notes with every decision", async () => {
    const response = await h.call(reviewer, `/api/v1/facility-licences/${currentLicenceId}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "verified", notes: "" }),
    });
    expect(response.status).toBe(422);
  });

  it("refuses to verify an expired licence", async () => {
    const response = await h.call(reviewer, `/api/v1/facility-licences/${expiredLicenceId}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "verified", notes: "Checked the submitted document" }),
    });
    expect(response.status).toBe(422);
    expect((await h.json(response)).error.message).toMatch(/expired licence/i);
  });

  it("records a rejection with notes and leaves the licence in the review queue", async () => {
    const decided = await h.post(reviewer, `/api/v1/facility-licences/${expiredLicenceId}/decision`, {
      decision: "rejected", notes: "Expiry date has passed; the facility must record current details",
    }, 200);
    expect(decided.status).toBe("rejected");
    const view = await queue();
    const row = view.queue.find((item) => item.id === expiredLicenceId);
    expect(row.status).toBe("rejected");
    expect(row.verificationNotes).toMatch(/expiry date has passed/i);
  });

  it("verifies a current licence and records the audited decision", async () => {
    const decided = await h.post(reviewer, `/api/v1/facility-licences/${currentLicenceId}/decision`, {
      decision: "verified", notes: "Number, issuer and expiry compared with the submitted document",
    }, 200);
    expect(decided.status).toBe("verified");

    const view = await queue();
    expect(view.queue.some((item) => item.id === currentLicenceId)).toBe(false);

    const facilityView = await h.expectOk(await h.call(owner, "/api/v1/facility/experience"));
    expect(facilityView.licence.status).toBe("verified");
    // Verification is documentation progress, not an access switch.
    expect(facilityView.access.status).toBe("ready");

    const audit = await withContext(h.sql, { tenantId, userId: ownerId, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => tx`
      select action, metadata from audit_events where tenant_id = ${tenantId} and action = 'facility.licence.review' order by occurred_at
    `);
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.at(-1)?.metadata).toMatchObject({ decision: "verified" });
  });

  it("does not let the same licence be decided twice", async () => {
    const response = await h.call(reviewer, `/api/v1/facility-licences/${currentLicenceId}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "rejected", notes: "Second thoughts on the same record" }),
    });
    expect(response.status).toBe(409);
  });

  it("ignores licence decisions when deciding platform access", async () => {
    // The facility's own workspace view stays open for the rejected and expired record too.
    const workspace = await h.expectOk(await h.call(owner, "/api/v1/workspace"));
    expect(workspace.registrations).toHaveLength(2);
    const overview = await h.expectOk(await h.call(owner, "/api/v1/drugshop/overview"));
    expect(overview.facility.id).toBe(tenantId);
  });
});
