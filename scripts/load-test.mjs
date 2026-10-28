/**
 * Synthetic load test. Signs in once with a seeded synthetic account and runs a weighted mix of
 * cached public reads, authenticated tenant reads, a replica-eligible report and synthetic
 * patient registrations, then prints latency percentiles, throughput, error and cache rates.
 * Refuses to run against production. Never uses or prints real data, tokens or cookies.
 *
 *   LOAD_ORIGIN=http://localhost:8799 LOAD_CONCURRENCY=20 LOAD_SECONDS=30 node scripts/load-test.mjs
 *   LOAD_WRITE_SHARE=0 disables writes (for example on shared staging).
 */
try {
  process.loadEnvFile(`${process.cwd()}/.env`);
} catch {
  /* environment may be supplied externally */
}

const origin = process.env.LOAD_ORIGIN ?? "http://localhost:8799";
if (/medveris\.online|medveris-production/i.test(origin)) throw new Error("Load tests never target production");
const concurrency = Math.max(1, Math.min(Number(process.env.LOAD_CONCURRENCY ?? 20), 200));
const seconds = Math.max(5, Math.min(Number(process.env.LOAD_SECONDS ?? 30), 600));
const writeShare = Math.max(0, Math.min(Number(process.env.LOAD_WRITE_SHARE ?? 0.05), 0.5));
const email = process.env.LOAD_EMAIL ?? "reception@medveris.local";
const password = process.env.LOAD_PASSWORD ?? "Medveris!2026";
const timeZone = "Africa/Kampala";
const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());

async function json(response) {
  return response.json().catch(() => ({}));
}

function sessionCookie(response) {
  return (response.headers.getSetCookie?.() ?? []).find((value) => value.startsWith("mv_session="))?.split(";")[0] ?? null;
}

async function signIn() {
  const challenge = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = await json(challenge);
  if (!body.mfaRequired) return { cookie: sessionCookie(challenge), csrf: body.csrfToken };
  const { code } = await json(await fetch(`${origin}/api/v1/auth/totp/dev?email=${encodeURIComponent(email)}`));
  const mfa = await fetch(`${origin}/api/v1/auth/login/mfa`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: body.challengeId, code }) });
  const verified = await json(mfa);
  if (!mfa.ok) throw new Error(`sign-in failed with ${mfa.status}; the dev TOTP helper is needed for synthetic staff`);
  return { cookie: sessionCookie(mfa), csrf: verified.csrfToken };
}

const session = await signIn();
const auth = { cookie: session.cookie };

const scenarios = [
  { name: "public-config (cacheable)", weight: 0.25, run: () => fetch(`${origin}/api/v1/public/config`) },
  { name: "directory-meta (cacheable)", weight: 0.15, run: () => fetch(`${origin}/api/v1/public/directory/meta`) },
  { name: "me (authenticated)", weight: 0.2, run: () => fetch(`${origin}/api/v1/me`, { headers: auth }) },
  { name: "queues (tenant read)", weight: 0.2, run: () => fetch(`${origin}/api/v1/queues`, { headers: auth }) },
  { name: "daily-activity report (replica-eligible)", weight: 0.15 - writeShare, run: () => fetch(`${origin}/api/v1/reports/daily-activity?from=${today}&to=${today}&timeZone=${timeZone}`, { headers: auth }) },
  {
    name: "register synthetic patient (write)", weight: writeShare,
    run: () => fetch(`${origin}/api/v1/reception/patients`, {
      method: "POST",
      headers: { ...auth, "x-medveris-csrf": session.csrf, "content-type": "application/json" },
      body: JSON.stringify({ givenName: "Synthetic", familyName: `Load${Date.now()}${Math.floor(Math.random() * 1e6)}`, dateOfBirth: "1990-01-01", sex: "female", identityConfidence: "confirmed-verbal" }),
    }),
  },
].filter((scenario) => scenario.weight > 0);

function pick() {
  const total = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  let roll = Math.random() * total;
  for (const scenario of scenarios) {
    roll -= scenario.weight;
    if (roll <= 0) return scenario;
  }
  return scenarios[scenarios.length - 1];
}

const stats = new Map(scenarios.map((scenario) => [scenario.name, { latencies: [], errors: 0, limited: 0, statuses: {}, cacheHits: 0 }]));
const deadline = Date.now() + seconds * 1000;
const started = Date.now();

async function worker() {
  while (Date.now() < deadline) {
    const scenario = pick();
    const entry = stats.get(scenario.name);
    const t0 = performance.now();
    try {
      const response = await scenario.run();
      await response.arrayBuffer();
      entry.latencies.push(performance.now() - t0);
      entry.statuses[response.status] = (entry.statuses[response.status] ?? 0) + 1;
      if (response.status === 429) entry.limited += 1;
      else if (response.status >= 400) entry.errors += 1;
      if (response.headers.get("x-medveris-cache") === "hit") entry.cacheHits += 1;
    } catch {
      entry.latencies.push(performance.now() - t0);
      entry.errors += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
const elapsed = (Date.now() - started) / 1000;

function percentile(sorted, q) {
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : null;
}

const rows = [];
let total = 0;
let totalErrors = 0;
for (const [name, entry] of stats) {
  const sorted = [...entry.latencies].sort((a, b) => a - b);
  total += sorted.length;
  totalErrors += entry.errors;
  rows.push({
    scenario: name, requests: sorted.length, rps: Number((sorted.length / elapsed).toFixed(1)),
    p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99),
    errorRate: sorted.length ? Number((entry.errors / sorted.length).toFixed(4)) : 0,
    rateLimited: entry.limited, cacheHitRate: sorted.length ? Number((entry.cacheHits / sorted.length).toFixed(3)) : 0,
    statuses: entry.statuses,
  });
}
console.table(rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "statuses"))));
console.log(JSON.stringify({ origin, concurrency, seconds: elapsed, requests: total, rps: Number((total / elapsed).toFixed(1)), errorRate: total ? Number((totalErrors / total).toFixed(4)) : 0, scenarios: rows }, null, 2));
process.exit(totalErrors / Math.max(total, 1) > 0.01 ? 1 : 0);
