import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Browser, Page } from "@playwright/test";

/**
 * The API rate-limits sign-in, MFA and registration per client address, falling back to X-Forwarded-For when
 * CF-Connecting-IP is absent. The suite runs on one worker from one address, so without a per-test address
 * later tests are refused with 429 depending on how quickly earlier ones ran.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    let hash = testInfo.retry;
    for (const char of testInfo.testId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    await use({ ...extraHTTPHeaders, "x-forwarded-for": `198.51.${(hash >>> 8) & 0xff}.${hash & 0xff}` });
  },
});
