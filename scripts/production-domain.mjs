import { spawnSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { blueVersion, parseJsonOutput, parseWranglerConfig } from "./staging-gate.mjs";
import { PRODUCTION, checkSmokeResponses, declaredDomains, verificationOrigin } from "./production-gate.mjs";
import { ACCOUNT_ID, attachedDomains, cloudflare } from "./cloudflare-api.mjs";
import { createRelease } from "./release.mjs";

/**
 * Attaches medveris.online to medveris-production as a Worker custom domain, only after production is verified.
 *
 *   npm run domain:production:check   # read-only: zone, live version, verification, DNS conflicts
 *   npm run domain:production         # the same checks, then attach and verify DNS, TLS and the app over HTTPS
 *
 * Cloudflare creates the DNS record and certificate for a Worker custom domain; no origin IP is entered and
 * existing records are never overridden or deleted. www.medveris.online is not attached: redirect it to the
 * apex with a Cloudflare Redirect Rule so sessions and CSRF checks use one host.
 */

const apply = !process.argv.includes("--check");
const problems = [];
const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

async function records(name, type) {
  try {
    return await resolver.resolve(name, type);
  } catch {
    return [];
  }
}

async function smoke(get) {
  const [config, me, missing] = await Promise.all([get("/api/v1/public/config"), get("/api/v1/me"), get("/api/v1/production-gate-unknown")]);
  return checkSmokeResponses({ config, me, missing });
}

function fail(message) {
  console.error(`production domain: BLOCKED: ${message}`);
  console.error("production domain: nothing was attached");
  process.exit(1);
}

// 1. Zone.
const zones = await cloudflare(`/zones?name=${PRODUCTION.apex}`);
const zone = zones.success ? zones.result?.[0] : null;
if (!zone) fail(`zone ${PRODUCTION.apex} could not be read`);
if (zone.status !== "active") problems.push(`zone ${PRODUCTION.apex} is ${zone.status}, not active`);
if (zone.account?.id !== ACCOUNT_ID) problems.push(`zone ${PRODUCTION.apex} is not in the MedVeris account`);

// 2. Production must be live and verified before it gets the public name.
const status = spawnSync("npx", ["wrangler", "deployments", "status", "--env", PRODUCTION.env, "--json"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const live = blueVersion(parseJsonOutput(status.stdout ?? ""), PRODUCTION.env);
if (!live.blue) fail(`production is not deployed with a single live version (${live.problems.join("; ")})`);
const config = parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
const declared = declaredDomains(config.env?.production);
const attached = await attachedDomains(PRODUCTION.worker);
if (!attached) fail("Worker custom domains could not be listed");
const before = await createRelease({ env: PRODUCTION.env, worker: PRODUCTION.worker, origin: verificationOrigin({ declared, attached }) }, { attempts: 3 })
  .verifyVersion(live.blue, { override: false, smoke });
if (!before.ok) fail(`production version ${live.blue} failed verification before attachment (${before.detail})`);
console.log(`production domain: live version ${live.blue} verified (${before.detail})`);

// 3. Existing DNS: report conflicts, never change them. Email records are listed so the operator can confirm they are untouched.
const otherService = (await cloudflare(`/accounts/${ACCOUNT_ID}/workers/domains`)).result
  ?.find((domain) => domain.hostname === PRODUCTION.apex && domain.service !== PRODUCTION.worker);
if (otherService) problems.push(`${PRODUCTION.apex} is already attached to Worker ${otherService.service}`);
const alreadyAttached = attached.includes(PRODUCTION.apex);
const conflicting = alreadyAttached ? [] : [
  ...(await records(PRODUCTION.apex, "A")).map((value) => `A ${value}`),
  ...(await records(PRODUCTION.apex, "AAAA")).map((value) => `AAAA ${value}`),
  ...(await records(PRODUCTION.apex, "CNAME")).map((value) => `CNAME ${value}`),
];
if (conflicting.length) {
  problems.push(`${PRODUCTION.apex} already has address records (${conflicting.join(", ")}); remove or move them deliberately before attaching`);
}
const mx = (await records(PRODUCTION.apex, "MX")).map((record) => record.exchange);
console.log(`production domain: existing MX records left untouched: ${mx.join(", ") || "none"}`);

if (problems.length) {
  for (const problem of problems) console.error(`production domain: BLOCKED: ${problem}`);
  console.error("production domain: nothing was attached");
  process.exit(1);
}
if (!apply) {
  console.log(`production domain: PASS (check only; ${alreadyAttached ? "already attached" : "ready to attach"})`);
  process.exit(0);
}

// 4. Attach without overriding existing records; Cloudflare provisions the DNS record and certificate.
if (!alreadyAttached) {
  const attach = await cloudflare(`/accounts/${ACCOUNT_ID}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({ hostname: PRODUCTION.apex, service: PRODUCTION.worker, environment: "production", zone_id: zone.id, override_existing_dns_record: false }),
  });
  if (!attach.success) fail(`Cloudflare refused the custom domain: ${attach.errors.map((error) => `${error.code} ${error.message}`).join("; ")}`);
  console.log(`production domain: attached ${PRODUCTION.apex} to ${PRODUCTION.worker}`);
}

// 5. Public verification over HTTPS: DNS, TLS (fetch rejects invalid certificates), version, assets and smoke.
const after = await createRelease({ env: PRODUCTION.env, worker: PRODUCTION.worker, origin: PRODUCTION.origin }, { attempts: 36, delayMs: 10_000 })
  .verifyVersion(live.blue, { override: false, smoke });
const addresses = [...await records(PRODUCTION.apex, "A"), ...await records(PRODUCTION.apex, "AAAA")];
console.log(`production domain: ${PRODUCTION.apex} resolves to ${addresses.join(", ") || "nothing yet"}`);
if (!after.ok) {
  console.error(`production domain: ${PRODUCTION.origin} is NOT verified yet (${after.detail}); certificate issuance can take minutes, rerun to re-verify`);
  process.exit(1);
}
console.log(`production domain: ${PRODUCTION.origin} verified over HTTPS (${after.detail})`);
if (!declared.includes(PRODUCTION.apex)) {
  console.log('production domain: next: add "routes": [{ "pattern": "medveris.online", "custom_domain": true }] to env.production in wrangler.jsonc and commit it, so releases keep the domain');
}
