import { expect, test } from "@playwright/test";
import { totpCode } from "../../packages/auth/src/index.js";

test("a newly registered facility admin enrols MFA before facility workspaces load", async ({ page }) => {
  const email = `mfa.${Date.now()}@example.test`;
  const password = "Synthetic-Mfa-Setup-2026!";
  const registered = await page.request.post("/api/v1/auth/register/facility", {
    data: { email, password, givenName: "Synthetic", familyName: "Enroller", facilityName: "Synthetic MFA Clinic", city: "Kampala" },
  });
  expect(registered.status()).toBe(201);

  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/mfa-setup$/);

  await page.getByRole("button", { name: "Set up authenticator" }).click();
  await expect(page.getByAltText("Authenticator setup QR code")).toBeVisible();
  const secret = (await page.getByLabel("Setup key").inputValue()).replace(/\s/g, "");
  await page.getByLabel("Verification code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify and turn on" }).click();

  await expect(page.getByText("Two-step verification is on")).toBeVisible();
  await expect(page.locator("ul.mv-inline-code li")).toHaveCount(8);
  await page.getByRole("button", { name: /I have saved my codes/ }).click();

  await expect(page).not.toHaveURL(/\/mfa-setup/);
  await expect(page.getByText("Synthetic MFA Clinic").first()).toBeVisible();
  expect(failures).toEqual([]);
});
