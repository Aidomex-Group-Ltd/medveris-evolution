import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";
import { chooseFacility } from "./support.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for directory tests");
const sql = createSql(url, { max: 8 });
const config = loadConfig({
  ...process.env,
  APP_ENV: "test",
  APP_ORIGIN: "http://localhost:5173",
  DEV_SHOW_TOTP_SECRETS: "true",
  PROMOTION_WEBHOOK_SECRET: "test-promotion-webhook-secret",
});
config.terminologyMode = "synthetic";
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(`${process.env.TMPDIR ?? "/tmp"}/medveris-directory-mail-${crypto.randomUUID()}`),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-directory-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

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
    return { cookie: sessionCookie(challenge), csrf: body.csrfToken, userId: (await json(await app.fetch(new Request("http://localhost/api/v1/me", { headers: { cookie: sessionCookie(challenge) } })))).user.id };
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

async function publicCall(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
}

async function expectOk(response: Response, status = 200): Promise<any> {
  const body = await json(response);
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function tokenRequest(clientId: string, clientSecret: string, scope?: string): Promise<Response> {
  return publicCall("/api/v1/public/integrations/oauth/token", {
    method: "POST",
    body: JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope }),
  });
}

let admin: Session;
let finance: Session;
let operator: Session;

beforeAll(async () => {
  admin = await login("admin@medveris.local");
  finance = await login("finance@medveris.local");
  operator = await login("reviewer@medveris.local");
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("public directory and discovery", () => {
  it("returns only published listings with coordinates and service detail", async () => {
    const body = await expectOk(await publicCall("/api/v1/public/directory/facilities?limit=50"));
    expect(body.facilities.length).toBeGreaterThan(0);
    expect(body.facilities.every((facility: any) => facility.publicationStatus === "published")).toBe(true);
    expect(body.facilities.some((facility: any) => facility.name.includes("Jinja Road Pharmacy"))).toBe(false);
    const listed = [...body.sponsored, ...body.facilities].map((facility: any) => facility.id);
    expect(new Set(listed).size).toBe(listed.length);
    const kampala = await expectOk(await publicCall("/api/v1/public/directory/facilities/MV-DIR-KLA-01"));
    expect(kampala.facility.branches[0].latitude).toBeTruthy();
    expect(kampala.facility.services.length).toBeGreaterThan(0);
    expect(kampala.facility.capabilities.some((capability: any) => capability.status === "verified")).toBe(true);
  });

  it("labels sponsored placements separately from organic results", async () => {
    const body = await expectOk(await publicCall("/api/v1/public/directory/facilities?country=Uganda&limit=20"));
    expect(body.sponsored.length).toBeGreaterThan(0);
    expect(body.sponsored[0].sponsored).toBe(true);
    expect(body.sponsored[0].promotion.label).toBe("Sponsored");
    expect(body.facilities.every((facility: any) => facility.sponsored === false)).toBe(true);
    expect(body.ranking.sponsored).toContain("Payment never changes");
  });

  it("filters by straight-line distance and returns a distance value", async () => {
    const body = await expectOk(await publicCall("/api/v1/public/directory/facilities?lat=0.3136&lng=32.5811&radiusKm=10&sort=distance&limit=20"));
    expect(body.facilities.length).toBeGreaterThan(0);
    for (const facility of body.facilities) expect(facility.distanceKm).toBeLessThanOrEqual(10);
    const outside = await expectOk(await publicCall("/api/v1/public/directory/facilities?lat=0.3136&lng=32.5811&radiusKm=1&limit=20"));
    expect(outside.facilities.length).toBe(0);
    expect(outside.total).toBe(0);
  });

  it("serves map configuration without geocoding or routing", async () => {
    const body = await expectOk(await publicCall("/api/v1/public/directory/map-config"));
    expect(body.renderer).toBe("leaflet");
    expect(body.tileUrl).toMatch(/^https:\/\//);
    expect(body.attribution).toContain("OpenStreetMap");
    expect(body.geocodingEnabled).toBe(false);
    expect(body.routingEnabled).toBe(false);
    expect(body.distanceMode).toBe("straight-line");
  });

  it("rejects invalid coordinates", async () => {
    const response = await publicCall("/api/v1/public/directory/facilities?lat=91&lng=32");
    expect(response.status).toBe(422);
  });
});

describe("claims, provider editing and moderation", () => {
  it("lets a provider submit a claim and an operator verify it", async () => {
    const claim = await expectOk(await call(admin, "/api/v1/directory/claims?facility=MV-DIR-NAG-01", {
      method: "POST",
      body: JSON.stringify({
        representativeName: "Amina Administrator",
        roleTitle: "Facility Administrator",
        email: "admin@medveris.local",
        authorityBasis: "Synthetic authority document confirms the administrator acts for this facility.",
      }),
    }), 201);
    const decision = await call(operator, `/api/v1/directory/claims/${claim.claim.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "verify", reason: "Synthetic evidence reviewed and accepted" }),
    });
    await expectOk(decision);
    const listing = await expectOk(await call(admin, "/api/v1/directory/facilities"));
    const naguru = listing.facilities.find((facility: any) => facility.publicId === "MV-DIR-NAG-01");
    expect(naguru.claimedTenantId).toBe(tenantA);
    expect(naguru.publicationStatus).toBe("pending-review");
    await expectOk(await call(operator, `/api/v1/directory/facilities/${naguru.id}/moderation`, {
      method: "POST", body: JSON.stringify({ decision: "publish", note: "Synthetic profile verified for publication" }),
    }));
  });

  it("creates a provider-owned listing in pending review and rejects verified capabilities from providers", async () => {
    const created = await expectOk(await call(admin, "/api/v1/directory/facilities", {
      method: "POST",
      body: JSON.stringify({
        name: "Synthetic Provider Clinic",
        facilityType: "clinic",
        country: "Uganda",
        region: "Central",
        district: "Kampala",
        branches: [{ name: "Main", isPrimary: true, country: "Uganda", latitude: 0.32, longitude: 32.59 }],
        services: [{ code: "OPD", name: "Outpatient", category: "outpatient" }],
      }),
    }), 201);
    expect(created.facility.publicationStatus).toBe("pending-review");
    const rejected = await call(admin, `/api/v1/directory/facilities/${created.facility.id}/capabilities`, {
      method: "POST",
      body: JSON.stringify({ code: "emergency", name: "Emergency care", status: "verified" }),
    });
    expect(rejected.status).toBe(403);
  });
});

describe("sponsored campaigns and payments", () => {
  it("runs payment, editorial approval, event accounting and signed webhooks", async () => {
    const pkg = await expectOk(await call(operator, "/api/v1/promotions/packages", {
      method: "POST",
      body: JSON.stringify({
        code: `TEST-${Date.now()}`, name: "Test search boost", price: 1000, currency: "UGX",
        durationDays: 30, placementSurface: "search", sponsoredSlots: 1, maxActivePerFacility: 20,
      }),
    }), 201);
    const facilities = await expectOk(await call(admin, "/api/v1/directory/facilities"));
    const kampala = facilities.facilities.find((facility: any) => facility.publicId === "MV-DIR-KLA-01");
    expect(kampala).toBeTruthy();
    const startsOn = new Date().toISOString().slice(0, 10);
    const endsOn = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const campaign = await expectOk(await call(admin, "/api/v1/promotions/campaigns", {
      method: "POST",
      body: JSON.stringify({
        packageId: pkg.package.id, facilityId: kampala.id, startsOn, endsOn,
        serviceCategories: ["outpatient"], scopeCountry: "Uganda",
      }),
    }), 201);
    const idempotency = crypto.randomUUID();
    const paymentBody = { method: "manual", providerReference: `TEST-${Date.now()}` };
    const payment = await expectOk(await call(admin, `/api/v1/promotions/campaigns/${campaign.campaign.id}/payments`, {
      method: "POST",
      headers: { "idempotency-key": idempotency },
      body: JSON.stringify(paymentBody),
    }), 201);
    const repeated = await expectOk(await call(admin, `/api/v1/promotions/campaigns/${campaign.campaign.id}/payments`, {
      method: "POST",
      headers: { "idempotency-key": idempotency },
      body: JSON.stringify(paymentBody),
    }), 201);
    expect(repeated.payment.id).toBe(payment.payment.id);
    await expectOk(await call(finance, `/api/v1/promotions/payments/${payment.payment.id}/confirm`, {
      method: "POST", body: JSON.stringify({ providerReference: `CONF-${Date.now()}` }),
    }));
    await expectOk(await call(operator, `/api/v1/promotions/campaigns/${campaign.campaign.id}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Synthetic editorial review passed" }),
    }));
    const search = await expectOk(await publicCall("/api/v1/public/directory/facilities?country=Uganda&limit=50"));
    expect(search.sponsored.some((item: any) => item.id === kampala.id)).toBe(true);
    await expectOk(await publicCall("/api/v1/public/directory/events", {
      method: "POST",
      body: JSON.stringify({ eventType: "impression", facilityPublicId: "MV-DIR-KLA-01", campaignId: campaign.campaign.id, surface: "search" }),
    }), 202);
    const metrics = await expectOk(await call(admin, `/api/v1/promotions/campaigns/${campaign.campaign.id}/metrics`));
    expect(metrics.metrics.some((metric: any) => metric.impressions >= 1)).toBe(true);

    const webhookCampaign = await expectOk(await call(admin, "/api/v1/promotions/campaigns", {
      method: "POST",
      body: JSON.stringify({
        packageId: pkg.package.id, facilityId: kampala.id, startsOn, endsOn,
        serviceCategories: ["outpatient"], scopeCountry: "Uganda",
      }),
    }), 201);
    const webhookReference = `PAY-${Date.now()}`;
    const webhookPayment = await expectOk(await call(admin, `/api/v1/promotions/campaigns/${webhookCampaign.campaign.id}/payments`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ method: "card", provider: "testpay", providerReference: webhookReference }),
    }), 201);
    const payload = JSON.stringify({ provider: "testpay", eventId: `evt-${Date.now()}`, providerReference: webhookReference, status: "confirmed" });
    const signature = createHmac("sha256", "test-promotion-webhook-secret").update(payload).digest("hex");
    const webhook = await publicCall("/api/v1/public/promotions/webhooks/payments", {
      method: "POST", headers: { "x-medveris-signature": `sha256=${signature}` }, body: payload,
    });
    await expectOk(webhook);
    const replay = await publicCall("/api/v1/public/promotions/webhooks/payments", {
      method: "POST", headers: { "x-medveris-signature": `sha256=${signature}` }, body: payload,
    });
    expect((await expectOk(replay)).duplicate).toBe(true);
    const campaigns = await expectOk(await call(admin, "/api/v1/promotions/campaigns"));
    const settled = campaigns.campaigns.find((item: any) => item.id === webhookCampaign.campaign.id);
    expect(settled.paymentStatus).toBe("paid");
    void webhookPayment;
  });
});

