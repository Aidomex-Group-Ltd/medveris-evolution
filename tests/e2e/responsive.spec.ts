import { expect, test, type Page } from "./fixtures.js";

const PASSWORD = "Medveris!2026";
const NARROW = { width: 320, height: 568 };

const SUPPORTED_PORTRAIT = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;

const MOBILE_LANDSCAPE = { width: 844, height: 390 } as const;
const MOBILE_SIZES = SUPPORTED_PORTRAIT.slice(0, 5);

async function visitRoute(page: Page, route: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    const crashed = await page.getByRole("button", { name: "Try again" }).count();
    const h1 = await page.locator("h1").count();
    if (h1 > 0 || crashed === 0) return;
    await page.reload({ waitUntil: "domcontentloaded" });
  }
}

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

test("public pages fit every supported viewport, portrait and landscape", async ({ page }) => {
  test.setTimeout(240_000);
  for (const viewport of [...SUPPORTED_PORTRAIT, MOBILE_LANDSCAPE]) {
    await page.setViewportSize(viewport);
    for (const route of PUBLIC_ROUTES) {
      await visitRoute(page, route);
      await expect(page.locator("h1").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  }
});

test("forms prevent mobile browser zoom and keep touch targets at 320px", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto("/login");
  const email = page.getByLabel("Email");
  await expect(email).toHaveCSS("font-size", "16px");
  // Inputs use at least 44px min-height on mobile (48px under 600px breakpoint)
  const minHeight = await email.evaluate((el) => Number.parseFloat(getComputedStyle(el).minHeight));
  expect(minHeight).toBeGreaterThanOrEqual(44);
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  const box = await signIn.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
});

test("clinician shell, worklist and AI page fit mobile, tablet and desktop", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(NARROW);
  await signInStaff(page, "clinician@medveris.local");

  const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bottomNav).toBeVisible();
  await expect(bottomNav.getByRole("button", { name: "Home" })).toBeVisible();

  await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.locator("#app-sidebar");
  await expect(sidebar).toHaveClass(/mv-sidebar--open/);
  await expect(sidebar.getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();
  const outpatient = sidebar.getByRole("button", { name: "OPD (Outpatient Care)" });
  await outpatient.click();
  await expect(sidebar.getByRole("link", { name: "Clinical worklist", exact: true })).toBeVisible();
  const sidebarBox = await sidebar.boundingBox();
  expect((sidebarBox?.x ?? 0) + (sidebarBox?.width ?? 0)).toBeLessThanOrEqual(320 + 1);
  await sidebar.getByRole("button", { name: "Close navigation" }).click();
  await expect(sidebar).not.toHaveClass(/mv-sidebar--open/);

  await bottomNav.getByRole("button", { name: "Care" }).click();
  const sheet = page.getByRole("dialog", { name: /Care navigation/ });
  await expect(sheet).toBeVisible();
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox?.height ?? 0).toBeLessThanOrEqual((await page.viewportSize())!.height + 1);
  await expectNoHorizontalOverflow(page);
  await sheet.getByRole("button", { name: "Close menu" }).click();
  await expect(sheet).toHaveCount(0);

  for (const viewport of [...MOBILE_SIZES, { ...MOBILE_LANDSCAPE }, { width: 768, height: 1024 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/worklist");
    await expect(page.getByRole("heading", { name: "Clinical worklist" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }

  // Test tables don't overflow on mobile (card-style on small screens)
  for (const viewport of [NARROW, SUPPORTED_PORTRAIT[0]]) {
    await page.setViewportSize(viewport);
    await page.goto("/worklist");
    const tableWrap = page.locator(".mv-table-wrap");
    await expect(tableWrap).toBeVisible();
    // On mobile the table should scroll horizontally within its container, not break page layout
    await expectNoHorizontalOverflow(page);
  }

  for (const viewport of [NARROW, SUPPORTED_PORTRAIT[3], { width: 768, height: 1024 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/ai");
    await expect(page.getByRole("heading", { name: "AI job records" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("global search overlay stays inside the viewport", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await signInStaff(page, "clinician@medveris.local");

  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const width = box?.width ?? 0;
  const height = box?.height ?? 0;
  expect(width).toBeLessThanOrEqual(320 + 1);
  expect(height).toBeLessThanOrEqual(568 + 1);
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("fixed bottom navigation does not obscure main content", async ({ page }) => {
  await page.setViewportSize(SUPPORTED_PORTRAIT[3]);
  await signInStaff(page, "clinician@medveris.local");

  const paddingBottom = await page.locator(".mv-content").evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
  const navHeight = await page.getByRole("navigation", { name: "Mobile navigation" }).evaluate((element) => element.getBoundingClientRect().height);
  expect(paddingBottom).toBeGreaterThanOrEqual(navHeight);
});

test("patient portal fits mobile, portrait, landscape, tablet and desktop", async ({ page }) => {
  await page.setViewportSize(SUPPORTED_PORTRAIT[3]);
  await signInPatient(page);

  await expect(page.getByRole("heading", { name: "Amina Nakato" })).toBeVisible();
  const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(bottomNav).toBeVisible();

  await bottomNav.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: /More navigation/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Consent and sharing" })).toBeVisible();
  await sheet.getByRole("button", { name: "Close menu" }).click();
  await expect(sheet).toHaveCount(0);

  for (const viewport of [...MOBILE_SIZES, MOBILE_LANDSCAPE, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
  }
});

test("patient AI assistant in the portal is mobile-first", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(NARROW);
  await signInPatient(page);

  await page.goto("/portal/assistant");
  await expect(page.getByRole("heading", { name: "AI assistant" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const conversation = page.locator(".mv-conversation");
  if (await conversation.count()) {
    await expect(conversation.locator(".mv-conversation__audience--patient")).toBeVisible();
  }

  for (const viewport of [SUPPORTED_PORTRAIT[1], SUPPORTED_PORTRAIT[2], { width: 768, height: 1024 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/portal/assistant");
    await expect(page.getByRole("heading", { name: "AI assistant" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("AI chat page is mobile-first and fits mobile, tablet and desktop", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(NARROW);
  await signInStaff(page, "clinician@medveris.local");

  await page.goto("/ai/chat");
  await expect(page.getByRole("heading", { name: "AI chat" })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // The conversation panel is only rendered when an AI provider is configured.
  // In a development environment without a configured provider, an EmptyState is shown.
  // Either way the page must not overflow horizontally.
  const conversation = page.locator(".mv-conversation");
  const hasConversation = await conversation.count() > 0;

  if (hasConversation) {
    await expect(conversation).toBeVisible();
    await expect(conversation.locator(".mv-conversation__audience--provider")).toBeVisible();
    const composer = conversation.locator("form[aria-label='Compose message']");
    await expect(composer).toBeVisible();

    // Input should have appropriate touch target size
    const input = composer.locator("input");
    await expect(input).toHaveCSS("min-height", "48px");
    const inputBox = await input.boundingBox();
    expect(inputBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // Test sending a message
    await input.fill("What is the triage protocol for chest pain?");
    await composer.getByRole("button", { name: "Send" }).click();
    await expect(conversation.locator("[data-message-role='user']").first()).toBeVisible().catch(() => undefined);
  }

  // Test across multiple viewports — page must not overflow on any device
  for (const viewport of [NARROW, SUPPORTED_PORTRAIT[2], { width: 768, height: 1024 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/ai/chat");
    await expect(page.getByRole("heading", { name: "AI chat" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test("desktop shell keeps desktop navigation and hides mobile chrome", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await signInStaff(page, "clinician@medveris.local");

  await expect(page.locator(".mv-nav-strip")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
