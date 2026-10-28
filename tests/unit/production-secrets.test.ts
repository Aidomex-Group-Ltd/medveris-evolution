import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessFreshInstallation,
  generateHexSecret,
  planSecrets,
  provisionProductionSecrets,
  secretFormatProblems,
} from "../../scripts/production-secrets-lib.mjs";

const REQUIRED = ["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY", "RESEND_API_KEY"];
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const RESEND = "re_" + "A".repeat(30);

let dir: string;
let counter: number;

/** Test double for `openssl rand -hex 32`; unit tests only, never deployment evidence. */
function fakeOpenssl() {
  return () => {
    counter += 1;
    return { status: 0, stdout: `${counter.toString(16).padStart(2, "0").repeat(32)}\n` };
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  const uploads: Record<string, string>[] = [];
  return {
    uploads,
    deps: {
      listRemoteSecrets: () => ({ status: "absent" }),
      checkDatabase: async () => ({ status: "absent" }),
      runOpenssl: fakeOpenssl(),
      uploadSecrets: (values: Record<string, string>) => {
        uploads.push(values);
        return { ok: true };
      },
      forbiddenValues: new Set<string>(),
      ...overrides,
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "medveris-prod-secrets-test-"));
  counter = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("OpenSSL secret generation", () => {
  it("returns 32 random bytes as 64 hex characters", () => {
    expect(generateHexSecret(fakeOpenssl())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when OpenSSL fails or returns something unexpected", () => {
    expect(() => generateHexSecret(() => ({ status: 1, stdout: "" }))).toThrow("openssl rand failed");
    expect(() => generateHexSecret(() => ({ status: 0, stdout: "short\n" }))).toThrow("openssl rand failed");
  });
});

describe("secret format validation", () => {
  it("accepts generated and Resend-shaped values", () => {
    expect(secretFormatProblems("SESSION_SECRET", hex("a"), new Set())).toEqual([]);
    expect(secretFormatProblems("RESEND_API_KEY", RESEND, new Set())).toEqual([]);
  });

  it("rejects short, placeholder, test, reused and malformed values without echoing them", () => {
    const reused = hex("b");
    const problems = [
      ...secretFormatProblems("SESSION_SECRET", "too-short", new Set()),
      ...secretFormatProblems("AUDIT_SIGNING_KEY", "replace-with-a-real-key-of-sufficient-length-0000", new Set()),
      ...secretFormatProblems("MFA_ENCRYPTION_KEY", reused, new Set([reused])),
      ...secretFormatProblems("RESEND_API_KEY", "sk_live_123", new Set()),
    ];
    expect(problems).toEqual([
      "SESSION_SECRET must be at least 32 characters without whitespace",
      "AUDIT_SIGNING_KEY is a placeholder or test value",
      "MFA_ENCRYPTION_KEY matches a staging or local development value",
      "RESEND_API_KEY does not look like a Resend API key",
    ]);
    expect(problems.join("\n")).not.toContain(reused);
  });
});

describe("fresh-installation evidence for data-bound keys", () => {
  it("is established by a database check that finds no dependent data", () => {
    expect(assessFreshInstallation({ remote: { status: "absent" }, database: { status: "checked", dependents: [] }, confirmFresh: false }).established).toBe(true);
  });

  it("needs explicit operator confirmation when no production database exists yet", () => {
    expect(assessFreshInstallation({ remote: { status: "absent" }, database: { status: "absent" }, confirmFresh: false }).established).toBe(false);
    expect(assessFreshInstallation({ remote: { status: "absent" }, database: { status: "absent" }, confirmFresh: true }).established).toBe(true);
  });

  it("is never established when data depends on keys or state cannot be read", () => {
    const dependent = assessFreshInstallation({ remote: { status: "absent" }, database: { status: "checked", dependents: ["3 encrypted TOTP secrets"] }, confirmFresh: true });
    expect(dependent).toEqual({ established: false, reason: "stored data depends on existing keys: 3 encrypted TOTP secrets" });
    expect(assessFreshInstallation({ remote: { status: "absent" }, database: { status: "unreachable" }, confirmFresh: true }).established).toBe(false);
    expect(assessFreshInstallation({ remote: { status: "ok", names: [] }, database: { status: "absent" }, confirmFresh: true }).established).toBe(false);
  });
});

describe("secret plan", () => {
  const fresh = { established: true, reason: "test" };
  const notFresh = { established: false, reason: "stored data depends on existing keys" };

  it("generates every eligible secret for a fresh installation but never external credentials", () => {
    const plan = planSecrets({ required: REQUIRED, local: new Map(), remote: { status: "absent" }, fresh, forbiddenValues: new Set() });
    expect(plan.generate).toEqual(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);
    expect(plan.blocked.map((entry: any) => entry.name)).toEqual(["RESEND_API_KEY"]);
  });

  it("refuses to create data-bound keys without fresh-installation evidence", () => {
    const plan = planSecrets({ required: REQUIRED, local: new Map(), remote: { status: "absent" }, fresh: notFresh, forbiddenValues: new Set() });
    expect(plan.generate).toEqual(["SESSION_SECRET"]);
    expect(plan.blocked.find((entry: any) => entry.name === "AUDIT_SIGNING_KEY")?.reason).toContain("reviewed key initialization");
  });

  it("keeps remote secrets and uploads only names the Worker lacks", () => {
    const local = new Map([["SESSION_SECRET", hex("1")], ["AUDIT_SIGNING_KEY", hex("2")], ["MFA_ENCRYPTION_KEY", hex("3")], ["RESEND_API_KEY", RESEND]]);
    const plan = planSecrets({ required: REQUIRED, local, remote: { status: "ok", names: ["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"] }, fresh: notFresh, forbiddenValues: new Set() });
    expect(plan).toMatchObject({ generate: [], upload: ["RESEND_API_KEY"], blocked: [] });
    expect(plan.reuse).toEqual(REQUIRED);
  });

  it("never replaces a malformed local value", () => {
    const plan = planSecrets({ required: REQUIRED, local: new Map([["SESSION_SECRET", "short"]]), remote: { status: "absent" }, fresh, forbiddenValues: new Set() });
    expect(plan.generate).not.toContain("SESSION_SECRET");
    expect(plan.blocked[0]).toEqual({ name: "SESSION_SECRET", reason: "SESSION_SECRET must be at least 32 characters without whitespace; fix the local file by hand" });
  });
});

describe("provisioning", () => {
  it("creates a 0700 directory and 0600 file with generated values and reports only names", async () => {
    const { deps: d } = deps();
    const report = await provisionProductionSecrets({ dir: join(dir, "production"), apply: true, confirmFresh: true, deps: d });
    expect(report.generated).toEqual(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);
    expect(statSync(join(dir, "production")).mode & 0o777).toBe(0o700);
    const file = join(dir, "production", "secrets.env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^SESSION_SECRET=[0-9a-f]{64}$/m);
    expect(JSON.stringify(report)).not.toMatch(/[0-9a-f]{64}/);
    expect(report.blocked.map((entry: any) => entry.name)).toEqual(["RESEND_API_KEY"]);
  });

  it("is idempotent: a second run regenerates nothing", async () => {
    const { deps: d } = deps();
    await provisionProductionSecrets({ dir, apply: true, confirmFresh: true, deps: d });
    const before = readFileSync(join(dir, "secrets.env"), "utf8");
    const second = await provisionProductionSecrets({ dir, apply: true, confirmFresh: true, deps: d });
    expect(second.generated).toEqual([]);
    expect(second.reused).toEqual(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);
    expect(readFileSync(join(dir, "secrets.env"), "utf8")).toBe(before);
  });

  it("check mode writes nothing", async () => {
    const { deps: d } = deps();
    const report = await provisionProductionSecrets({ dir: join(dir, "absent"), apply: false, confirmFresh: true, deps: d });
    expect(report.wouldGenerate).toEqual(["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"]);
    expect(() => statSync(join(dir, "absent"))).toThrow();
  });

  it("tightens loose permissions on an existing file without changing its values", async () => {
    const file = join(dir, "secrets.env");
    writeFileSync(file, `SESSION_SECRET=${hex("c")}\n`);
    chmodSync(file, 0o644);
    const { deps: d } = deps();
    const report = await provisionProductionSecrets({ dir, apply: true, confirmFresh: true, deps: d });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(report.notes).toContain("secrets.env permissions were tightened to 0600");
    expect(readFileSync(file, "utf8")).toContain(`SESSION_SECRET=${hex("c")}`);
    expect(report.reused).toContain("SESSION_SECRET");
  });

  it("uploads missing secrets to an existing Worker only when nothing is blocked", async () => {
    writeFileSync(join(dir, "secrets.env"), `SESSION_SECRET=${hex("4")}\nAUDIT_SIGNING_KEY=${hex("5")}\nMFA_ENCRYPTION_KEY=${hex("6")}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "resend.env"), `RESEND_API_KEY=${RESEND}\n`, { mode: 0o600 });
    const { deps: d, uploads } = deps({ listRemoteSecrets: () => ({ status: "ok", names: ["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"] }) });
    const report = await provisionProductionSecrets({ dir, apply: true, confirmFresh: false, deps: d });
    expect(report.uploaded).toEqual(["RESEND_API_KEY"]);
    expect(uploads).toEqual([{ RESEND_API_KEY: RESEND }]);
  });

  it("does not upload while any required secret is blocked", async () => {
    const { deps: d, uploads } = deps({ listRemoteSecrets: () => ({ status: "ok", names: ["AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"] }) });
    const report = await provisionProductionSecrets({ dir, apply: true, confirmFresh: false, deps: d });
    expect(report.generated).toEqual(["SESSION_SECRET"]);
    expect(uploads).toEqual([]);
    expect(report.problems).toContain("upload skipped: RESEND_API_KEY is blocked");
  });

  it("changes nothing when the provider cannot list remote secrets", async () => {
    const { deps: d } = deps({ listRemoteSecrets: () => ({ status: "error", detail: "Authentication error" }) });
    const report = await provisionProductionSecrets({ dir, apply: true, confirmFresh: true, deps: d });
    expect(report.generated).toEqual([]);
    expect(report.problems).toEqual(["could not list the production Worker secrets (Authentication error); nothing was generated or uploaded"]);
    expect(() => statSync(join(dir, "secrets.env"))).toThrow();
  });

  it("reports an upload failure without retrying with different values", async () => {
    writeFileSync(join(dir, "resend.env"), `RESEND_API_KEY=${RESEND}\n`, { mode: 0o600 });
    const { deps: d } = deps({
      listRemoteSecrets: () => ({ status: "ok", names: ["SESSION_SECRET", "AUDIT_SIGNING_KEY", "MFA_ENCRYPTION_KEY"] }),
      uploadSecrets: () => ({ ok: false, detail: "exit 1" }),
    });
    const report = await provisionProductionSecrets({ dir, apply: true, confirmFresh: false, deps: d });
    expect(report.uploaded).toEqual([]);
    expect(report.problems).toEqual(["wrangler secret bulk failed (exit 1); remote secrets are unchanged or partially set, rerun to fill gaps"]);
  });

  it("refuses OpenSSL failures without writing a partial file", async () => {
    const { deps: d } = deps({ runOpenssl: () => ({ status: 1, stdout: "" }) });
    const report = await provisionProductionSecrets({ dir, apply: true, confirmFresh: true, deps: d });
    expect(report.problems[0]).toContain("openssl rand failed");
    expect(() => statSync(join(dir, "secrets.env"))).toThrow();
  });
});
