import { spawnSync } from "node:child_process";
import { parseJsonOutput } from "./staging-gate.mjs";

/**
 * Minimal Cloudflare API client for the calls Wrangler has no command for (zone lookup, Worker custom domains).
 * The token comes from CLOUDFLARE_API_TOKEN or the logged-in Wrangler session; it stays in memory and is
 * never printed or passed as a process argument.
 */

export const ACCOUNT_ID = "6337ed24a5f8ff4ec3f74517a55a7e6b";

let token = null;

function apiToken() {
  if (token) return token;
  if (process.env.CLOUDFLARE_API_TOKEN) return (token = process.env.CLOUDFLARE_API_TOKEN);
  const result = spawnSync("npx", ["wrangler", "auth", "token", "--json"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const parsed = /** @type {any} */ (parseJsonOutput(result.stdout ?? ""));
  if (result.status !== 0 || typeof parsed?.token !== "string") throw new Error("could not obtain a Cloudflare API token from Wrangler; run `npx wrangler login`");
  return (token = parsed.token);
}

/**
 * @param {string} path API path below /client/v4
 * @param {RequestInit} [init]
 * @returns {Promise<{ success: boolean, result: any, errors: { code: number, message: string }[] }>}
 */
export async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return body ?? { success: false, result: null, errors: [{ code: response.status, message: `HTTP ${response.status}` }] };
}

/** Hostnames attached as Worker custom domains to `service`, or null when they cannot be read. */
export async function attachedDomains(service) {
  const response = await cloudflare(`/accounts/${ACCOUNT_ID}/workers/domains`);
  if (!response.success) return null;
  return response.result.filter((domain) => domain.service === service).map((domain) => domain.hostname);
}
