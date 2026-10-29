import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";
import { totpCode } from "../../packages/auth/src/index.js";

async function latestLink(email: string, path: "/reset-password" | "/verify-email"): Promise<string> {
  const dir = join(process.cwd(), process.env.MAIL_SINK_DIR ?? ".mail-sink");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const files = (await readdir(dir).catch(() => [])).filter((name) => name.includes(email)).sort().reverse();
    for (const name of files) {
      const match = new RegExp(`(${path}\\?token=[A-Za-z0-9_-]+)`).exec(await readFile(join(dir, name), "utf8"));
      if (match) return match[1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no ${path} email for ${email}`);
}

const latestResetLink = (email: string) => latestLink(email, "/reset-password");

test("a new registrant verifies their email from the emailed link", async ({ page }) => {
  const email = `verify.${Date.now()}@example.test`;
  const registered = await page.request.post("/api/v1/auth/register/patient", {
    data: { email, password: "Synthetic-Verify-2026!", givenName: "Synthetic", familyName: "Verifier", dateOfBirth: "1990-01-01" },
  });
  expect(registered.status()).toBe(201);
  await page.goto(await latestLink(email, "/verify-email"));
  await expect(page.getByRole("heading", { name: "Confirm your email address." })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText("Email verified")).toBeVisible();
});

test("a user recovers a forgotten password from the sign-in page", async ({ page }) => {
  const email = `recovery.${Date.now()}@example.test`;
  const registered = await page.request.post("/api/v1/auth/register/facility", {
    data: { email, password: "Synthetic-Original-2026!", givenName: "Synthetic", familyName: "Recovery", facilityName: "Synthetic Recovery Clinic" },
  });
  expect(registered.status()).toBe(201);

  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  await page.goto(await latestResetLink(email));
  await expect(page.getByRole("heading", { name: "Choose a new password." })).toBeVisible();
  await expect(page).toHaveURL(/\/reset-password$/);
  await page.getByLabel("New password", { exact: true }).fill("Synthetic-Recovered-2026!");
  await page.getByLabel("Confirm new password").fill("Synthetic-Recovered-2026!");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();

  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Synthetic-Recovered-2026!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
});

test("a reset link without a token offers to request a new one", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByText("Reset link missing")).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a new reset link" })).toBeVisible();
});

test("a visitor sets up an independent drug shop workspace without API errors", async ({ page }) => {
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto("/register?type=facility");
  await expect(page.getByRole("heading", { name: "Set up your facility or service." })).toBeVisible();
  const choice = page.locator("#ws-path");
  await expect(choice.locator("option")).toHaveText(["Choose an option", "Independent workspace", "New organization or hospital", "Join an organization"]);
  await choice.selectOption("independent");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Choose what kind of unit or service this is")).toBeVisible();
  await page.locator("#ws-unit-type").selectOption("drug-shop");
  await page.locator("#ws-unit-name").fill("Synthetic E2E Drug Shop");
  await page.locator("#ws-unit-city").fill("Kampala");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.locator("#ws-given").fill("Synthetic");
  await page.locator("#ws-family").fill("Registrant");
  await page.locator("#ws-email").fill(`facility.${Date.now()}@example.test`);
  await page.locator("#ws-password").fill("Synthetic-Registration-2026!");
  await page.locator("#ws-confirm").fill("Synthetic-Registration-2026?");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("The passwords do not match")).toBeVisible();
  await page.locator("#ws-confirm").fill("Synthetic-Registration-2026!");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Synthetic E2E Drug Shop · Drug shop")).toBeVisible();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();

  await expect(page).toHaveURL(/\/mfa-setup\?welcome=1$/);
  await expect(page.getByText("Synthetic E2E Drug Shop is ready")).toBeVisible();
  expect(failures).toEqual([]);
});

test("an independent laboratory owner lands on the laboratory dashboard with unit navigation, then and at the next sign-in", async ({ page }) => {
  const email = `lab.owner.${Date.now()}@example.test`;
  const password = "Synthetic-Laboratory-2026!";
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto("/register?type=facility");
  await page.locator("#ws-path").selectOption("independent");
  await page.locator("#ws-unit-type").selectOption("laboratory");
  await page.locator("#ws-unit-name").fill("Synthetic E2E Laboratory");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#ws-given").fill("Synthetic");
  await page.locator("#ws-family").fill("LabOwner");
  await page.locator("#ws-email").fill(email);
  await page.locator("#ws-password").fill(password);
  await page.locator("#ws-confirm").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();

  await expect(page).toHaveURL(/\/mfa-setup\?welcome=1$/);
  await page.getByRole("button", { name: "Set up authenticator" }).click();
  const secret = (await page.getByLabel("Setup key").inputValue()).replace(/\s/g, "");
  await page.getByLabel("Verification code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await page.getByRole("button", { name: /I have saved my codes/ }).click();

  await expect(page.getByRole("heading", { name: "Synthetic E2E Laboratory", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open laboratory queue" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav.getByRole("link", { name: "Laboratory queue" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Point of sale" })).toBeVisible();
  for (const hidden of ["Organizations", "Wards and beds", "Theatre", "Maternity", "Clinical worklist"]) {
    await expect(nav.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Verification code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByRole("heading", { name: "Synthetic E2E Laboratory", level: 1 })).toBeVisible();
  expect(failures).toEqual([]);
});

test("onboarding offers organization and join paths with only the fields they need", async ({ page }) => {
  await page.goto("/register?type=facility");
  await page.locator("#ws-path").selectOption("organization");
  await expect(page.locator("#ws-org-name")).toBeVisible();
  await expect(page.locator("#ws-unit-type")).toHaveCount(0);
  await page.locator("#ws-path").selectOption("join");
  await expect(page.locator("#ws-join-method")).toBeVisible();
  await page.locator("#ws-join-method").selectOption("code");
  await page.locator("#ws-join-code").fill("not-a-real-join-code");
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByText("This organization join code is not valid", { exact: false })).toBeVisible();
});

test("a signed-out visitor loads the sign-in page without API errors", async ({ page }) => {
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});
