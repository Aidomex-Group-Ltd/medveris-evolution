/**
 * Pure staging gate rules used by scripts/staging-deploy.mjs. Every function returns a list of
 * problems; an empty list is the only passing result. Messages name settings, never secret values.
 */

export const EXPECTED = Object.freeze({
  worker: "medveris-staging",
  database: "medveris_staging",
  runtimeRole: "medveris_runtime",
  jobsRole: "medveris_jobs",
  bucket: "medveris-staging-uploads",
  origin: "https://medveris-staging.aidomexgroupltd.workers.dev",
});

export const REQUIRED_SECRETS = Object.freeze(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);

/** Credentials the PACS needs once FEATURE_DICOMWEB is on; the subset depends on DICOMWEB_AUTH. */
export const DICOMWEB_SECRETS = Object.freeze(["DICOMWEB_USERNAME", "DICOMWEB_PASSWORD", "DICOMWEB_BEARER_TOKEN"]);

/** @param {Record<string, unknown>} vars staging vars */
function dicomwebRequiredSecrets(vars) {
  if (vars?.FEATURE_DICOMWEB !== "true") return [];
  return vars.DICOMWEB_AUTH === "bearer" ? ["DICOMWEB_BEARER_TOKEN"] : ["DICOMWEB_USERNAME", "DICOMWEB_PASSWORD"];
}

export const REQUIRED_VARS = Object.freeze({
  APP_ENV: "staging",
  APP_ORIGIN: EXPECTED.origin,
  EXPECTED_DATABASE_NAME: EXPECTED.database,
  STORAGE_ADAPTER: "r2",
  TERMINOLOGY_MODE: "synthetic",
  DEV_SHOW_TOTP_SECRETS: "false",
  FHIR_EXTERNAL_WRITES_ENABLED: "false",
  FHIR_BULK_EXPORT_ENABLED: "false",
});

const HYPERDRIVE_ROLES = Object.freeze({ HYPERDRIVE: EXPECTED.runtimeRole, HYPERDRIVE_JOBS: EXPECTED.jobsRole });

/**
 * Secrets the staging Worker needs: the core keys, plus RESEND_API_KEY when email goes through Resend.
 * @param {any} staging env.staging from wrangler.jsonc
 * @returns {string[]}
 */
export function requiredSecrets(staging) {
  const vars = staging?.vars ?? {};
  return [
    ...REQUIRED_SECRETS,
    ...(vars.EMAIL_ADAPTER === "resend" ? ["RESEND_API_KEY"] : []),
    ...dicomwebRequiredSecrets(vars),
  ];
}
const SECRET_LIKE_VAR = /(SECRET|PASSWORD|TOKEN|_KEY|CONNECTION_STRING|DATABASE_URL)$/;
const PRODUCTION_REFERENCE = /(^|[^a-z])prod(uction)?([^a-z]|$)/i;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const MIN_SECRET_LENGTH = 24;

