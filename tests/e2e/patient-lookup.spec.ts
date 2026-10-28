import { expect, test } from "./fixtures.js";

test("reception confirms, misses and searches patients without failed API requests", async ({ page }) => {
  test.slow();
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("reception@medveris.local");
  await page.getByLabel("Password").fill("Medveris!2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/patients");
  const familyName = `Lookup${Date.now()}`;
  await page.getByLabel("Given name").fill("Synthetic");
  await page.getByLabel("Family name", { exact: true }).last().fill(familyName);
  await page.locator("#reg-dob").fill("1990-04-12");
  await page.getByRole("button", { name: "Register patient" }).click();
  await expect(page.getByText(/Registered MV-/)).toBeVisible();
  const publicId = /MV-[0-9A-Z-]{19}/.exec(await page.getByText(/Registered MV-/).innerText())![0];

  await page.locator("#resolve-id").fill(publicId.toLowerCase().replace(/-/g, " "));
  await page.locator("#resolve-family").fill(familyName);
  await page.locator("#resolve-dob").fill("1990-04-12");
  await page.getByRole("button", { name: "Confirm identity" }).click();
  await expect(page.getByText("Patient confirmed")).toBeVisible();
  await expect(page.getByText(publicId).first()).toBeVisible();

  await page.locator("#resolve-dob").fill("1990-04-13");
  await page.getByRole("button", { name: "Confirm identity" }).click();
  await expect(page.getByText("No matching patient")).toBeVisible();

  await page.locator("#search-q").fill(familyName.toLowerCase());
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const row = page.getByRole("row", { name: new RegExp(familyName) });
  await expect(row).toContainText("1990-04-12");
  await row.getByRole("button", { name: "Select" }).click();
  await expect(page.getByText("Patient confirmed")).toBeVisible();

  expect(failures).toEqual([]);
});
