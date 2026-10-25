import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for content tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true", FEATURE_DEVICES: "true", FEATURE_AI: "false", FEATURE_TELEMEDICINE: "false",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-content-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-content-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

interface Session { cookie: string; csrf: string; userId: string; patientId?: string }

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
  if (!body.mfaRequired) {
    const cookie = sessionCookie(challenge);
    const me = await json(await app.fetch(new Request("http://localhost/api/v1/me", { headers: { cookie } })));
    return { cookie, csrf: body.csrfToken, userId: me.user.id, patientId: me.patientId };
  }
  const dev = await app.fetch(new Request(`http://localhost/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  expect(dev.status).toBe(200);
  const { code } = await json(dev);
  const mfa = await app.fetch(new Request("http://localhost/api/v1/auth/login/mfa", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: body.challengeId, code }),
  }));
  expect(mfa.status).toBe(200);
  const verified = await json(mfa);
  const cookie = sessionCookie(mfa);
  const me = await json(await app.fetch(new Request("http://localhost/api/v1/me", { headers: { cookie } })));
  return { cookie, csrf: verified.csrfToken, userId: me.user.id, patientId: me.patientId };
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

const stamp = Date.now();

let admin: Session;
let quality: Session;
let nurse: Session;
let hr: Session;
let clinician: Session;
let patient: Session;
let reception: Session;

let publishedId = "";
let draftId = "";
let patientId = "";
let grantId = "";
let assignmentId = "";

beforeAll(async () => {
  [admin, quality, nurse, hr, clinician, patient, reception] = await Promise.all([
    login("admin@medveris.local"),
    login("quality@medveris.local"),
    login("nurse@medveris.local"),
    login("hr@medveris.local"),
    login("clinician@medveris.local"),
    login("patient@medveris.local"),
    login("reception@medveris.local"),
  ]);
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("permission-aware workspaces, content and access governance", () => {
  it("reports permission-aware access summary and clinician dashboard", async () => {
    const summary = await expectOk(await call(nurse, "/api/v1/access/summary"));
    expect(summary.roles).toContain("nurse");
    expect(summary.permissions).toEqual(expect.arrayContaining(["inventory.stock.read", "clinical.record.read_authorized"]));
    expect(summary.patientContext).toBe(false);

    const dashboard = await expectOk(await call(clinician, "/api/v1/dashboards/clinician"));
    expect(dashboard).toHaveProperty("content");
    expect(dashboard).toHaveProperty("appointments");
  });

  it("drafts, independently reviews and publishes scoped content", async () => {
    const created = await expectOk(await call(admin, "/api/v1/content/editorial/items", {
      method: "POST",
      body: JSON.stringify({
        contentType: "health-education", slug: `hand-hygiene-${stamp}`,
        title: "Hand hygiene for safer care", summary: "Practical hand-hygiene guidance for staff and patients.",
        body: "Synthetic educational content for integration testing.",
        audience: "general", visibilityScope: "public", specialtyTags: ["infection-prevention"],
        sourceOrganization: "Medveris Quality Office", editorialPriority: 70,
      }),
    }), 201);
    publishedId = created.item.id;

    const review = await call(quality, `/api/v1/content/editorial/items/${publishedId}/review`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, note: "Reviewed against synthetic infection-prevention guidance" }),
    });
    expect(review.status).toBe(200);

    await expectOk(await call(quality, `/api/v1/content/editorial/items/${publishedId}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, note: "Approved for publication by quality reviewer", reviewDueOn: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10) }),
    }));

    const staffFeed = await expectOk(await call(nurse, "/api/v1/content?type=health-education"));
    expect(staffFeed.items.some((item: any) => item.id === publishedId)).toBe(true);

    const patientFeed = await expectOk(await call(patient, "/api/v1/content"));
    expect(patientFeed.items.some((item: any) => item.id === publishedId)).toBe(true);

    const detail = await expectOk(await call(patient, `/api/v1/content/${publishedId}`));
    expect(detail.item.title).toBe("Hand hygiene for safer care");
    await expectOk(await call(patient, `/api/v1/content/${publishedId}/bookmark`, { method: "POST" }));
    const bookmarks = await expectOk(await call(patient, "/api/v1/content/bookmarks/mine"));
    expect(bookmarks.items.some((item: any) => item.id === publishedId)).toBe(true);

    await expectOk(await call(patient, `/api/v1/content/${publishedId}/report`, {
      method: "POST", body: JSON.stringify({ reason: "outdated", detail: "Please review the publication date" }),
    }), 201);

    await expectOk(await call(patient, "/api/v1/content/preferences/mine", {
      method: "PUT",
      body: JSON.stringify({ language: "en", geography: "Uganda", specialtyTags: ["infection-prevention"], interests: ["patient-safety"] }),
    }));
    const preferences = await expectOk(await call(patient, "/api/v1/content/preferences/mine"));
    expect(preferences.preferences.specialtyTags).toContain("infection-prevention");
  });

  it("keeps unpublished drafts out of external reads", async () => {
    const draft = await expectOk(await call(admin, "/api/v1/content/editorial/items", {
      method: "POST",
      body: JSON.stringify({
        contentType: "facility-announcement", slug: `draft-${stamp}`,
        title: "Unpublished draft", summary: "This draft must never appear in a patient feed.",
        audience: "patient", visibilityScope: "patient",
      }),
    }), 201);
    draftId = draft.item.id;

    const denied = await call(patient, `/api/v1/content/${draftId}`);
    expect(denied.status).toBe(404);
    const feed = await expectOk(await call(patient, "/api/v1/content"));
    expect(feed.items.some((item: any) => item.id === draftId)).toBe(false);
  });

  it("requires independent approval for role grants and exposes access review", async () => {
    const selfRequest = await expectOk(await call(admin, "/api/v1/admin/role-grants", {
      method: "POST",
      body: JSON.stringify({ userId: nurse.userId, role: "clinician", scopeNote: "Temporary integration-test grant" }),
    }), 201);
    const selfDecision = await call(admin, `/api/v1/admin/role-grants/${selfRequest.grant.id}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "approved", reason: "Self approval must not be permitted" }),
    });
    expect(selfDecision.status).toBe(403);

    const request = await expectOk(await call(hr, "/api/v1/admin/role-grants", {
      method: "POST",
      body: JSON.stringify({ userId: nurse.userId, role: "clinician", scopeNote: "Temporary integration-test grant" }),
    }), 201);
    grantId = request.grant.id;
    await expectOk(await call(admin, `/api/v1/admin/role-grants/${grantId}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "approved", reason: "Role scope reviewed by facility administration" }),
    }));

    const grants = await expectOk(await call(admin, "/api/v1/admin/role-grants"));
    const approved = grants.grants.find((grant: any) => grant.id === grantId);
    expect(approved.status).toBe("approved");
    expect(approved.requestedBy).not.toBe(approved.approvedBy);

    const review = await expectOk(await call(admin, "/api/v1/admin/access-review"));
    expect(review.grants.some((grant: any) => grant.id === grantId)).toBe(true);
    expect(Array.isArray(review.credentials)).toBe(true);
  });

  it("assigns and revokes care-team access for a linked patient", async () => {
    const created = await expectOk(await call(reception, "/api/v1/reception/patients", {
      method: "POST",
      body: JSON.stringify({
        givenName: "Content", familyName: `Patient${stamp}`, dateOfBirth: "1991-05-05", sex: "male",
        identityConfidence: "confirmed-verbal",
      }),
    }), 201);
    patientId = created.patient.patientId;

    const assignment = await expectOk(await call(admin, "/api/v1/admin/care-team", {
      method: "POST",
      body: JSON.stringify({ patientId, userId: nurse.userId, relationship: "nursing", purpose: "Inpatient nursing coverage" }),
    }), 201);
    assignmentId = assignment.assignment.id;

    const list = await expectOk(await call(admin, `/api/v1/admin/care-team?patientId=${patientId}`));
    expect(list.assignments.some((row: any) => row.id === assignmentId)).toBe(true);

    await expectOk(await call(admin, `/api/v1/admin/care-team/${assignmentId}/revoke`, { method: "POST" }));
    const after = await expectOk(await call(admin, `/api/v1/admin/care-team?patientId=${patientId}`));
    expect(after.assignments.find((row: any) => row.id === assignmentId).status).toBe("revoked");
  });
});
