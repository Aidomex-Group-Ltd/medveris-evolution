import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { totpCode } from "../../packages/auth/src/index.js";

const SEED_PASSWORD = "Medveris!2026";
const KAMPALA = "Kampala Community Clinic (synthetic)";

async function invitationLink(email: string): Promise<string> {
  const dir = join(process.cwd(), process.env.MAIL_SINK_DIR ?? ".mail-sink");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const files = (await readdir(dir).catch(() => [])).filter((name) => name.includes(email)).sort().reverse();
    for (const name of files) {
      const match = /(\/accept-invitation\?token=[A-Za-z0-9_-]+)/.exec(await readFile(join(dir, name), "utf8"));
      if (match) return match[1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no invitation email for ${email}`);
}

async function staffSignIn(page: Page, email: string, password = SEED_PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByRole("tab", { name: "Facility staff sign-in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("an administrator's invitation takes a new staff member through confirmation into the facility", async ({ browser }) => {
  test.slow();
  const invitee = `invited.${Date.now()}@example.test`;
  const password = "Synthetic-Invitee-2026!";

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await staffSignIn(admin, "admin@medveris.local");
  await expect(admin.getByRole("heading", { name: "Choose a facility" })).toBeVisible();
  await admin.getByRole("button", { name: new RegExp(KAMPALA.replace(/[()]/g, "\\$&")) }).click();
  await expect(admin).toHaveURL(/\/$/);
  await admin.goto("/admin");
  await admin.getByLabel("Work email").fill(invitee);
  await admin.getByRole("combobox").first().selectOption("receptionist");
  await admin.getByRole("button", { name: "Create invitation" }).click();
  await expect(admin.getByText(`Invitation emailed to ${invitee}`)).toBeVisible();
  await expect(admin.getByRole("row", { name: new RegExp(invitee) }).getByText("pending")).toBeVisible();

  const inviteeContext = await browser.newContext();
  const page = await inviteeContext.newPage();
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 500) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(await invitationLink(invitee));
  await expect(page.getByRole("heading", { name: "You have been invited to join a facility." })).toBeVisible();
  await expect(page.getByText("Not found")).toHaveCount(0);
  await expect(page.getByText(KAMPALA)).toBeVisible();
  await page.reload();
  await expect(page.getByText(KAMPALA)).toBeVisible();

  await page.getByLabel("Given name").fill("Synthetic");
  await page.getByLabel("Family name").fill("Invitee");
  await page.getByLabel(/^Password/).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText(`You are now registered as staff at ${KAMPALA}`)).toBeVisible();

  await page.getByRole("button", { name: "Continue to Facility staff sign-in" }).click();
  await expect(page).toHaveURL(/\/mfa-setup$/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.getByLabel("Setup key").inputValue()).replace(/\s/g, "");
  await page.getByLabel("Verification code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await page.getByRole("button", { name: /I have saved my codes/ }).click();
  await expect(page.getByText(KAMPALA).first()).toBeVisible();
  expect((await page.request.get("/api/v1/me")).ok()).toBe(true);
  expect((await (await page.request.get("/api/v1/me")).json()).activeTenant.name).toBe(KAMPALA);

  await admin.reload();
  await expect(admin.getByRole("row", { name: new RegExp(invitee) }).first()).toBeVisible();
  await expect(admin.getByRole("row", { name: new RegExp(`Synthetic Invitee.*${invitee.replace(/\./g, "\\.")}.*receptionist`) })).toBeVisible();
  expect(failures).toEqual([]);

  await adminContext.close();
  await inviteeContext.close();
});

test("an existing account signs in from the invitation and returns to it to accept", async ({ page, playwright }) => {
  test.slow();
  const email = `existing.${Date.now()}@example.test`;
  const password = "Synthetic-Existing-2026!";
  expect((await page.request.post("/api/v1/auth/register/patient", {
    data: { email, password, givenName: "Synthetic", familyName: "Existing", dateOfBirth: "1990-01-01" },
  })).status()).toBe(201);

  const admin = await playwright.request.newContext({ baseURL: "http://localhost:5173" });
  const challenge = await (await admin.post("/api/v1/auth/login", { data: { email: "admin@medveris.local", password: SEED_PASSWORD } })).json();
  const { code } = await (await admin.get("/api/v1/auth/totp/dev?email=admin%40medveris.local")).json();
  const { csrfToken } = await (await admin.post("/api/v1/auth/login/mfa", { data: { challengeId: challenge.challengeId, code } })).json();
  const headers = { "x-medveris-csrf": csrfToken };
  expect((await admin.post("/api/v1/me/context", { data: { tenantId: "11111111-1111-4111-8111-111111111111" }, headers })).status()).toBe(200);
  expect((await admin.post("/api/v1/admin/invitations", { data: { email, roles: ["receptionist"] }, headers })).status()).toBe(201);
  await admin.dispose();

  const link = await invitationLink(email);
  await page.goto(link);
  await expect(page.getByText(KAMPALA)).toBeVisible();
  await page.getByRole("button", { name: "Sign in to accept" }).click();
  await expect(page.getByRole("tab", { name: "Facility staff sign-in", selected: true })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${link.replace(/[?]/g, "\\?")}$`));
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByText(`You are now registered as staff at ${KAMPALA}`)).toBeVisible();
});

test("a facility staff member with one assignment opens that facility from the sign-in sheet", async ({ page }) => {
  await staffSignIn(page, "reception@medveris.local");
  await expect(page).toHaveURL(/\/$/);
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.activeTenant.name).toBe(KAMPALA);
});

test("an unrelated account cannot open another facility's workspace", async ({ page }) => {
  await staffSignIn(page, "clinician.b@medveris.local");
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.activeTenant.name).not.toBe(KAMPALA);
  const kampala = me.memberships.find((membership: { tenantName: string }) => membership.tenantName === KAMPALA);
  expect(kampala).toBeUndefined();
  const attempt = await page.request.post("/api/v1/me/context", {
    data: { tenantId: "11111111-1111-4111-8111-111111111111" },
    headers: { "x-medveris-csrf": me.csrfToken },
  });
  expect(attempt.status()).toBe(404);
});

test("an invalid invitation link explains itself instead of showing a missing workspace", async ({ page }) => {
  await page.goto("/accept-invitation?token=not-a-real-invitation-token-000000");
  await expect(page.getByText("Invitation not found")).toBeVisible();
  await expect(page.getByText("The requested workspace does not exist")).toHaveCount(0);
  await page.goto("/accept-invitation");
  await expect(page.getByText("Invitation not found")).toBeVisible();
});