/** @param {string} text */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** @param {string} text */
export function parseWranglerConfig(text) {
  return JSON.parse(stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Wrangler prints a banner before JSON output on some commands.
 * @param {string} stdout
 * @returns {unknown}
 */
export function parseJsonOutput(stdout) {
  const start = stdout.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

/**
 * Checks the staging environment as Wrangler will resolve it: bindings and vars are not inherited
 * from the top level, so only env.staging (plus inheritable top-level keys) is effective.
 * @param {any} config parsed wrangler.jsonc
 * @returns {string[]}
 */
export function checkStagingConfig(config) {
  const problems = [];
  const check = (/** @type {unknown} */ condition, /** @type {string} */ message) => {
    if (!condition) problems.push(message);
  };
  const staging = config?.env?.staging;
  if (!staging) return ["env.staging is missing"];

  check(staging.name === EXPECTED.worker, `env.staging.name must be ${EXPECTED.worker}`);
  check(staging.workers_dev === true, "env.staging.workers_dev must be true to serve the staging workers.dev origin");
  check(!staging.routes && !staging.route, "env.staging must not declare routes; staging is served only from workers.dev");
  check((config.compatibility_flags ?? []).includes("nodejs_compat") || (staging.compatibility_flags ?? []).includes("nodejs_compat"),
    "nodejs_compat is required for the PostgreSQL driver");

  const bindings = staging.hyperdrive ?? [];
  const ids = Object.fromEntries(bindings.map((/** @type {any} */ binding) => [binding.binding, binding.id]));
  const topLevelIds = new Set((config.hyperdrive ?? []).map((/** @type {any} */ binding) => binding.id));
  check(bindings.filter((/** @type {any} */ b) => b.binding !== "HYPERDRIVE_REPLICA").length === 2 && Object.keys(HYPERDRIVE_ROLES).every((name) => name in ids),
    "env.staging.hyperdrive must declare HYPERDRIVE and HYPERDRIVE_JOBS (plus an optional HYPERDRIVE_REPLICA)");
  for (const name of Object.keys(HYPERDRIVE_ROLES)) {
    const id = ids[name];
    check(/^[0-9a-f]{32}$/.test(id ?? ""), `${name} needs a real 32-character Hyperdrive ID (found ${id ?? "none"})`);
    check(!topLevelIds.has(id), `${name} must not reuse the local-only Hyperdrive ID`);
  }
  check(!ids.HYPERDRIVE || ids.HYPERDRIVE !== ids.HYPERDRIVE_JOBS, "HYPERDRIVE and HYPERDRIVE_JOBS must be different configs (different roles)");

  const buckets = staging.r2_buckets ?? [];
  const uploads = buckets.find((/** @type {any} */ binding) => binding.binding === "UPLOADS");
  check(uploads?.bucket_name === EXPECTED.bucket, `UPLOADS must bind ${EXPECTED.bucket}`);
  check(!uploads?.preview_bucket_name || uploads.preview_bucket_name === EXPECTED.bucket, "UPLOADS preview_bucket_name must not point at another bucket");
  check(!uploads?.jurisdiction, "UPLOADS must not set a jurisdiction the staging bucket was not created in");
  for (const binding of buckets) {
    check(String(binding.bucket_name ?? "").startsWith("medveris-staging"), `R2 binding ${binding.binding} must use a medveris-staging bucket`);
  }

  const vars = staging.vars ?? {};
  for (const [name, value] of Object.entries(REQUIRED_VARS)) {
    check(vars[name] === value, `${name} must be ${value}`);
  }
  for (const name of Object.keys(vars)) {
    check(!REQUIRED_SECRETS.includes(name) && !SECRET_LIKE_VAR.test(name), `${name} looks like a secret and must not be a plaintext var`);
  }
  check(["local", "resend"].includes(vars.EMAIL_ADAPTER), "EMAIL_ADAPTER must be local (no delivery) or resend");
  if (vars.EMAIL_ADAPTER === "resend") {
    const sender = /<?([^<>\s]+@([^<>\s]+))>?\s*$/.exec(String(vars.EMAIL_FROM ?? ""));
    check(sender && !sender[2].endsWith(".local"), "EMAIL_FROM must use a verified Resend sending domain when EMAIL_ADAPTER is resend");
  }
  const required = staging.secrets?.required ?? [];
  for (const name of requiredSecrets(staging)) check(required.includes(name), `${name} must be listed in env.staging.secrets.required`);
  for (const name of required) check(!(name in vars), `${name} is a required secret and must not also be a plaintext var`);

  check(["false", "true"].includes(String(vars.FEATURE_DICOMWEB ?? "false")), "FEATURE_DICOMWEB must be true or false");
  if (vars.FEATURE_DICOMWEB === "true") {
    const baseUrl = String(vars.DICOMWEB_BASE_URL ?? "").trim();
    let parsed = null;
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = null;
    }
    check(parsed !== null && parsed.protocol === "https:", "FEATURE_DICOMWEB=true requires DICOMWEB_BASE_URL with an HTTPS DICOMweb root");
    check(!parsed || (!parsed.username && !parsed.password), "DICOMWEB_BASE_URL must not embed credentials; use DICOMWEB_USERNAME and DICOMWEB_PASSWORD");
    check(!parsed || (!parsed.search && !parsed.hash), "DICOMWEB_BASE_URL must not contain a query or fragment");
    check(["basic", "bearer"].includes(String(vars.DICOMWEB_AUTH ?? "")), "FEATURE_DICOMWEB=true requires DICOMWEB_AUTH=basic or bearer in staging");
  }

  check((staging.triggers?.crons ?? []).length > 0, "staging cron trigger is missing");
  const serialized = JSON.stringify(staging);
  check(!serialized.includes("REPLACE_WITH"), "staging config still contains REPLACE_WITH placeholders");
  check(!serialized.includes("local-only"), "staging config references a local-only resource");
  check(!PRODUCTION_REFERENCE.test(serialized), "staging config references a production resource or value");
  check(!/migrat/i.test(JSON.stringify([config.build ?? null, staging.build ?? null])), "a Wrangler build command must not run database migrations");
  problems.push(...checkScalingConfig(staging, "medveris-staging"));
  check(staging.vars?.DB_REPLICA_ENABLED !== "true" || (staging.hyperdrive ?? []).some((/** @type {any} */ b) => b.binding === "HYPERDRIVE_REPLICA"),
    "DB_REPLICA_ENABLED needs a HYPERDRIVE_REPLICA binding");
  return problems;
}

/**
 * @param {string} binding HYPERDRIVE or HYPERDRIVE_JOBS
 * @param {any} remote output of `wrangler hyperdrive get`
 * @returns {string[]}
 */
export function checkHyperdriveRemote(binding, remote) {
  const role = HYPERDRIVE_ROLES[/** @type {keyof typeof HYPERDRIVE_ROLES} */ (binding)];
  if (!remote || typeof remote !== "object" || !remote.origin) return [`${binding}: Hyperdrive config could not be read`];
  const problems = [];
  if (remote.caching?.disabled !== true) problems.push(`${binding}: query caching must be disabled`);
  if (remote.origin.database !== EXPECTED.database) problems.push(`${binding}: origin database must be ${EXPECTED.database}`);
  if (remote.origin.user !== role) problems.push(`${binding}: origin user must be ${role}`);
  const host = String(remote.origin.host ?? "");
  if (!host) problems.push(`${binding}: origin host is missing`);
  else if (LOCAL_HOST.test(host)) problems.push(`${binding}: origin host is a local or private address`);
  if (PRODUCTION_REFERENCE.test(host) || PRODUCTION_REFERENCE.test(String(remote.name ?? ""))) {
    problems.push(`${binding}: Hyperdrive config references production`);
  }
  return problems;
}

/**
 * Both bindings must reach the same staging database through different roles.
 * @param {any} runtime
 * @param {any} jobs
 * @returns {string[]}
 */
export function checkHyperdrivePair(runtime, jobs) {
  if (!runtime?.origin || !jobs?.origin) return [];
  const same = ["host", "port", "database"].every((key) => runtime.origin[key] === jobs.origin[key]);
  return same ? [] : ["HYPERDRIVE and HYPERDRIVE_JOBS must target the same staging database host, port and database"];
}

/**
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvFile(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^["']|["']$/g, ""));
  }
  return values;
}

/**
 * @param {Map<string, string>} values staging secrets file
 * @param {Map<string, string>} localValues local .env, used to reject reused development keys
 * @returns {string[]}
 */
export function checkSecretValues(values, localValues, allowed = REQUIRED_SECRETS) {
  const problems = [];
  for (const name of values.keys()) {
    if (!allowed.includes(name)) problems.push(`secrets file contains unexpected key ${name}; only ${allowed.join(", ")} may be uploaded`);
  }
  const reused = new Set(localValues.values());
  for (const name of REQUIRED_SECRETS) {
    const value = values.get(name) ?? "";
    if (!value) problems.push(`secrets file is missing ${name}`);
    else if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    else if (/replace-with|changeme|placeholder/i.test(value) || value.startsWith("test-")) problems.push(`${name} is a placeholder or test value`);
    else if (reused.has(value)) problems.push(`${name} matches a local development value`);
  }
  const present = REQUIRED_SECRETS.map((name) => values.get(name)).filter(Boolean);
  if (new Set(present).size !== present.length) problems.push("staging secrets must be distinct values");
  return problems;
}

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function checkResendKey(value) {
  if (!value) return ["the Resend secrets file is missing RESEND_API_KEY"];
  return /^re_[A-Za-z0-9_]{16,}$/.test(value) ? [] : ["RESEND_API_KEY does not look like a Resend API key"];
}

export const VERSION_HEADER = "x-medveris-version";
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Blue is the version serving all traffic. A split deployment means an earlier release did not finish,
 * so a new release must not start until it is promoted or rolled back.
 * @param {any} status output of `wrangler deployments status --json`
 * @param {string} [env] Wrangler environment, used in messages
 * @returns {{ blue: string | null, problems: string[] }}
 */
export function blueVersion(status, env = "staging") {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  if (versions.length === 1 && versions[0].percentage === 100 && VERSION_ID.test(versions[0].version_id ?? "")) {
    return { blue: versions[0].version_id, problems: [] };
  }
  if (versions.length > 1) {
    return { blue: null, problems: [`the live deployment is split between versions; finish it or run \`npm run deploy:${env}:rollback\` first`] };
  }
  return { blue: null, problems: [`could not determine the version serving 100% of ${env} traffic`] };
}

/**
 * @param {string} stdout output of `wrangler versions upload`
 * @returns {string | null}
 */
export function uploadedVersionId(stdout) {
  return /Worker Version ID:\s*([0-9a-f-]{36})/i.exec(stdout)?.[1] ?? null;
}

/**
 * @param {string} worker
 * @param {string} versionId
 */
export function versionOverrideHeader(worker, versionId) {
  return `${worker}="${versionId}"`;
}

/**
 * Rollback target: during an unfinished release, the version still taking traffic (blue); otherwise the
 * most recent version that served 100% before the live one.
 * @param {any} status `wrangler deployments status --json`
 * @param {any[]} deployments `wrangler deployments list --json`, oldest first
 * @returns {{ target: string | null, current: string | null, problems: string[] }}
 */
export function rollbackTarget(status, deployments) {
  const live = Array.isArray(status?.versions) ? status.versions : [];
  if (live.length > 1) {
    const serving = [...live].sort((a, b) => b.percentage - a.percentage)[0];
    return { target: serving.version_id, current: null, problems: [] };
  }
  const current = live[0]?.version_id ?? null;
  if (!current) return { target: null, current: null, problems: ["could not read the live deployment"] };
  for (const deployment of [...(deployments ?? [])].reverse()) {
    const versions = deployment?.versions ?? [];
    if (versions.length === 1 && versions[0].percentage === 100 && versions[0].version_id !== current) {
      return { target: versions[0].version_id, current, problems: [] };
    }
  }
  return { target: null, current, problems: ["no earlier fully deployed version exists to roll back to"] };
}

/**
 * Chooses which secrets to upload. Only names the Worker lacks are ever uploaded, so existing values,
 * including the data-bound AUDIT_SIGNING_KEY and MFA_ENCRYPTION_KEY, are never overwritten.
 * @param {{ remoteNames: string[] | null, availableNames: string[], required: string[] }} input
 *   remoteNames is null when the Worker does not exist yet.
 * @returns {{ upload: string[], problems: string[], notes: string[] }}
 */
export function planSecretUpload({ remoteNames, availableNames, required }) {
  const existing = new Set(remoteNames ?? []);
  const missing = required.filter((name) => !existing.has(name));
  if (!missing.length) {
    return { upload: [], problems: [], notes: ["all required secrets are already configured on the Worker; no secrets will be uploaded"] };
  }
  const absent = missing.filter((name) => !availableNames.includes(name));
  if (absent.length) {
    return { upload: [], problems: [`required secrets are not configured on the Worker and no local file provides them: ${absent.join(", ")}`], notes: [] };
  }
  const notes = remoteNames === null ? ["new Worker: secrets will be uploaded with the first deployment"] : [`uploading missing secrets only: ${missing.join(", ")}`];
  return { upload: missing, problems: [], notes };
}

export const DURABLE_OBJECTS = Object.freeze({ RATE_LIMITER: "RateLimiterObject", REALTIME: "RealtimeHub" });

/**
 * Durable Object and queue bindings for one environment. Queue names must carry the
 * environment prefix so staging can never consume production jobs (or the reverse), the
 * consumer must dead-letter, and concurrency and retries must be bounded.
 * @param {any} envConfig env.staging or env.production
 * @param {string} prefix e.g. medveris-staging
 * @returns {string[]}
 */
export function checkScalingConfig(envConfig, prefix) {
  const problems = [];
  const check = (/** @type {unknown} */ condition, /** @type {string} */ message) => {
    if (!condition) problems.push(message);
  };
  const objects = envConfig?.durable_objects?.bindings ?? [];
  for (const [name, className] of Object.entries(DURABLE_OBJECTS)) {
    const binding = objects.find((/** @type {any} */ item) => item.name === name);
    check(binding?.class_name === className, `durable_objects must bind ${name} to ${className}`);
    check(!binding?.script_name, `${name} must use this Worker's own class, not another script`);
  }
  const migrated = (envConfig?.migrations ?? []).flatMap((/** @type {any} */ migration) => [...(migration.new_sqlite_classes ?? []), ...(migration.new_classes ?? [])]);
  for (const className of Object.values(DURABLE_OBJECTS)) {
    check(migrated.includes(className), `migrations must create ${className}`);
  }
  check(!(envConfig?.migrations ?? []).some((/** @type {any} */ migration) => (migration.new_classes ?? []).length),
    "Durable Object classes must be SQLite-backed (new_sqlite_classes), which the Free plan supports");

  const producers = envConfig?.queues?.producers ?? [];
  const consumers = envConfig?.queues?.consumers ?? [];
  const jobs = `${prefix}-jobs`;
  const dlq = `${prefix}-jobs-dlq`;
  check(producers.find((/** @type {any} */ p) => p.binding === "JOBS_QUEUE")?.queue === jobs, `JOBS_QUEUE must produce to ${jobs}`);
  check(producers.find((/** @type {any} */ p) => p.binding === "JOBS_DLQ")?.queue === dlq, `JOBS_DLQ must produce to ${dlq}`);
  const main = consumers.find((/** @type {any} */ c) => c.queue === jobs);
  check(main, `this Worker must consume ${jobs}`);
  check(main?.dead_letter_queue === dlq, `${jobs} must dead-letter to ${dlq}`);
  check(Number.isInteger(main?.max_retries) && main.max_retries >= 1 && main.max_retries <= 20, `${jobs} needs bounded max_retries`);
  check(Number.isInteger(main?.max_concurrency) && main.max_concurrency >= 1 && main.max_concurrency <= 10, `${jobs} needs bounded max_concurrency`);
  check(consumers.some((/** @type {any} */ c) => c.queue === dlq), `this Worker must consume ${dlq} to record dead letters`);
  for (const queue of [...producers.map((/** @type {any} */ p) => p.queue), ...consumers.map((/** @type {any} */ c) => c.queue)]) {
    check(String(queue).startsWith(`${prefix}-`), `queue ${queue} must belong to ${prefix}`);
  }
  return problems;
}

/** Queue names the environment needs to exist remotely before deployment. */
export function requiredQueues(envConfig) {
  const names = new Set();
  for (const producer of envConfig?.queues?.producers ?? []) names.add(producer.queue);
  for (const consumer of envConfig?.queues?.consumers ?? []) {
    names.add(consumer.queue);
    if (consumer.dead_letter_queue) names.add(consumer.dead_letter_queue);
  }
  return [...names];
}

/**
 * Gradual releases (`wrangler versions upload`) cannot apply Durable Object migrations, so a
 * release whose newest migration tag is not yet applied must go out with `wrangler deploy`.
 * @param {any} envConfig
 * @param {string | null | undefined} remoteTag migration_tag of the deployed script, if any
 * @returns {string | null} the tag that still has to be applied
 */
export function pendingMigrationTag(envConfig, remoteTag) {
  const tags = (envConfig?.migrations ?? []).map((/** @type {any} */ migration) => migration.tag);
  const latest = tags[tags.length - 1] ?? null;
  if (!latest || latest === remoteTag) return null;
  return latest;
}
