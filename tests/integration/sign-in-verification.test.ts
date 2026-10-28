import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "@medveris/auth";
import { createSql } from "@medveris/db";
import { createApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { LocalMailSink } from "../../apps/api/src/lib/local-email.js";
import { LocalStorage } from "../../apps/api/src/lib/local-storage.js";
import type { AppDeps } from "../../apps/api/src/types.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for sign-in verification tests");
const sql = createSql(url, { max: 3 });
const config = loadConfig({ ...process.env, APP_ENV: "test", APP_ORIGIN: "http://localhost:5173" });
const mailDir = `${process.env.TMPDIR ?? "/tmp"}/medveris-signin-mail-${crypto.randomUUID()}`;
const deps: AppDeps = {
  sql,
  config,
  email: new LocalMailSink(mailDir),
  storage: new LocalStorage(`${process.env.TMPDIR ?? "/tmp"}/medveris-signin-storage-${crypto.randomUUID()}`),
};
const app = createApp(deps);
const password = "Synthetic-SignIn-2026!";
const email = `signin.${crypto.randomUUID()}@example.test`;
let secret = "";
let recoveryCodes: string[] = [];

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

async function startChallenge(): Promise<string> {
  const response = await post("/api/v1/auth/login", { email, password });
  const body = await response.json() as any;
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.mfaRequired).toBe(true);
  return body.challengeId as string;
}

const verify = (challengeId: string, code: string) => post("/api/v1/auth/login/mfa", { challengeId, code });

async function emailedCodes(): Promise<string[]> {
  const files = (await readdir(mailDir).catch(() => [] as string[])).filter((name) => name.includes(email)).sort();
  const codes: string[] = [];
  for (const name of files) {
    const match = /sign-in code is (\d{6})/.exec(await readFile(join(mailDir, name), "utf8"));
    if (match) codes.push(match[1]!);
  }
  return codes;
}

beforeAll(async () => {
  expect((await post("/api/v1/auth/register/facility", {
    email, password, givenName: "Synthetic", familyName: "SignIn", facilityName: "Synthetic Sign-in Clinic",
  })).status).toBe(201);
  const login = await post("/api/v1/auth/login", { email, password });
  const session = await login.json() as any;
  const cookie = (login.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="))!.split(";")[0]!;
  const headers = { cookie, [config.csrfHeader]: session.csrfToken as string };
  const started = await (await post("/api/v1/auth/mfa/enroll/start", {}, headers)).json() as any;
  secret = started.secret;
  const enrolled = await post("/api/v1/auth/mfa/enroll/verify", { code: await totpCode(secret) }, headers);
  const body = await enrolled.json() as any;
  expect(enrolled.status, JSON.stringify(body)).toBe(200);
  recoveryCodes = body.recoveryCodes;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("emailed sign-in codes", () => {
  it("emails a code that completes sign-in once and verifies the address", async () => {
    const challengeId = await startChallenge();
    const sent = await post("/api/v1/auth/login/mfa/email", { challengeId });
    const body = await sent.json() as any;
    expect(sent.status, JSON.stringify(body)).toBe(200);
    expect(body.sentTo).toBe(`s•••@example.test`);
    expect((await post("/api/v1/auth/login/mfa/email", { challengeId })).status).toBe(429);

    const [code] = await emailedCodes();
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === "000000" ? "000001" : "000000";
    expect((await verify(challengeId, wrong)).status).toBe(401);
    const ok = await verify(challengeId, code!);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await verify(challengeId, code!)).status).toBe(401);

    const [user] = await sql`select email_verified_at from users where email = ${email}`;
    expect(user?.emailVerifiedAt).toBeTruthy();
    const [challenge] = await sql`select verified_method, failed_attempts from auth_challenges where id = ${challengeId}`;
    expect(challenge).toMatchObject({ verifiedMethod: "email", failedAttempts: 1 });
  });

  it("does not accept a code emailed for a different sign-in", async () => {
    const first = await startChallenge();
    expect((await post("/api/v1/auth/login/mfa/email", { challengeId: first })).status).toBe(200);
    const code = (await emailedCodes()).at(-1)!;
    const second = await startChallenge();
    expect((await verify(second, code)).status).toBe(401);
  });

  it("refuses unknown challenges", async () => {
    expect((await post("/api/v1/auth/login/mfa/email", { challengeId: crypto.randomUUID() })).status).toBe(401);
  });
});

describe("recovery codes", () => {
  it("accepts each recovery code once", async () => {
    expect(recoveryCodes).toHaveLength(8);
    const recovery = recoveryCodes[0]!;
    expect((await verify(await startChallenge(), recovery)).status).toBe(200);
    expect((await verify(await startChallenge(), recovery)).status).toBe(401);
    expect((await verify(await startChallenge(), recoveryCodes[1]!)).status).toBe(200);
  });
});

describe("attempt limit", () => {
  it("closes the challenge after five incorrect codes", async () => {
    const challengeId = await startChallenge();
    for (let attempt = 0; attempt < 5; attempt++) expect((await verify(challengeId, "abcdefghijkl")).status).toBe(401);
    expect((await verify(challengeId, await totpCode(secret))).status).toBe(401);
    expect((await post("/api/v1/auth/login/mfa/email", { challengeId })).status).toBe(401);
  });
});
