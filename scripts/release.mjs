import { spawnSync } from "node:child_process";
import { VERSION_HEADER, parseJsonOutput, rollbackTarget, versionOverrideHeader } from "./staging-gate.mjs";

/**
 * Side-effecting blue-green release steps shared by the staging and production scripts.
 * A target is `{ env, worker, origin }`: the Wrangler environment, the Worker name and the origin probed.
 */

const ATTEMPTS = 12;
const DELAY_MS = 5_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {{ env: string, worker: string, origin: string }} target
 * @param {{ attempts?: number, delayMs?: number }} [timing]
 */
export function createRelease(target, { attempts = ATTEMPTS, delayMs = DELAY_MS } = {}) {
  const label = `${target.env} release`;

  /**
   * Points traffic at the given version specs (`<id>@<percent>%`).
   * @param {string[]} specs
   * @param {string} message
   */
  function versionsDeploy(specs, message) {
    console.log(`\n${label}: wrangler versions deploy ${specs.join(" ")}`);
    const result = spawnSync("npx", ["wrangler", "versions", "deploy", ...specs, "--env", target.env, "--yes", "--message", message], { stdio: "inherit" });
    return result.status === 0;
  }

  async function get(path, headers) {
    const response = await fetch(`${target.origin}${path}`, { headers: { "cache-control": "no-cache", ...headers }, redirect: "manual" });
    return { status: response.status, version: response.headers.get(VERSION_HEADER), headers: response.headers, body: await response.text() };
  }

  /**
   * Confirms that `versionId` itself answers liveness, readiness and the app shell. With `override`, requests
   * carry the version-override header so a 0% version can be tested before it receives traffic.
   * `allowUntagged` accepts responses without the version header, for rollback targets released before the
   * version-metadata binding existed. `smoke` runs extra checks and returns a failure description or null.
   * @param {string} versionId
   * @param {{ override: boolean, expectedEntry?: string, allowUntagged?: boolean,
   *   smoke?: (get: (path: string) => Promise<{ status: number, version: string | null, headers: Headers, body: string }>) => Promise<string | null> }} options
   * @returns {Promise<{ ok: boolean, detail: string }>}
   */
  async function verifyVersion(versionId, { override, expectedEntry, allowUntagged = false, smoke }) {
    const headers = override ? { "Cloudflare-Workers-Version-Overrides": versionOverrideHeader(target.worker, versionId) } : {};
    let detail = "not probed";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const live = await get("/api/v1/health/live", headers);
        const ready = await get("/api/v1/health/ready", headers);
        const shell = await get("/", headers);
        const matches = (/** @type {string | null} */ version) => version === versionId || (allowUntagged && version === null);
        const answeredBy = matches(live.version) && matches(ready.version);
        const assetsCurrent = !expectedEntry || shell.body.includes(expectedEntry);
        const smokeFailure = smoke ? await smoke((path) => get(path, headers)) : null;
        detail = `live=${live.status} ready=${ready.status} shell=${shell.status} version=${answeredBy ? "match" : live.version ?? "none"} assets=${assetsCurrent ? "current" : "stale"}${smoke ? ` smoke=${smokeFailure ?? "pass"}` : ""}`;
        if (live.status === 200 && ready.status === 200 && shell.status === 200 && answeredBy && assetsCurrent && !smokeFailure) return { ok: true, detail };
      } catch (error) {
        detail = `unreachable (${error.cause?.code ?? error.name})`;
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    return { ok: false, detail };
  }

  /** Health probe for a first deployment, where there is no earlier version to compare against. */
  async function probeHealth() {
    let live = "not probed";
    let ready = "not probed";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        live = String((await get("/api/v1/health/live", {})).status);
        ready = String((await get("/api/v1/health/ready", {})).status);
        if (live === "200" && ready === "200") return { ok: true, live, ready };
      } catch (error) {
        live = `unreachable (${error.cause?.code ?? error.name})`;
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    return { ok: false, live, ready };
  }

  /**
   * Switches 100% of traffic back to `requested`, or to the previous fully deployed version (blue during an
   * unfinished release). Code rollback does not undo database migrations.
   * @param {string | undefined} requested
   * @returns {Promise<number>} process exit code
   */
  async function rollback(requested) {
    const prefix = `${target.env} rollback`;
    if (requested && !/^[0-9a-f-]{36}$/.test(requested)) {
      console.error(`${prefix}: the version id must be a Worker version UUID`);
      return 1;
    }
    const wrangler = (...args) => spawnSync("npx", ["wrangler", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).stdout ?? "";
    const status = parseJsonOutput(wrangler("deployments", "status", "--env", target.env, "--json"));
    const deployments = parseJsonOutput(wrangler("deployments", "list", "--env", target.env, "--json"));
    const plan = rollbackTarget(status, Array.isArray(deployments) ? deployments : []);
    const versionId = requested ?? plan.target;
    if (!versionId) {
      for (const problem of plan.problems) console.error(`${prefix}: BLOCKED: ${problem}`);
      return 1;
    }
    if (plan.current && versionId === plan.current) {
      console.error(`${prefix}: ${versionId} already serves all traffic`);
      return 1;
    }
    console.log(`${prefix}: switching ${target.worker} from ${plan.current ?? "a split deployment"} to ${versionId}`);
    if (!versionsDeploy([`${versionId}@100%`], `rollback to ${versionId}`)) {
      console.error(`${prefix}: wrangler versions deploy failed; traffic is unchanged`);
      return 1;
    }
    const check = await verifyVersion(versionId, { override: false, allowUntagged: true });
    console.log(`${prefix}: ${check.ok ? "verified" : "VERIFICATION FAILED"} (${check.detail})`);
    return check.ok ? 0 : 1;
  }

  return { versionsDeploy, verifyVersion, probeHealth, rollback };
}
