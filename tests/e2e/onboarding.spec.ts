import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "Medveris!2026";

async function signInStaff(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Two-step verification")).toBeVisible();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("clinician reviews onboarding guidance and searches the Uganda catalogue", async ({ page }) => {
  await signInStaff(page, "clinician@medveris.local");
  await page.getByRole("link", { name: "Onboarding", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your onboarding path" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Uganda onboarding catalogue" })).toBeVisible();
  await page.getByLabel("Search catalogue").fill("Medical Officer");
  await expect(page.getByRole("row", { name: /Medical Officer MED-OFF-STD/ })).toBeVisible();
  await expect(page.getByText(/Onboarding never grants a clinical privilege/)).toBeVisible();
});

test("patient opens the caregiver path and sees the inactive-request guidance", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("patient@medveris.local");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await page.getByRole("link", { name: "Caregivers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your caregiver access" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invite a caregiver" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send caregiver request" })).toBeDisabled();
  await page.getByLabel("Caregiver email").fill("reception@medveris.local");
  await expect(page.getByRole("button", { name: "Send caregiver request" })).toBeEnabled();
});
