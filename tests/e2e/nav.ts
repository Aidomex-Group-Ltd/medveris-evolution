import { expect, type Page } from "./fixtures.js";

/**
 * The sidebar is an off-canvas drawer at every viewport and closes on navigation.
 * Open it, expand the collapsed sections, then follow the destination.
 */
export async function openNavItem(page: Page, item: string): Promise<void> {
  const drawer = page.locator("#app-sidebar");
  const target = drawer.getByRole("link", { name: item, exact: true });
  const openButton = page.getByRole("button", { name: "Open navigation" });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await drawer.isVisible())) await openButton.click();
    await expect(drawer).toBeVisible();
    for (let guard = 0; guard < 20; guard += 1) {
      const toggle = drawer.locator("button[aria-expanded='false']").first();
      if ((await toggle.count()) === 0) break;
      const panelId = await toggle.getAttribute("aria-controls");
      await toggle.click();
      if (panelId) await expect(page.locator(`#${panelId}`)).toBeVisible();
    }
    if (await target.isVisible()) break;
  }
  await target.click();
}
