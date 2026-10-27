import { expect, test, type Page } from "@playwright/test";

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

test("clinician can open every clinical operations workspace", async ({ page }) => {
  await signInStaff(page, "clinician@medveris.local");
  const workspaces: Array<[string, string]> = [
    ["Wards and beds", "Wards and bed management"],
    ["Diagnostics", "Laboratory and imaging orders"],
    ["Pharmacy", "Medication, stock and administration"],
    ["Care programmes", "Care programmes"],
    ["Telehealth", "Remote consultation records"],
    ["Devices", "Connected device registry"],
    ["Assistive AI", "AI job records"],
  ];
  for (const [link, heading] of workspaces) {
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText("Access denied")).toHaveCount(0);
  }
});

test("laboratory and radiology accounts reach diagnostics", async ({ page }) => {
  await signInStaff(page, "lab@medveris.local");
  await page.getByRole("link", { name: "Diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Laboratory and imaging orders" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New order" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await signInStaff(page, "radiology@medveris.local");
  await page.getByRole("link", { name: "Diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Laboratory and imaging orders" })).toBeVisible();
});

test("pharmacist can open prescriptions, stock and catalogue", async ({ page }) => {
  await signInStaff(page, "pharmacist@medveris.local");
  await page.getByRole("link", { name: "Pharmacy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Medication, stock and administration" })).toBeVisible();
  await page.getByRole("tab", { name: "Stock", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Stock lots" })).toBeVisible();
  await page.getByRole("tab", { name: "Catalogue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Medicine catalogue" })).toBeVisible();
});

test("finance and public-health workspaces open with their own permissions", async ({ page }) => {
  await signInStaff(page, "finance@medveris.local");
  await page.getByRole("link", { name: "Finance", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Billing and payments" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Public health", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signInStaff(page, "publichealth@medveris.local");
  await page.getByRole("link", { name: "Public health", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Aggregate reporting" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate report" })).toBeVisible();
});

test("clinician can place a laboratory order through the diagnostics UI", async ({ page }) => {
  await signInStaff(page, "clinician@medveris.local");
  await page.getByRole("link", { name: "Diagnostics", exact: true }).click();
  await page.getByRole("button", { name: "New order" }).click();
  const patientSelect = page.locator("select#patient-picker");
  const encounterSelect = page.locator("select#encounter-picker");
  await expect(patientSelect.locator("option").nth(1)).toBeAttached();
  let chosen: { patientId: string; patientName: string; encounterId: string } | null = null;
  const optionCount = await patientSelect.locator("option").count();
  for (let index = 1; index < optionCount && !chosen; index += 1) {
    const option = patientSelect.locator("option").nth(index);
    const patientId = await option.getAttribute("value");
    const patientName = (await option.textContent())?.trim() ?? "";
    if (!patientId) continue;
    await patientSelect.selectOption(patientId);
    await page.waitForTimeout(400);
    const encounterOptions = encounterSelect.locator("option");
    if (await encounterOptions.count() > 1) {
      const encounterId = await encounterOptions.nth(1).getAttribute("value");
      if (encounterId) chosen = { patientId, patientName, encounterId };
    }
  }
  expect(chosen, "expected at least one linked patient with an active encounter").not.toBeNull();
  if (!chosen) throw new Error("expected a linked patient with an active encounter");
  const chosenCase = chosen as { patientId: string; patientName: string; encounterId: string };
  await patientSelect.selectOption(chosenCase.patientId);
  await page.waitForTimeout(400);
  await encounterSelect.selectOption(chosenCase.encounterId);
  await page.getByLabel("Clinical note").fill("Synthetic E2E check: persistent cough, request full blood count.");
  await page.getByLabel("Catalogue test").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByText(/Order placed/)).toBeVisible();
  const patientLabel = chosenCase.patientName.split("—")[0]?.trim() ?? chosenCase.patientName;
  const rowName = new RegExp(patientLabel.split(", ").reverse().join(" "));
  await expect(page.getByRole("cell", { name: rowName }).first()).toBeVisible();
});

test("clinician can schedule and open a theatre case with safety checkpoints", async ({ page }) => {
  await signInStaff(page, "clinician@medveris.local");
  await page.getByRole("link", { name: "Theatre", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operating theatre and anesthesia" })).toBeVisible();
  await page.getByRole("button", { name: "New theatre case" }).click();
  const patientSelect = page.locator("select#patient-picker");
  const encounterSelect = page.locator("select#encounter-picker");
  await expect(patientSelect.locator("option").nth(1)).toBeAttached();
  let linked: { patientId: string; encounterId: string } | null = null;
  const optionCount = await patientSelect.locator("option").count();
  for (let index = 1; index < optionCount && !linked; index += 1) {
    const patientId = await patientSelect.locator("option").nth(index).getAttribute("value");
    if (!patientId) continue;
    await patientSelect.selectOption(patientId);
    await page.waitForTimeout(400);
    if (await encounterSelect.locator("option").count() > 1) {
      const encounterId = await encounterSelect.locator("option").nth(1).getAttribute("value");
      if (encounterId) linked = { patientId, encounterId };
    }
  }
  expect(linked, "expected a linked patient with an active encounter").not.toBeNull();
  if (!linked) throw new Error("expected a linked patient with an active encounter");
  const link = linked as { patientId: string; encounterId: string };
  await patientSelect.selectOption(link.patientId);
  await page.waitForTimeout(400);
  await encounterSelect.selectOption(link.encounterId);
  await page.getByLabel("Procedure").fill("Synthetic theatre wound debridement");
  await page.getByRole("button", { name: "Schedule case" }).click();
  await expect(page.getByText("Theatre case scheduled.")).toBeVisible();
  const row = page.getByRole("row", { name: /Synthetic theatre wound debridement/ }).first();
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Synthetic theatre wound debridement" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Safety checklists" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark preop-ready" })).toBeVisible();
});

test.describe("mobile navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("hamburger opens the stacked navigation and closes after a link is chosen", async ({ page }) => {
    await signInStaff(page, "clinician@medveris.local");
    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    const menu = page.getByRole("button", { name: "Open navigation" });
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox?.x ?? 999).toBeLessThan(40);
    await expect(nav).toBeHidden();
    await menu.click();
    await expect(nav).toBeVisible();
    const drawer = page.locator("#app-sidebar");
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox?.x ?? 999).toBeLessThan(2);
    await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(nav).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await expect(nav).toBeVisible();
    await nav.getByRole("button", { name: "Workspace" }).click();
    await expect(nav.getByRole("link", { name: "Clinical worklist" })).toBeHidden();
    await nav.getByRole("button", { name: "Workspace" }).click();
    await nav.getByRole("link", { name: "Clinical worklist" }).click();
    await expect(page).toHaveURL(/\/worklist/);
    await expect(nav).toBeHidden();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  });
});