describe("hospital integration clients", () => {
  it("issues scoped tokens and enforces scope boundaries", async () => {
    const application = await expectOk(await call(admin, "/api/v1/integrations/applications", {
      method: "POST",
      body: JSON.stringify({
        name: "Synthetic Directory Integration",
        organization: "Kampala Community Clinic",
        technicalContact: "admin@medveris.local",
        intendedUse: "Read the public provider directory for referral routing in synthetic testing.",
        products: ["directory.read"],
      }),
    }), 201);
    expect(application.clientSecret).toMatch(/^mvs_/);
    const before = await tokenRequest(application.client.clientId, application.clientSecret);
    expect(before.status).toBe(401);
    await expectOk(await call(operator, `/api/v1/integrations/clients/${application.client.id}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "activate", reason: "Synthetic integration review passed" }),
    }));
    const token = await expectOk(await tokenRequest(application.client.clientId, application.clientSecret));
    expect(token.access_token).toMatch(/^mvi_/);
    expect(token.scope).toBe("integration.directory.read");
    const directory = await app.fetch(new Request("http://localhost/api/v1/integrations/directory/facilities", {
      headers: { authorization: `Bearer ${token.access_token}` },
    }));
    await expectOk(directory);
    const forbidden = await app.fetch(new Request("http://localhost/api/v1/integrations/patients/match", {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ givenName: "Amina", familyName: "Nakato", dateOfBirth: "1988-04-12" }),
    }));
    expect(forbidden.status).toBe(403);
    const rejectedScope = await tokenRequest(application.client.clientId, application.clientSecret, "integration.patient.match");
    expect(rejectedScope.status).toBe(400);
  });

  it("matches, links and unlinks partner patient identifiers without auto-linking", async () => {
    const application = await expectOk(await call(admin, "/api/v1/integrations/applications", {
      method: "POST",
      body: JSON.stringify({
        name: "Synthetic Identity Integration",
        organization: "Kampala Community Clinic",
        technicalContact: "admin@medveris.local",
        intendedUse: "Match and link synthetic patient identifiers after human confirmation.",
        products: ["patient.identity"],
      }),
    }), 201);
    await expectOk(await call(operator, `/api/v1/integrations/clients/${application.client.id}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "activate", reason: "Synthetic identity review passed" }),
    }));
    const token = await expectOk(await tokenRequest(application.client.clientId, application.clientSecret));
    const auth = { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" };
    const match = await expectOk(await app.fetch(new Request("http://localhost/api/v1/integrations/patients/match", {
      method: "POST", headers: auth,
      body: JSON.stringify({ givenName: "Amina", familyName: "Nakato", dateOfBirth: "1988-04-12" }),
    })));
    expect(match.linked).toBe(false);
    expect(match.candidates[0].publicId).toBe("MV-7K2M-9QX4-4T2A-8Z3N");
    expect(match.candidates[0].confidence).toBe("high");
    expect(match.candidates[0].phone).toBeUndefined();
    const externalIdentifier = `MRN-${Date.now()}`;
    const link = await expectOk(await app.fetch(new Request("http://localhost/api/v1/integrations/patients/links", {
      method: "POST", headers: auth,
      body: JSON.stringify({ patientId: match.candidates[0].patientId, externalSystem: "synthetic-hms", externalIdentifier }),
    })), 201);
    const replay = await app.fetch(new Request("http://localhost/api/v1/integrations/patients/match", {
      method: "POST", headers: auth,
      body: JSON.stringify({ givenName: "Amina", familyName: "Nakato", dateOfBirth: "1988-04-12", externalSystem: "synthetic-hms", externalIdentifier }),
    }));
    const replayBody = await expectOk(replay);
    expect(replayBody.linked).toBe(true);
    expect(replayBody.linkId).toBe(link.link.id);
    await expectOk(await app.fetch(new Request(`http://localhost/api/v1/integrations/patients/links/${link.link.id}`, {
      method: "DELETE", headers: auth,
      body: JSON.stringify({ reason: "Synthetic test cleanup after identity review" }),
    })));
    const unlinked = await app.fetch(new Request("http://localhost/api/v1/integrations/patients/links", { headers: auth }));
    const unlinkedBody = await expectOk(unlinked);
    expect(unlinkedBody.links.find((item: any) => item.id === link.link.id).status).toBe("unlinked");
  });

  it("does not expose patients from another tenant", async () => {
    const application = await expectOk(await call(operator, "/api/v1/integrations/applications", {
      method: "POST",
      body: JSON.stringify({
        name: "Entebbe Synthetic Integration",
        organization: "Entebbe Family Health Centre",
        tenantId: tenantB,
        technicalContact: "admin@medveris.local",
        intendedUse: "Synthetic cross-tenant isolation check for patient identity matching.",
        products: ["patient.identity"],
      }),
    }), 201);
    await expectOk(await call(operator, `/api/v1/integrations/clients/${application.client.id}/decision`, {
      method: "POST", body: JSON.stringify({ decision: "activate", reason: "Synthetic tenant-scoped review passed" }),
    }));
    const token = await expectOk(await tokenRequest(application.client.clientId, application.clientSecret));
    const match = await expectOk(await app.fetch(new Request("http://localhost/api/v1/integrations/patients/match", {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ givenName: "Amina", familyName: "Nakato", dateOfBirth: "1988-04-12" }),
    })));
    expect(match.candidates).toEqual([]);
  });
});
