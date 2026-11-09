import { expect, test, type Page } from "./fixtures.js";

const PASSWORD = "Medveris!2026";
const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 640 };

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.documentWidth, `page should not scroll horizontally (${metrics.documentWidth} > ${metrics.viewportWidth})`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

async function acceptLegalIfNeeded(page: Page): Promise<void> {
  const acceptLegal = page.getByRole("button", { name: /Accept the Terms and acknowledge/ });
  await acceptLegal.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
  if (await acceptLegal.isVisible().catch(() => false)) {
    await acceptLegal.click();
  }
}

async function signInStaff(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Use local development code" }).click();
  await expect(page.getByLabel("Verification code")).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(/\/(dashboard)?$/);
  await acceptLegalIfNeeded(page);
}

async function signInPatient(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill("patient@medveris.local");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await acceptLegalIfNeeded(page);
}

const PUBLIC_ROUTES = ["/", "/pricing", "/about", "/help", "/contacts"];

for (const route of PUBLIC_ROUTES) {
  test(`public page ${route} fits mobile and narrow viewports`, async ({ page }) => {
    for (const viewport of [MOBILE, NARROW]) {
      await page.setViewportSize(viewport);
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
}

test("clinician shell exposes mobile navigation without horizontal overflow", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await signInStaff(page, "clinician@medveris.local");

  const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bottomNav).toBeVisible();
  await expect(bottomNav.getByRole("button", { name: "Home" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.locator("#app-sidebar");
  await expect(sidebar).toHaveClass(/mv-sidebar--open/);
  await expect(sidebar.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
  const outpatient = sidebar.getByRole("button", { name: "OPD (Outpatient Care)" });
  await expect(outpatient).toBeVisible();
  await outpatient.click();
  await expect(sidebar.getByRole("link", { name: "Clinical worklist", exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "Close navigation" }).click();
  await expect(sidebar).not.toHaveClass(/mv-sidebar--open/);

  await bottomNav.getByRole("button", { name: "Care" }).click();
  const sheet = page.getByRole("dialog", { name: /Care navigation/ });
  await expect(sheet).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await sheet.getByRole("button", { name: "Close menu" }).click();
  await expect(sheet).toBeHidden();

  await page.goto("/worklist");
  await expect(page.getByRole("heading", { name: "Clinical worklist" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize(NARROW);
  await expectNoHorizontalOverflow(page);
});

test("desktop shell keeps desktop navigation and hides mobile chrome", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInStaff(page, "clinician@medveris.local");

  await expect(page.locator(".mv-nav-strip")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("patient portal fits mobile with bottom navigation", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await signInPatient(page);

  await expect(page.getByRole("heading", { name: "Amina Nakato" })).toBeVisible();
  const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bottomNav).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await bottomNav.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: /More navigation/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Consent and sharing" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize(NARROW);
  await expectNoHorizontalOverflow(page);
});
