const base = process.env.API_BASE ?? "http://localhost:8787/api/v1";
let cookie = "";
let csrf = "";

async function call(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-medveris-csrf"] = csrf;
  const res = await fetch(`${base}${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return body;
}

const email = process.env.SMOKE_EMAIL ?? "clinician@medveris.local";
const login = await call("/auth/login", { method: "POST", body: { email, password: process.env.SMOKE_PASSWORD ?? "Medveris!2026" } });
if (!login.mfaRequired) throw new Error("expected an MFA challenge for the clinician");
const totp = await (await fetch(`${base}/auth/totp/dev?email=${encodeURIComponent(email)}`)).json();
if (!/^\d{6}$/.test(totp.code ?? "")) throw new Error("development TOTP endpoint did not return a code");
const mfa = await call("/auth/login/mfa", { method: "POST", body: { challengeId: login.challengeId, code: totp.code } });
csrf = mfa.csrfToken;
const me = await call("/me");
if (!me.activeTenant?.roles.includes("clinician")) throw new Error("clinician membership missing");
console.log("session", me.activeTenant.name, me.activeTenant.roles.join(","));

const worklist = await call("/encounters/worklist");
if (!worklist.encounters.length) throw new Error("clinical worklist is empty");
const encounter = worklist.encounters.find((e) => e.state === "triaged" || e.state === "in-progress") ?? worklist.encounters[0];
console.log("worklist", worklist.encounters.length, "selected", encounter.id, encounter.state);

const draft = await call(`/encounters/${encounter.id}/entries`, {
  method: "POST",
  body: {
    title: "Smoke test note",
    subjective: "Synthetic subjective",
    objective: "Synthetic objective",
    assessment: "Synthetic assessment",
    plan: "Synthetic plan",
    clinicalOccurredAt: new Date().toISOString(),
    changeNote: "Smoke test draft",
  },
});
console.log("draft", draft.entryId, "v", draft.version);

const sign = await call(`/entries/${draft.entryId}/sign`, { method: "POST", body: { expectedVersion: 1 } });
console.log("sign", sign);

const amend = await call(`/entries/${draft.entryId}/amendments`, {
  method: "POST",
  body: {
    expectedVersion: sign.signed.version,
    changeNote: "Smoke test amendment reason",
    title: "Smoke test note v2",
    subjective: "Synthetic subjective (amended)",
    objective: "Synthetic objective",
    assessment: "Synthetic assessment (amended)",
    plan: "Synthetic plan",
    clinicalOccurredAt: new Date().toISOString(),
  },
});
console.log("amend", amend);

const versions = await call(`/entries/${draft.entryId}/versions`);
const observed = versions.versions.map((v) => [v.version, v.status]);
console.log("versions", observed);
if (observed.length < 2 || observed.at(-1)[1] !== "amended") throw new Error("signed amendment history is incomplete");
console.log(JSON.stringify({ ok: true, entryId: draft.entryId, versions: observed }));
