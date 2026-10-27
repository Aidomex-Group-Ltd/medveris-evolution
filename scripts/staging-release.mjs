import { spawnSync } from "node:child_process";
import { EXPECTED, VERSION_HEADER, versionOverrideHeader } from "./staging-gate.mjs";

/**
 * Side-effecting release steps shared by staging-deploy.mjs and staging-rollback.mjs.
 */

const ATTEMPTS = 12;
const DELAY_MS = 5_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Points staging traffic at the given version specs (`<id>@<percent>%`).
 * @param {string[]} specs
 * @param {string} message
 */
export function versionsDeploy(specs, message) {
  console.log(`\nstaging release: wrangler versions deploy ${specs.join(" ")}`);
  const result = spawnSync("npx", ["wrangler", "versions", "deploy", ...specs, "--env", "staging", "--yes", "--message", message], { stdio: "inherit" });
  return result.status === 0;
}

async function get(path, headers) {
  const response = await fetch(`${EXPECTED.origin}${path}`, { headers: { "cache-control": "no-cache", ...headers }, redirect: "manual" });
  return { status: response.status, version: response.headers.get(VERSION_HEADER), body: await response.text() };
}

/**
 * Confirms that `versionId` itself answers liveness, readiness and the app shell. With `override`, requests
 * carry the version-override header so a 0% version can be tested before it receives traffic.
 * @param {string} versionId
 * `allowUntagged` accepts responses without the version header, for rollback targets released before the
 * version-metadata binding existed.
 * @param {{ override: boolean, expectedEntry?: string, allowUntagged?: boolean }} options
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function verifyVersion(versionId, { override, expectedEntry, allowUntagged = false }) {
  const headers = override ? { "Cloudflare-Workers-Version-Overrides": versionOverrideHeader(EXPECTED.worker, versionId) } : {};
  let detail = "not probed";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const live = await get("/api/v1/health/live", headers);
      const ready = await get("/api/v1/health/ready", headers);
      const shell = await get("/", headers);
      const matches = (/** @type {string | null} */ version) => version === versionId || (allowUntagged && version === null);
      const answeredBy = matches(live.version) && matches(ready.version);
      const assetsCurrent = !expectedEntry || shell.body.includes(expectedEntry);
      detail = `live=${live.status} ready=${ready.status} shell=${shell.status} version=${answeredBy ? "match" : live.version ?? "none"} assets=${assetsCurrent ? "current" : "stale"}`;
      if (live.status === 200 && ready.status === 200 && shell.status === 200 && answeredBy && assetsCurrent) return { ok: true, detail };
    } catch (error) {
      detail = `unreachable (${error.cause?.code ?? error.name})`;
    }
    if (attempt < ATTEMPTS) await sleep(DELAY_MS);
  }
  return { ok: false, detail };
}

/** Health probe for a first deployment, where there is no earlier version to compare against. */
export async function probeHealth() {
  let live = "not probed";
  let ready = "not probed";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      live = String((await get("/api/v1/health/live", {})).status);
      ready = String((await get("/api/v1/health/ready", {})).status);
      if (live === "200" && ready === "200") return { ok: true, live, ready };
    } catch (error) {
      live = `unreachable (${error.cause?.code ?? error.name})`;
    }
    if (attempt < ATTEMPTS) await sleep(DELAY_MS);
  }
  return { ok: false, live, ready };
}
