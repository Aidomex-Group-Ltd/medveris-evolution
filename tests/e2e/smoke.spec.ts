import { expect, test, type Page } from "./fixtures.js";

const PASSWORD = "Medveris!2026";

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signInStaff(page: Page, email: string): Promise<void> {
  await signIn(page, email);
  await expect(page.getByText("Two-step verification")).toBeVisible();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test("clinician signs in with MFA and opens the clinical worklist", async ({ page }) => {
  await signInStaff(page, "clinician@medveris.local");
  await expect(page.getByRole("heading", { name: /Good day/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clinical worklist", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Clinical worklist", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clinical worklist" })).toBeVisible();
  const row = page.getByRole("row", { name: /Joseph Mukasa/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Joseph Mukasa");
});

test("receptionist cannot see or open the clinical worklist", async ({ page }) => {
  await signInStaff(page, "reception@medveris.local");
  await expect(page.getByRole("heading", { name: /Good day/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clinical worklist", exact: true })).toHaveCount(0);
  await page.goto("/worklist");
  await expect(page.getByText("Access denied")).toBeVisible();
});

test("patient signs in without MFA and reaches the portal", async ({ page }) => {
  await signIn(page, "patient@medveris.local");
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole("heading", { name: "Amina Nakato" })).toBeVisible();
  await page.getByRole("link", { name: "Consent and sharing" }).click();
  await expect(page.getByRole("heading", { name: /Consent/i }).first()).toBeVisible();
});
