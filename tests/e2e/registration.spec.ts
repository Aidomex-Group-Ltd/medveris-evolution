import { expect, test } from "@playwright/test";

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
