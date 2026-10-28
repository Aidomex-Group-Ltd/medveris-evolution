import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "./staging-gate.mjs";
import { PRODUCTION_SECRETS } from "./production-gate.mjs";

/**
 * Production secret provisioning rules. I/O with providers is injected (`deps`) so the rules are unit-tested;
 * only names are ever reported, never values.
 *
 * deps.listRemoteSecrets() -> { status: "ok", names } | { status: "absent" } | { status: "error", detail }
 * deps.checkDatabase()     -> { status: "checked", dependents } | { status: "absent" } | { status: "unreachable" }
 * deps.runOpenssl(args)    -> { status, stdout }
 * deps.uploadSecrets(map)  -> { ok, detail? }
 * deps.forbiddenValues     -> Set of staging and local development values production must not reuse
 */

/** Secrets that are safe to create locally with OpenSSL. */
export const GENERATED_SECRETS = Object.freeze(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);
/** Keys that stored data depends on: signed integrity checkpoints and encrypted TOTP secrets. */
export const DATA_BOUND_SECRETS = Object.freeze(["AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);
/** Credentials issued by a provider; never generated. */
export const EXTERNAL_SECRETS = Object.freeze({
  RESEND_API_KEY: "create a production-only Resend API key with sending access restricted to medveris.online in the Resend dashboard, "
    + "then save it as RESEND_API_KEY=re_... in ~/.config/medveris/production/resend.env (mode 0600)",
});

const MIN_LENGTH = 32;
const PLACEHOLDER = /replace-with|changeme|placeholder|dummy|example/i;

/**
 * @param {(args: string[]) => { status: number | null, stdout: string }} runOpenssl
 * @returns {string} 32 random bytes as 64 lowercase hex characters
 */
export function generateHexSecret(runOpenssl) {
  const result = runOpenssl(["rand", "-hex", "32"]);
  const value = String(result?.stdout ?? "").trim();
  if (result?.status !== 0 || !/^[0-9a-f]{64}$/.test(value)) throw new Error("openssl rand failed or returned an unexpected value");
  return value;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {Set<string>} forbiddenValues
 * @returns {string[]} at most one problem, naming the secret but never its value
 */
export function secretFormatProblems(name, value, forbiddenValues) {
  if (name === "RESEND_API_KEY") {
    if (!/^re_[A-Za-z0-9_]{16,}$/.test(value)) return ["RESEND_API_KEY does not look like a Resend API key"];
  } else if (value.length < MIN_LENGTH || /\s/.test(value)) {
    return [`${name} must be at least ${MIN_LENGTH} characters without whitespace`];
  }
  if (PLACEHOLDER.test(value) || /^(test|ci)-/.test(value)) return [`${name} is a placeholder or test value`];
  if (forbiddenValues.has(value)) return [`${name} matches a staging or local development value`];
  return [];
}

/**
 * Data-bound keys may be created only for a fresh installation: no stored data may depend on earlier keys.
 * @param {{ remote: any, database: any, confirmFresh: boolean }} input
 * @returns {{ established: boolean, reason: string }}
 */
export function assessFreshInstallation({ remote, database, confirmFresh }) {
  if (remote.status === "error") return { established: false, reason: "the production Worker secrets could not be listed" };
  if (database.status === "checked") {
    return database.dependents.length
      ? { established: false, reason: `stored data depends on existing keys: ${database.dependents.join("; ")}` }
      : { established: true, reason: "the production database holds no encrypted MFA secrets or signed checkpoints" };
  }
  if (database.status === "unreachable") return { established: false, reason: "the production database could not be checked for data that depends on existing keys" };
  if (remote.status !== "absent") {
    return { established: false, reason: "the production Worker exists, so a database check must prove that no data depends on existing keys" };
  }
  return confirmFresh
    ? { established: true, reason: "no production Worker or database exists (fresh installation confirmed by the operator)" }
    : { established: false, reason: "no production database is configured to prove that no data depends on existing keys; pass --confirm-fresh-installation only for a brand-new installation" };
}

/**
 * @param {{ required: string[], local: Map<string, string>, remote: any, fresh: { established: boolean, reason: string }, forbiddenValues: Set<string> }} input
 * @returns {{ generate: string[], reuse: string[], upload: string[], blocked: { name: string, reason: string }[] }}
 */
export function planSecrets({ required, local, remote, fresh, forbiddenValues }) {
  const plan = { generate: /** @type {string[]} */ ([]), reuse: /** @type {string[]} */ ([]), upload: /** @type {string[]} */ ([]), blocked: /** @type {{ name: string, reason: string }[]} */ ([]) };
  const remoteNames = remote.status === "ok" ? remote.names : [];
  for (const name of required) {
    if (remoteNames.includes(name)) {
      plan.reuse.push(name);
    } else if (local.has(name)) {
      const problems = secretFormatProblems(name, local.get(name) ?? "", forbiddenValues);
      if (problems.length) {
        plan.blocked.push({ name, reason: `${problems[0]}; fix the local file by hand` });
      } else {
        plan.reuse.push(name);
        plan.upload.push(name);
      }
    } else if (name in EXTERNAL_SECRETS) {
      plan.blocked.push({ name, reason: `${name} is missing: ${EXTERNAL_SECRETS[/** @type {keyof typeof EXTERNAL_SECRETS} */ (name)]}` });
    } else if (!GENERATED_SECRETS.includes(name)) {
      plan.blocked.push({ name, reason: `${name} is missing and has no supported provisioning action` });
    } else if (DATA_BOUND_SECRETS.includes(name) && !fresh.established) {
      plan.blocked.push({ name, reason: `${name} is data-bound and ${fresh.reason}; use a reviewed key initialization or rotation procedure` });
    } else {
      plan.generate.push(name);
      plan.upload.push(name);
    }
  }
  return plan;
}

/**
 * @param {string} path
 * @param {boolean} apply tighten permissions instead of reporting them
 * @param {{ problems: string[], notes: string[] }} report
 * @returns {Map<string, string>}
 */
function readProtected(path, apply, report) {
  if (!existsSync(path)) return new Map();
  const name = path.split("/").pop();
  if ((statSync(path).mode & 0o077) !== 0) {
    if (apply) {
      chmodSync(path, 0o600);
      report.notes.push(`${name} permissions were tightened to 0600`);
    } else {
      report.problems.push(`${name} must be mode 0600`);
    }
  }
  return parseEnvFile(readFileSync(path, "utf8"));
}

/** Appends new entries without touching existing lines; the file is replaced atomically with mode 0600. */
function appendSecrets(path, entries) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const text = `${existing.replace(/\n?$/, existing ? "\n" : "")}${entries.map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  chmodSync(path, 0o600);
}

/**
 * @param {{ dir: string, apply: boolean, confirmFresh: boolean, deps: any }} input
 */
export async function provisionProductionSecrets({ dir, apply, confirmFresh, deps }) {
  const report = {
    generated: /** @type {string[]} */ ([]),
    wouldGenerate: /** @type {string[]} */ ([]),
    reused: /** @type {string[]} */ ([]),
    uploaded: /** @type {string[]} */ ([]),
    deferred: /** @type {string[]} */ ([]),
    blocked: /** @type {{ name: string, reason: string }[]} */ ([]),
    problems: /** @type {string[]} */ ([]),
    notes: /** @type {string[]} */ ([]),
    freshInstallation: /** @type {{ established: boolean, reason: string } | null} */ (null),
  };
  const remote = deps.listRemoteSecrets();
  if (remote.status === "error") {
    report.problems.push(`could not list the production Worker secrets (${remote.detail}); nothing was generated or uploaded`);
    return report;
  }
  if (existsSync(dir) && (statSync(dir).mode & 0o077) !== 0) {
    if (apply) {
      chmodSync(dir, 0o700);
      report.notes.push("secret directory permissions were tightened to 0700");
    } else {
      report.problems.push("the secret directory must be mode 0700");
    }
  }
  const secretsFile = join(dir, "secrets.env");
  const local = new Map([
    ...[...readProtected(secretsFile, apply, report)].filter(([name]) => GENERATED_SECRETS.includes(name)),
    ...[...readProtected(join(dir, "resend.env"), apply, report)].filter(([name]) => name === "RESEND_API_KEY"),
  ]);
  const database = await deps.checkDatabase();
  const fresh = assessFreshInstallation({ remote, database, confirmFresh });
  report.freshInstallation = fresh;
  const plan = planSecrets({ required: [...PRODUCTION_SECRETS], local, remote, fresh, forbiddenValues: deps.forbiddenValues });
  report.reused = plan.reuse;
  report.blocked = plan.blocked;
  if (!apply) {
    report.wouldGenerate = plan.generate;
    return report;
  }

  if (plan.generate.length) {
    /** @type {[string, string][]} */
    let entries;
    try {
      entries = plan.generate.map((name) => [name, generateHexSecret(deps.runOpenssl)]);
    } catch (error) {
      report.problems.push(`${/** @type {Error} */ (error).message}; nothing was written`);
      return report;
    }
    const all = [...local.values(), ...entries.map(([, value]) => value)];
    if (new Set(all).size !== all.length) {
      report.problems.push("generated secrets are not distinct; nothing was written");
      return report;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    appendSecrets(secretsFile, entries);
    for (const [name, value] of entries) local.set(name, value);
    report.generated = plan.generate;
  }

  if (!plan.upload.length) return report;
  if (remote.status === "absent") {
    report.deferred = plan.upload;
    report.notes.push("the production Worker does not exist yet; npm run deploy:production uploads these secrets with the first deployment");
  } else if (plan.blocked.length) {
    report.problems.push(`upload skipped: ${plan.blocked.map((entry) => entry.name).join(", ")} is blocked`);
  } else {
    const result = deps.uploadSecrets(Object.fromEntries(plan.upload.map((name) => [name, local.get(name)])));
    if (result.ok) report.uploaded = plan.upload;
    else report.problems.push(`wrangler secret bulk failed (${result.detail}); remote secrets are unchanged or partially set, rerun to fill gaps`);
  }
  return report;
}
