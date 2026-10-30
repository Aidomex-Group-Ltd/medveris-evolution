import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, withContext } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { chooseFacility } from "./support.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for onboarding tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env,
  APP_ENV: "test",
  APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-onboarding-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-onboarding-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);
const stamp = Date.now();

interface Session { cookie: string; csrf: string; userId: string }

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
    return { cookie, csrf: body.csrfToken, userId: me.user.id };
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
  await chooseFacility(app, { cookie, csrf: verified.csrfToken });
  const me = await json(await app.fetch(new Request("http://localhost/api/v1/me", { headers: { cookie } })));
  return { cookie, csrf: verified.csrfToken, userId: me.user.id };
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

let patient: Session;
let clinician: Session;
let admin: Session;
let hr: Session;
let reviewer: Session;
let records: Session;
let departmentId = "";
let proxyUserId = "";

beforeAll(async () => {
  patient = await login("patient@medveris.local");
  clinician = await login("clinician@medveris.local");
  admin = await login("admin@medveris.local");
  hr = await login("hr@medveris.local");
  reviewer = await login("reviewer@medveris.local");
  records = await login("records@medveris.local");
  const departments = await expectOk(await call(admin, "/api/v1/organization/departments"));
  departmentId = departments.departments.find((row: any) => row.code === "MAT").id;
  proxyUserId = crypto.randomUUID();
  await sql`
    insert into users (id, email, password_hash, display_name, given_name, family_name)
    values (${proxyUserId}, ${`proxy-${stamp}@example.test`}, 'synthetic-test-only', 'Synthetic Proxy',
      'Synthetic', 'Proxy')
  `;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("versioned Uganda onboarding catalogue", () => {
  it("serves the published Uganda catalogue with search and role metadata", async () => {
    const result = await expectOk(await call(clinician, "/api/v1/onboarding/catalogue?q=midwife"));
    expect(result.source).toBe("published");
    expect(result.countryCode).toBe("UG");
    expect(result.version).toBeGreaterThanOrEqual(1);
    expect(result.titles.some((title: any) => title.code === "MIDWIFE-STD")).toBe(true);
    expect(result.catalogue.notice.toLowerCase()).toContain("not an exhaustive");
  });

  it("keeps catalogue publication to platform operators and versions every release", async () => {
    expect((await call(admin, "/api/v1/onboarding/catalogue/publish", {
      method: "POST", body: JSON.stringify({ countryCode: "UG", version: 9999 }),
    })).status).toBe(403);
    const before = await expectOk(await call(reviewer, "/api/v1/onboarding/catalogue/versions"));
    const nextVersion = Math.max(...before.versions.map((row: any) => Number(row.version))) + 1;
    const published = await expectOk(await call(reviewer, "/api/v1/onboarding/catalogue/publish", {
      method: "POST", body: JSON.stringify({ countryCode: "UG", version: nextVersion }),
    }), 201);
    expect(published.catalogue.version).toBe(nextVersion);
    expect(published.catalogue.digest.startsWith("sha256:")).toBe(true);
    const after = await expectOk(await call(clinician, "/api/v1/onboarding/catalogue"));
    expect(after.version).toBe(nextVersion);
    expect((await call(patient, "/api/v1/onboarding/catalogue/versions")).status).toBe(403);
  });
});

describe("role-based onboarding paths", () => {
  it("returns a patient checklist without exposing staff onboarding data", async () => {
    const result = await expectOk(await call(patient, "/api/v1/onboarding/me"));
    expect(result.path).toBe("patient");
    expect(result.steps.some((step: any) => step.key === "caregiver")).toBe(true);
    expect(result.staff).toBeUndefined();
  });

  it("derives the clinician and facility-administrator paths from membership", async () => {
    const clinicianView = await expectOk(await call(clinician, "/api/v1/onboarding/me"));
    expect(clinicianView.path).toBe("clinician");
    expect(clinicianView.steps.some((step: any) => step.key === "credentials")).toBe(true);
    expect(Array.isArray(clinicianView.staff.regulatorCodes)).toBe(true);
    expect(Array.isArray(clinicianView.staff.requestedSystemRoles)).toBe(true);
    expect(Array.isArray(clinicianView.staff.approvedSystemRoles)).toBe(true);
    const adminView = await expectOk(await call(admin, "/api/v1/onboarding/me"));
    expect(adminView.path).toBe("facility_admin");
    expect(adminView.steps.some((step: any) => step.key === "departments")).toBe(true);
  });

  it("starts onboarding from a catalogue title and rejects a mismatched cadre", async () => {
    expect((await call(clinician, "/api/v1/workforce/onboarding", {
      method: "POST",
      body: JSON.stringify({
        givenName: "Catalogue", familyName: `Hire${stamp}`, startDate: "2026-01-05",
        catalogueTitleCode: "MIDWIFE-STD", primaryDepartmentId: departmentId,
      }),
    })).status).toBe(403);

    const started = await expectOk(await call(hr, "/api/v1/workforce/onboarding", {
      method: "POST",
      body: JSON.stringify({
        givenName: "Catalogue", familyName: `Hire${stamp}`, email: `catalogue-${stamp}@example.test`,
        startDate: "2026-01-05", catalogueTitleCode: "MIDWIFE-STD",
        catalogueCadreCode: "MIDWIFE", primaryDepartmentId: departmentId,
      }),
    }), 201);
    expect(started.onboarding.path).toBe("nurse");
    expect(started.onboarding.requestedSystemRoles).toContain("midwife");
    const detail = await expectOk(await call(hr, `/api/v1/workforce/onboarding/${started.onboarding.caseId}`));
    expect(detail.onboarding.catalogueTitleCode).toBe("MIDWIFE-STD");
    expect(detail.onboarding.regulatorCodes).toContain("UNMC");
    expect(detail.onboarding.credentialRequired).toBe(true);

    const mismatch = await call(hr, "/api/v1/workforce/onboarding", {
      method: "POST",
      body: JSON.stringify({
        givenName: "Mismatch", familyName: `Hire${stamp}`, startDate: "2026-01-05",
        catalogueTitleCode: "MIDWIFE-STD", catalogueCadreCode: "MED-OFF",
        primaryDepartmentId: departmentId,
      }),
    });
    expect(mismatch.status).toBe(422);
  });
});

describe("patient and caregiver proxy onboarding", () => {
  it("requests, reviews and activates a caregiver link with explicit scopes", async () => {
    const request = await expectOk(await call(patient, "/api/v1/onboarding/proxies/requests", {
      method: "POST",
      body: JSON.stringify({
        proxyUserId,
        relationship: "Adult child",
        scopes: ["profile", "appointments"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    }), 201);
    const list = await expectOk(await call(patient, "/api/v1/onboarding/proxies"));
    expect(list.proxies.some((row: any) => row.id === request.proxy.id && row.status === "requested")).toBe(true);

    const queue = await expectOk(await call(records, "/api/v1/onboarding/proxies/queue"));
    expect(queue.requests.some((row: any) => row.id === request.proxy.id)).toBe(true);

    const decision = await call(records, `/api/v1/onboarding/proxies/${request.proxy.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Caregiver identity confirmed against synthetic records" }),
    });
    const decisionBody = await json(decision);
    expect(decision.status, JSON.stringify(decisionBody)).toBe(200);
    expect(decisionBody.status).toBe("active");
    const settled = await expectOk(await call(patient, "/api/v1/onboarding/proxies"));
    const active = settled.proxies.find((row: any) => row.id === request.proxy.id);
    expect(active.status).toBe("active");
    expect(active.scopes).toEqual(["profile", "appointments"]);
  });

  it("does not let a non-patient create a proxy request and rejects duplicate links", async () => {
    expect((await call(clinician, "/api/v1/onboarding/proxies/requests", {
      method: "POST",
      body: JSON.stringify({ proxyUserId, relationship: "Friend", scopes: ["records"] }),
    })).status).toBe(403);
    expect((await call(patient, "/api/v1/onboarding/proxies/requests", {
      method: "POST",
      body: JSON.stringify({ proxyUserId, relationship: "Adult child", scopes: ["profile"] }),
    })).status).toBe(409);
  });
});

describe("custom titles and credential review hardening", () => {
  it("keeps a custom title pending, blocks self-approval and grants no role or privilege on approval", async () => {
    const name = `Dialysis Technician ${stamp}`;
    const request = await expectOk(await call(hr, "/api/v1/onboarding/custom-titles", {
      method: "POST",
      body: JSON.stringify({
        proposedName: name,
        cadreCode: "NURSE",
        departmentCodes: ["OUTPATIENT"],
        specialtyCodes: ["RENAL"],
        explanation: "Synthetic test role that is not listed in the Uganda catalogue.",
      }),
    }), 201);
    expect(request.grantsNothing).toBe(true);
    expect(request.request.status).toBe("pending");

    const queue = await expectOk(await call(hr, "/api/v1/onboarding/custom-titles/queue"));
    expect(queue.requests.some((row: any) => row.id === request.request.id)).toBe(true);

    expect((await call(hr, `/api/v1/onboarding/custom-titles/${request.request.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", reason: "Self approval must be rejected by the server" }),
    })).status).toBe(403);

    const decision = await expectOk(await call(admin, `/api/v1/onboarding/custom-titles/${request.request.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: "approve",
        reason: "Reviewed the role description and confirmed it is a local label only",
        approvedName: name,
      }),
    }));
    expect(decision.status).toBe("approved");
    const [title] = await withContext(sql, {
      tenantId: "11111111-1111-4111-8111-111111111111", userId: admin.userId, actorKind: "staff", roles: ["facility_admin"],
    }, async (tx) => tx`
      select privilege_codes, suggested_system_roles, catalogue_code, requires_credential
        from job_titles where id = ${decision.approvedJobTitleId}
    `);
    expect(title).toBeTruthy();
    expect(title!.privilegeCodes).toEqual([]);
    expect(title!.suggestedSystemRoles).toEqual([]);
    expect(title!.catalogueCode).toBeNull();
    expect(title!.requiresCredential).toBe(false);
  });

  it("enforces facility credential policy permissions on the server", async () => {
    expect((await call(clinician, "/api/v1/onboarding/credential-policies")).status).toBe(403);
    const saved = await expectOk(await call(hr, "/api/v1/onboarding/credential-policies", {
      method: "POST",
      body: JSON.stringify({
        cadreCode: "MIDWIFE",
        credentialType: "Professional licence",
        regulatorCode: "UNMC",
        requiresDocument: true,
        requiresLicence: true,
        reviewRequired: true,
        active: true,
        notes: `Synthetic policy ${stamp}`,
      }),
    }), 201);
    expect(saved.policy.id).toBeTruthy();
    const policies = await expectOk(await call(hr, "/api/v1/onboarding/credential-policies"));
    const row = policies.policies.find((item: any) => item.cadreCode === "MIDWIFE" && item.credentialType === "Professional licence");
    expect(row.requiresDocument).toBe(true);
    const requirements = await expectOk(await call(clinician, "/api/v1/onboarding/credential-requirements?titleCode=MIDWIFE-STD"));
    expect(requirements.requiredFields).toContain("registrationNumber");
    expect(requirements.verification.claim).toContain("does not prove");
  });
});

describe("facility credential review and tenant isolation", () => {
  it("requires an independent facility reviewer and records append-only history", async () => {
    const started = await expectOk(await call(hr, "/api/v1/workforce/onboarding", {
      method: "POST",
      body: JSON.stringify({
        givenName: "Credential", familyName: `Review${stamp}`,
        email: `credential-review-${stamp}@example.test`,
        startDate: "2026-02-02", catalogueTitleCode: "MIDWIFE-STD",
        catalogueCadreCode: "MIDWIFE", primaryDepartmentId: departmentId,
      }),
    }), 201);
    const caseId = started.onboarding.caseId;

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").toString("base64");
    const upload = await expectOk(await call(admin, "/api/v1/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: "licence.pdf", declaredType: "application/pdf", dataBase64: pdf }),
    }), 201);
    const content = await call(admin, `/api/v1/uploads/${upload.upload.id}/content`);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer()).toString("base64")).toBe(pdf);
    expect((await call(reviewer, `/api/v1/uploads/${upload.upload.id}/content`)).status).toBe(200);
    expect((await call(patient, `/api/v1/uploads/${upload.upload.id}/content`)).status).toBe(404);

    const submitted = await expectOk(await call(admin, "/api/v1/credentials", {
      method: "POST",
      body: JSON.stringify({
        subjectType: "practitioner",
        onboardingCaseId: caseId,
        credentialType: "Professional licence",
        issuer: "Uganda Nurses and Midwives Council",
        jurisdiction: "Uganda",
        regulatorCode: "UNMC",
        registrationNumber: `REG-${stamp}`,
        licenceNumber: `LIC-${stamp}`,
        credentialNumber: `CRED-${stamp}`,
        qualifications: "Synthetic Diploma in Midwifery",
        specialtyCredentials: ["RENAL"],
        issuedOn: "2025-01-01",
        expiresOn: "2027-01-01",
        evidenceUploadId: upload.upload.id,
      }),
    }), 201);
    expect(submitted.verificationClaim).toBe(false);

    expect((await call(admin, `/api/v1/credentials/${submitted.credentialId}/facility-decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: "verified",
        reason: "Attempted self review must be rejected by the server",
        checksPerformed: "Checked against synthetic regulator register",
      }),
    })).status).toBe(403);

    const decided = await expectOk(await call(hr, `/api/v1/credentials/${submitted.credentialId}/facility-decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: "verified",
        reason: "Independent facility review completed against the named regulator source",
        checksPerformed: "Checked registration and licence numbers against the synthetic UNMC register on 2026-02-02",
        expiresOn: "2027-01-01",
      }),
    }));
    expect(decided.status).toBe("verified");
    expect(decided.publicClaim).toContain("manual");

    const history = await expectOk(await call(admin, `/api/v1/credentials/${submitted.credentialId}/history`));
    expect(history.appendOnly).toBe(true);
    expect(history.events.length).toBeGreaterThanOrEqual(1);
    expect(history.events[0].newStatus).toBe("verified");
    expect(history.events[0].verificationMethod).toBe("manual");

    const queue = await expectOk(await call(hr, "/api/v1/credentials/facility/queue"));
    expect(queue.queue.some((row: any) => row.id === submitted.credentialId)).toBe(false);
  });

  it("lets an independent platform reviewer see and decide a submitted credential", async () => {
    const submitted = await expectOk(await call(admin, "/api/v1/credentials", {
      method: "POST",
      body: JSON.stringify({
        subjectType: "practitioner",
        credentialType: "Professional licence",
        issuer: "Uganda Medical and Dental Practitioners Council",
        jurisdiction: "Uganda",
        regulatorCode: "UMDPC",
        registrationNumber: `PLAT-REG-${stamp}`,
        licenceNumber: `PLAT-LIC-${stamp}`,
        credentialNumber: `PLAT-CRED-${stamp}`,
        qualifications: "Synthetic MBChB",
        issuedOn: "2025-01-01",
        expiresOn: "2027-01-01",
      }),
    }), 201);
    const before = await expectOk(await call(reviewer, "/api/v1/credentials/queue"));
    expect(before.queue.some((row: any) => row.id === submitted.credentialId)).toBe(true);
    await expectOk(await call(reviewer, `/api/v1/credentials/${submitted.credentialId}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: "verified",
        reason: "Independent platform review against the synthetic register",
        checksPerformed: "Checked registration and licence numbers against the synthetic UMDPC register",
      }),
    }));
    const after = await expectOk(await call(reviewer, "/api/v1/credentials/queue"));
    expect(after.queue.some((row: any) => row.id === submitted.credentialId)).toBe(false);
    expect((await call(admin, "/api/v1/credentials/queue")).status).toBe(403);
  });

  it("computes an expired effective status at request time once a verified credential passes expiry (AT25)", async () => {
    const submitted = await expectOk(await call(admin, "/api/v1/credentials", {
      method: "POST",
      body: JSON.stringify({
        subjectType: "practitioner",
        credentialType: "Professional licence",
        issuer: "Uganda Medical and Dental Practitioners Council",
        jurisdiction: "Uganda",
        credentialNumber: `EXPIRY-CRED-${stamp}`,
        issuedOn: "2024-01-01",
        expiresOn: "2027-01-01",
      }),
    }), 201);
    await expectOk(await call(reviewer, `/api/v1/credentials/${submitted.credentialId}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: "verified",
        reason: "Independent platform review against the synthetic register",
        checksPerformed: "Checked registration and licence numbers against the synthetic UMDPC register",
      }),
    }));

    const verified = (await expectOk(await call(admin, "/api/v1/credentials/mine"))).credentials
      .find((row: any) => row.id === submitted.credentialId);
    expect(verified.status).toBe("verified");
    expect(verified.effectiveStatus).toBe("verified");

    await withContext(sql, {
      tenantId: null, userId: reviewer.userId, patientId: null,
      actorKind: "staff", roles: [], platformRole: "credential_reviewer",
    }, async (tx) => {
      await tx`update credentials set expires_on = current_date - 1 where id = ${submitted.credentialId}`;
    });

    const expired = (await expectOk(await call(admin, "/api/v1/credentials/mine"))).credentials
      .find((row: any) => row.id === submitted.credentialId);
    expect(expired.status).toBe("verified");
    expect(expired.effectiveStatus).toBe("expired");

    expect((await call(reviewer, `/api/v1/credentials/${submitted.credentialId}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: "verified",
        reason: "Re-verifying an expired credential must require a future expiry date",
        checksPerformed: "Checked registration and licence numbers against the synthetic UMDPC register",
      }),
    })).status).toBe(422);
  });

  it("does not expose another facility's onboarding credential queue or affiliations", async () => {
    const switched = await call(admin, "/api/v1/me/context", {
      method: "POST",
      body: JSON.stringify({ tenantId: "22222222-2222-4222-8222-222222222222" }),
    });
    expect(switched.status).toBe(200);
    const queue = await expectOk(await call(admin, "/api/v1/credentials/facility/queue"));
    const [entebbeCase] = await sql`
      select count(*)::int as count from onboarding_cases where tenant_id = '22222222-2222-4222-8222-222222222222'
    `;
    expect(queue.queue.every((row: any) => row.onboardingCaseId !== null)).toBe(true);
    expect(queue.queue.length).toBeLessThanOrEqual(Number(entebbeCase!.count));
    await call(admin, "/api/v1/me/context", {
      method: "POST",
      body: JSON.stringify({ tenantId: "11111111-1111-4111-8111-111111111111" }),
    });
    const back = await expectOk(await call(admin, "/api/v1/onboarding/affiliations/mine"));
    expect(Array.isArray(back.affiliations)).toBe(true);
  });
});
