import { createHash } from "node:crypto";
import { checkScalingConfig } from "./staging-gate.mjs";

/**
 * Pure production gate rules used by scripts/production-deploy.mjs and scripts/production-domain.mjs.
 * Every check returns a list of problems (or a failure string for smoke checks); an empty result is the
 * only passing one. Messages name settings and resources, never secret values.
 */

export const PRODUCTION = Object.freeze({
  env: "production",
  worker: "medveris-production",
  database: "medveris_production",
  runtimeRole: "medveris_runtime",
  jobsRole: "medveris_jobs",
  bucket: "medveris-production-uploads",
  origin: "https://medveris.online",
  workersDevOrigin: "https://medveris-production.aidomexgroupltd.workers.dev",
  apex: "medveris.online",
  domains: Object.freeze(["medveris.online", "www.medveris.online"]),
});

export const PRODUCTION_SECRETS = Object.freeze(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY", "RESEND_API_KEY"]);

const REQUIRED_VARS = Object.freeze({
  APP_ENV: "production",
  APP_ORIGIN: PRODUCTION.origin,
  EXPECTED_DATABASE_NAME: PRODUCTION.database,
  STORAGE_ADAPTER: "r2",
  EMAIL_ADAPTER: "resend",
  DEV_SHOW_TOTP_SECRETS: "false",
  FHIR_EXTERNAL_WRITES_ENABLED: "false",
  FHIR_BULK_EXPORT_ENABLED: "false",
});

/** Flags that request an external integration; none has an implemented, verified adapter yet. */
const INTEGRATION_FLAGS = Object.freeze([
  "FEATURE_DICOMWEB", "FEATURE_LAB", "FEATURE_PHARMACY", "FEATURE_TELEMEDICINE", "FEATURE_DEVICES",
  "FEATURE_AI", "FEATURE_PAYMENTS", "FEATURE_PUBLIC_HEALTH", "FEATURE_LEDGER_ANCHORING",
]);

const HYPERDRIVE_ROLES = Object.freeze({ HYPERDRIVE: PRODUCTION.runtimeRole, HYPERDRIVE_JOBS: PRODUCTION.jobsRole });
const SECRET_LIKE_VAR = /(SECRET|PASSWORD|TOKEN|_KEY|CONNECTION_STRING|DATABASE_URL)$/;
const NON_PRODUCTION_REFERENCE = /staging|local-only|localhost|synthetic|\.local\b|example\.(com|net|org)/i;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const VERIFIED_TLS = new Set(["verify-ca", "verify-full"]);
const RESTORE_DRILL_MAX_AGE_DAYS = 90;

/**
 * Hostnames declared as custom domains in env.production.routes.
 * @param {any} production env.production from wrangler.jsonc
 * @returns {string[]}
 */
export function declaredDomains(production) {
  return (production?.routes ?? [])
    .filter((/** @type {any} */ route) => route?.custom_domain === true)
    .map((/** @type {any} */ route) => String(route.pattern));
}

/**
 * Checks env.production as Wrangler resolves it: bindings and vars are not inherited from the top level.
 * @param {any} config parsed wrangler.jsonc
 * @returns {string[]}
 */
export function checkProductionConfig(config) {
  const problems = [];
  const check = (/** @type {unknown} */ condition, /** @type {string} */ message) => {
    if (!condition) problems.push(message);
  };
  const production = config?.env?.production;
  if (!production) return ["env.production is missing"];

  check(production.name === PRODUCTION.worker, `env.production.name must be ${PRODUCTION.worker}`);
  check(production.preview_urls === false, "env.production.preview_urls must be false");
  check((config.compatibility_flags ?? []).includes("nodejs_compat") || (production.compatibility_flags ?? []).includes("nodejs_compat"),
    "nodejs_compat is required for the PostgreSQL driver");
  check(config.assets?.directory || production.assets?.directory, "the built web assets must be bound");

  const bindings = production.hyperdrive ?? [];
  const ids = Object.fromEntries(bindings.map((/** @type {any} */ binding) => [binding.binding, binding.id]));
  const otherIds = new Set([
    ...(config.hyperdrive ?? []).map((/** @type {any} */ binding) => binding.id),
    ...Object.values(config.env ?? {}).filter((env) => env !== production)
      .flatMap((/** @type {any} */ env) => (env.hyperdrive ?? []).map((/** @type {any} */ binding) => binding.id)),
  ]);
  check(bindings.length === 2 && Object.keys(HYPERDRIVE_ROLES).every((name) => name in ids),
    "env.production.hyperdrive must declare exactly HYPERDRIVE and HYPERDRIVE_JOBS");
  for (const name of Object.keys(HYPERDRIVE_ROLES)) {
    const id = ids[name];
    if (!/^[0-9a-f]{32}$/.test(id ?? "")) problems.push(`${name} needs a real 32-character Hyperdrive ID (found ${id ?? "none"})`);
    else check(!otherIds.has(id), `${name} must not reuse a staging Hyperdrive config`);
  }
  check(!ids.HYPERDRIVE || ids.HYPERDRIVE !== ids.HYPERDRIVE_JOBS, "HYPERDRIVE and HYPERDRIVE_JOBS must be different configs (different roles)");

  const buckets = production.r2_buckets ?? [];
  const uploads = buckets.find((/** @type {any} */ binding) => binding.binding === "UPLOADS");
  check(uploads?.bucket_name === PRODUCTION.bucket, `UPLOADS must bind ${PRODUCTION.bucket}`);
  check(!uploads?.preview_bucket_name || uploads.preview_bucket_name === PRODUCTION.bucket, "UPLOADS preview_bucket_name must not point at another bucket");
  check(buckets.length === 1, "production must bind only the UPLOADS bucket");

  const vars = production.vars ?? {};
  for (const [name, value] of Object.entries(REQUIRED_VARS)) check(vars[name] === value, `${name} must be ${value}`);
  check(/^production-key-\d+$/.test(String(vars.AUDIT_SIGNING_KEY_ID ?? "")), "AUDIT_SIGNING_KEY_ID must be a production key id (production-key-<n>)");
  const terminologyOk = vars.TERMINOLOGY_MODE === "unavailable" || (vars.TERMINOLOGY_MODE === "production" && /^https:\/\//.test(String(vars.TERMINOLOGY_PROVIDER_URL ?? "")));
  check(terminologyOk, "TERMINOLOGY_MODE must be unavailable or production (with a provider URL)");
  for (const flag of INTEGRATION_FLAGS) {
    check(vars[flag] === "false", `${flag} must be false until its adapter is implemented and verified`);
  }
  const sender = /<?([^<>\s]+@([^<>\s]+))>?\s*$/.exec(String(vars.EMAIL_FROM ?? ""));
  check(sender?.[2] === PRODUCTION.apex, `EMAIL_FROM must send from the verified ${PRODUCTION.apex} domain`);
  for (const name of Object.keys(vars)) {
    check(!PRODUCTION_SECRETS.includes(name) && !SECRET_LIKE_VAR.test(name), `${name} looks like a secret and must not be a plaintext var`);
  }
  const required = production.secrets?.required ?? [];
  for (const name of PRODUCTION_SECRETS) check(required.includes(name), `${name} must be listed in env.production.secrets.required`);

  check((production.triggers?.crons ?? []).length > 0, "production cron trigger is missing");
  check(production.version_metadata?.binding === "CF_VERSION_METADATA", "env.production.version_metadata must bind CF_VERSION_METADATA");
  const observability = production.observability ?? config.observability;
  check(observability?.enabled === true && observability?.redact_query_string === true, "production observability must be enabled with query strings redacted");

  const routes = production.routes ?? (production.route ? [production.route] : []);
  check(routes.every((/** @type {any} */ route) => route?.custom_domain === true && PRODUCTION.domains.includes(route.pattern)),
    "production routes must be custom domains for medveris.online or www.medveris.online");

  const serialized = JSON.stringify(production);
  check(!serialized.includes("REPLACE_WITH"), "production config still contains REPLACE_WITH placeholders");
  check(!NON_PRODUCTION_REFERENCE.test(serialized.replaceAll("REPLACE_WITH", "")), "production config references a staging, local or synthetic resource");
  check(!/migrat/i.test(JSON.stringify([config.build ?? null, production.build ?? null])), "a Wrangler build command must not run database migrations");
  problems.push(...checkScalingConfig(production, "medveris-production"));
  check(vars.REALTIME_ENABLED !== "true", "REALTIME_ENABLED must stay false in production until staging WebSocket and failover verification is signed off");
  check(vars.DB_REPLICA_ENABLED !== "true", "DB_REPLICA_ENABLED must stay false until a provider read replica is provisioned and its failover tested");
  return problems;
}

/**
 * @param {string} binding HYPERDRIVE or HYPERDRIVE_JOBS
 * @param {any} remote output of `wrangler hyperdrive get`
 * @returns {string[]}
 */
export function checkProductionHyperdrive(binding, remote) {
  const role = HYPERDRIVE_ROLES[/** @type {keyof typeof HYPERDRIVE_ROLES} */ (binding)];
  if (!remote || typeof remote !== "object" || !remote.origin) return [`${binding}: Hyperdrive config could not be read`];
  const problems = [];
  if (remote.caching?.disabled !== true) problems.push(`${binding}: query caching must be disabled`);
  if (remote.origin.database !== PRODUCTION.database) problems.push(`${binding}: origin database must be ${PRODUCTION.database}`);
  if (remote.origin.user !== role) problems.push(`${binding}: origin user must be ${role}`);
  if (!VERIFIED_TLS.has(remote.mtls?.sslmode)) problems.push(`${binding}: TLS must verify the server certificate (sslmode verify-ca or verify-full)`);
  const host = String(remote.origin.host ?? "");
  if (!host) problems.push(`${binding}: origin host is missing`);
  else if (LOCAL_HOST.test(host)) problems.push(`${binding}: origin host is a local or private address`);
  if ([host, remote.name, remote.origin.database].some((value) => /staging/i.test(String(value ?? "")))) {
    problems.push(`${binding}: Hyperdrive config references staging`);
  }
  return problems;
}

/**
 * Production must run on its own PostgreSQL server: roles are server-wide, so sharing the staging server
 * would share the staging login roles and their passwords.
 * @param {{ runtime: any, jobs: any }} production remote production Hyperdrive configs
 * @param {any[]} staging remote staging Hyperdrive configs
 * @returns {string[]}
 */
export function checkProductionIsolation(production, staging) {
  const problems = [];
  const { runtime, jobs } = production;
  if (runtime?.origin && jobs?.origin && !["host", "port", "database"].every((key) => runtime.origin[key] === jobs.origin[key])) {
    problems.push("HYPERDRIVE and HYPERDRIVE_JOBS must target the same production host, port and database");
  }
  const server = (/** @type {any} */ remote) => `${String(remote?.origin?.host ?? "").toLowerCase()}:${remote?.origin?.port ?? ""}`;
  const stagingServers = new Set(staging.filter((remote) => remote?.origin?.host).map(server));
  for (const shared of new Set([runtime, jobs].filter((remote) => remote?.origin?.host).map(server))) {
    if (stagingServers.has(shared)) problems.push(`production Hyperdrive targets the staging PostgreSQL server ${shared}; production needs its own server`);
  }
  return problems;
}

/**
 * The domain is attached by `npm run domain:production` after verification, then declared in wrangler.jsonc
 * so later releases keep it. A deploy must never be the step that attaches it.
 * @param {{ declared: string[], attached: string[], workersDev: boolean }} state
 * @returns {string[]}
 */
export function checkDomainState({ declared, attached, workersDev }) {
  const problems = [];
  for (const domain of declared) {
    if (!attached.includes(domain)) problems.push(`${domain} is declared in wrangler.jsonc but not attached; run npm run domain:production after verification`);
  }
  for (const domain of attached) {
    if (!declared.includes(domain)) problems.push(`${domain} is attached but not declared in env.production.routes as a custom domain`);
  }
  if (!workersDev && !(declared.includes(PRODUCTION.apex) && attached.includes(PRODUCTION.apex))) {
    problems.push("workers_dev may only be disabled after medveris.online is attached and declared");
  }
  return problems;
}

/**
 * @param {{ declared: string[], attached: string[] }} state
 * @returns {string}
 */
export function verificationOrigin({ declared, attached }) {
  return declared.includes(PRODUCTION.apex) && attached.includes(PRODUCTION.apex) ? PRODUCTION.origin : PRODUCTION.workersDevOrigin;
}

/**
 * @param {{ files: { version: string }[], applied: string[] | null }} state
 * @returns {string[]}
 */
export function checkMigrationState({ files, applied }) {
  if (!applied) return ["production migration state could not be read"];
  const problems = [];
  const known = new Set(files.map((file) => file.version));
  const pending = files.map((file) => file.version).filter((version) => !applied.includes(version));
  const unknown = applied.filter((version) => !known.has(version));
  if (pending.length) problems.push(`${pending.length} migration(s) not applied to production: ${pending.join(", ")}; apply them with the reviewed migration procedure first`);
  if (unknown.length) problems.push(`production has migrations this release does not contain: ${unknown.join(", ")}`);
  return problems;
}

/**
 * @param {{ version: string, body: string }[]} files
 * @returns {string}
 */
export function migrationSetDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.version}\n${file.body}\n`);
  return hash.digest("hex");
}

/**
 * Backup and restore cannot be read from every provider's API, so the operator who ran the restore drill
 * records it; the gate refuses to release without a recent one.
 * @param {any} attestation parsed backup-verification.json
 * @param {Date} now
 * @returns {string[]}
 */
export function checkBackupAttestation(attestation, now) {
  if (!attestation || typeof attestation !== "object") {
    return ["no backup and restore verification is recorded in ~/.config/medveris/production/backup-verification.json"];
  }
  const problems = [];
  if (!attestation.provider) problems.push("backup verification must name the database provider");
  if (attestation.pointInTimeRecovery !== true) problems.push("point-in-time recovery must be enabled on the production database");
  if (attestation.encryptedBackups !== true) problems.push("encrypted backups must be enabled on the production database");
  if (!attestation.restoreDrillBy) problems.push("backup verification must name who ran the restore drill");
  const drill = Date.parse(attestation.restoreDrillAt ?? "");
  if (!Number.isFinite(drill)) problems.push("backup verification must record when the restore drill ran");
  else if (now.getTime() - drill > RESTORE_DRILL_MAX_AGE_DAYS * 86_400_000) problems.push(`the last restore drill is older than ${RESTORE_DRILL_MAX_AGE_DAYS} days`);
  return problems;
}

function json(/** @type {string} */ body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Safe production smoke checks: they read public state and unauthenticated responses only.
 * @param {{ config: { status: number, body: string }, me: { status: number, body: string }, missing: { status: number, body: string } }} responses
 * @returns {string | null} the first failure, or null
 */
export function checkSmokeResponses({ config, me, missing }) {
  const publicConfig = json(config.body);
  if (config.status !== 200 || !publicConfig) return `public config answered ${config.status}`;
  if (publicConfig.appEnv !== "production") return `public config reports appEnv=${publicConfig.appEnv}`;
  if (publicConfig.terminology?.synthetic !== false) return "synthetic terminology is active";
  const available = Object.entries(publicConfig.features ?? {}).find(([, on]) => on === true);
  if (available) return `integration ${available[0]} reports available`;
  if (me.status !== 401 || json(me.body)?.error?.code !== "unauthenticated") return `protected route /api/v1/me answered ${me.status} without a session`;
  if (missing.status !== 404 || json(missing.body)?.error?.code !== "not_found") return `unknown API route answered ${missing.status} instead of a JSON 404`;
  return null;
}
