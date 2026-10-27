import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

async function latestResetLink(email: string): Promise<string> {
  const dir = join(process.cwd(), process.env.MAIL_SINK_DIR ?? ".mail-sink");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const files = (await readdir(dir).catch(() => [])).filter((name) => name.includes(email)).sort().reverse();
    for (const name of files) {
      const match = /(\/reset-password\?token=[A-Za-z0-9_-]+)/.exec(await readFile(join(dir, name), "utf8"));
      if (match) return match[1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no reset email for ${email}`);
}

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

test("a visitor registers a facility without API errors", async ({ page }) => {
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto("/register?type=facility");
  await expect(page.getByRole("heading", { name: "Register your facility." })).toBeVisible();
  await page.getByLabel("Given name").fill("Synthetic");
  await page.getByLabel("Family name").fill("Registrant");
  await page.getByLabel("Email").fill(`facility.${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("Synthetic-Registration-2026!");
  await page.getByLabel("Facility name").fill("Synthetic E2E Clinic");
  await page.getByLabel("City").fill("Kampala");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  await expect(page.getByText("Facility registered")).toBeVisible();
  expect(failures).toEqual([]);
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