test("clinician can register and triage an unidentified emergency patient", async ({ page }) => {
  await signInStaff(page, "clinician@medveris.local");
  await page.getByRole("link", { name: "Emergency", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Emergency care board" })).toBeVisible();
  await page.getByRole("tab", { name: "Temporary / unidentified" }).click();
  await page.getByLabel("Family name").fill(`EmergencyE2E${Date.now()}`);
  await page.getByLabel("Approximate date of birth").fill("1990-01-01");
  await page.getByLabel("Presenting problem").fill("Synthetic emergency arrival for browser verification.");
  await page.getByRole("button", { name: "Register emergency case" }).click();
  await expect(page).toHaveURL(/\/emergency\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Record triage" })).toBeVisible();
  await expect(page.getByText(/^Temporary identity\. Reconcile/)).toBeVisible();
  await page.getByLabel("Presenting complaint").fill("Collapsed at home (synthetic browser check).");
  await page.getByRole("button", { name: "Save triage" }).click();
  await expect(page.getByText("Triage saved. The encounter moved to triaged.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Serial observations" })).toBeVisible();
});

test("clinician tracks a follow-up and referral through the care coordination UI", async ({ page }) => {
  const stamp = Date.now();
  const followUpText = `E2E follow-up ${stamp}`;
  const referralReason = `E2E referral ${stamp}`;
  await signInStaff(page, "clinician@medveris.local");
  await page.getByRole("link", { name: "Clinical worklist", exact: true }).click();
  const row = page.getByRole("row", { name: /Joseph Mukasa/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Joseph Mukasa");

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("Follow-up date").fill(yesterday);
  await page.getByLabel("Instructions").fill(followUpText);
  await page.getByRole("button", { name: "Schedule follow-up" }).click();
  await expect(page.getByText(followUpText)).toBeVisible();

  await page.getByLabel("Destination facility or service").fill("Synthetic Regional Hospital");
  await page.getByLabel("Referral reason").fill(referralReason);
  await page.getByLabel("Priority").selectOption("urgent");
  await page.getByRole("button", { name: "Record referral" }).click();
  await expect(page.getByText(referralReason)).toBeVisible();

  await page.getByRole("link", { name: "Follow-ups and referrals", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Follow-ups and referrals" })).toBeVisible();
  const followUpRow = page.getByRole("row", { name: new RegExp(followUpText) });
  await expect(followUpRow).toBeVisible();
  await expect(followUpRow.getByText("overdue")).toBeVisible();
  await followUpRow.getByRole("button", { name: "Complete" }).click();
  await page.getByLabel("Decision note").fill("Synthetic follow-up completed in browser flow.");
  await page.getByRole("button", { name: "Save status" }).click();
  await expect(page.getByText("Follow-up marked completed.")).toBeVisible();

  await page.getByRole("tab", { name: "Referrals" }).click();
  const referralRow = page.getByRole("row", { name: new RegExp(referralReason) });
  await expect(referralRow).toBeVisible();
  await referralRow.getByRole("button", { name: "Accept locally" }).click();
  await page.getByLabel("Decision note").fill("Synthetic local acceptance recorded in browser flow.");
  await page.getByRole("button", { name: "Save status" }).click();
  await expect(page.getByText("Referral marked accepted.")).toBeVisible();
});
