import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPECTED,
  checkHyperdrivePair,
  checkHyperdriveRemote,
  checkResendKey,
  checkSecretValues,
  checkStagingConfig,
  parseEnvFile,
  parseJsonOutput,
  parseWranglerConfig,
  planSecretUpload,
  requiredSecrets,
} from "../../scripts/staging-gate.mjs";

const RUNTIME_ID = "0123456789abcdef0123456789abcdef";
const JOBS_ID = "fedcba9876543210fedcba9876543210";

function repoConfig(): any {
  return parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
}

function readyConfig(): any {
  const config = repoConfig();
  config.env.staging.hyperdrive = [
    { binding: "HYPERDRIVE", id: RUNTIME_ID },
    { binding: "HYPERDRIVE_JOBS", id: JOBS_ID },
  ];
  return config;
}

function remote(user: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: RUNTIME_ID,
    name: "medveris-staging-runtime",
    origin: { host: "db.staging.example.net", port: 5432, database: EXPECTED.database, scheme: "postgresql", user },
    caching: { disabled: true },
    ...overrides,
  };
}

const strongSecrets = new Map([
  ["SESSION_SECRET", "s".repeat(20) + "-staging-session-value"],
  ["AUDIT_SIGNING_KEY", "a".repeat(20) + "-staging-audit-value"],
  ["MFA_ENCRYPTION_KEY", "m".repeat(20) + "-staging-mfa-value"],
]);

describe("staging gate configuration rules", () => {
  it("passes the committed staging configuration", () => {
    expect(checkStagingConfig(repoConfig())).toEqual([]);
    expect(checkStagingConfig(readyConfig())).toEqual([]);
  });

  it("blocks placeholder Hyperdrive IDs", () => {
    const config = repoConfig();
    config.env.staging.hyperdrive = [
      { binding: "HYPERDRIVE", id: "REPLACE_WITH_STAGING_RUNTIME_HYPERDRIVE_ID" },
      { binding: "HYPERDRIVE_JOBS", id: "REPLACE_WITH_STAGING_JOBS_HYPERDRIVE_ID" },
    ];
    expect(checkStagingConfig(config)).toEqual([
      "HYPERDRIVE needs a real 32-character Hyperdrive ID (found REPLACE_WITH_STAGING_RUNTIME_HYPERDRIVE_ID)",
      "HYPERDRIVE_JOBS needs a real 32-character Hyperdrive ID (found REPLACE_WITH_STAGING_JOBS_HYPERDRIVE_ID)",
      "staging config still contains REPLACE_WITH placeholders",
    ]);
  });

  it("rejects a shared or local-only Hyperdrive config", () => {
    const shared = readyConfig();
    shared.env.staging.hyperdrive[1].id = RUNTIME_ID;
    expect(checkStagingConfig(shared)).toContain("HYPERDRIVE and HYPERDRIVE_JOBS must be different configs (different roles)");
    const local = readyConfig();
    local.env.staging.hyperdrive[0].id = "local-only";
    expect(checkStagingConfig(local).join("\n")).toMatch(/local-only/);
  });

  it("rejects unsafe staging values and secrets in vars", () => {
    const config = readyConfig();
    Object.assign(config.env.staging.vars, {
      DEV_SHOW_TOTP_SECRETS: "true",
      FHIR_EXTERNAL_WRITES_ENABLED: "true",
      TERMINOLOGY_MODE: "production",
      SESSION_SECRET: "inline",
      RESEND_API_KEY: "inline",
    });
    const problems = checkStagingConfig(config);
    expect(problems).toEqual(expect.arrayContaining([
      "DEV_SHOW_TOTP_SECRETS must be false",
      "FHIR_EXTERNAL_WRITES_ENABLED must be false",
      "TERMINOLOGY_MODE must be synthetic",
      "SESSION_SECRET looks like a secret and must not be a plaintext var",
      "RESEND_API_KEY looks like a secret and must not be a plaintext var",
      "staging config references a production resource or value",
    ]));
    expect(problems.join("\n")).not.toContain("inline");
  });

  it("rejects other buckets, routes and missing secret declarations", () => {
    const config = readyConfig();
    config.env.staging.r2_buckets = [{ binding: "UPLOADS", bucket_name: "joblite-media" }];
    config.env.staging.routes = [{ pattern: "medveris.example/*", zone_name: "medveris.example" }];
    config.env.staging.secrets.required = ["SESSION_SECRET"];
    const problems = checkStagingConfig(config);
    expect(problems).toEqual(expect.arrayContaining([
      `UPLOADS must bind ${EXPECTED.bucket}`,
      "R2 binding UPLOADS must use a medveris-staging bucket",
      "env.staging must not declare routes; staging is served only from workers.dev",
      "AUDIT_SIGNING_KEY must be listed in env.staging.secrets.required",
      "MFA_ENCRYPTION_KEY must be listed in env.staging.secrets.required",
    ]));
  });
});

describe("staging gate remote Hyperdrive rules", () => {
  it("accepts caching-disabled configs for the intended roles on one database", () => {
    const runtime = remote(EXPECTED.runtimeRole);
    const jobs = remote(EXPECTED.jobsRole, { id: JOBS_ID });
    expect([...checkHyperdriveRemote("HYPERDRIVE", runtime), ...checkHyperdriveRemote("HYPERDRIVE_JOBS", jobs), ...checkHyperdrivePair(runtime, jobs)])
      .toEqual([]);
  });

  it("rejects caching, wrong roles, wrong databases and local origins", () => {
    expect(checkHyperdriveRemote("HYPERDRIVE", remote(EXPECTED.runtimeRole, { caching: { disabled: false } })))
      .toEqual(["HYPERDRIVE: query caching must be disabled"]);
    expect(checkHyperdriveRemote("HYPERDRIVE", remote(EXPECTED.jobsRole))).toEqual(["HYPERDRIVE: origin user must be medveris_runtime"]);
    expect(checkHyperdriveRemote("HYPERDRIVE_JOBS", remote("postgres"))).toEqual(["HYPERDRIVE_JOBS: origin user must be medveris_jobs"]);
    const wrongDatabase = remote(EXPECTED.runtimeRole);
    wrongDatabase.origin.database = "medveris_prod";
    expect(checkHyperdriveRemote("HYPERDRIVE", wrongDatabase)).toEqual(["HYPERDRIVE: origin database must be medveris_staging"]);
    const local = remote(EXPECTED.runtimeRole);
    local.origin.host = "localhost";
    expect(checkHyperdriveRemote("HYPERDRIVE", local)).toEqual(["HYPERDRIVE: origin host is a local or private address"]);
    expect(checkHyperdriveRemote("HYPERDRIVE", null)).toEqual(["HYPERDRIVE: Hyperdrive config could not be read"]);
  });

  it("requires both bindings to reach the same database", () => {
    const jobs = remote(EXPECTED.jobsRole);
    jobs.origin.host = "other-db.example.net";
    expect(checkHyperdrivePair(remote(EXPECTED.runtimeRole), jobs)).toHaveLength(1);
  });

  it("parses JSON printed after the Wrangler banner", () => {
    expect(parseJsonOutput(" ⛅️ wrangler 4.152.0\n───\n{\n  \"id\": \"x\"\n}\n")).toEqual({ id: "x" });
    expect(parseJsonOutput("no json here")).toBeNull();
  });
});

describe("staging gate secrets rules", () => {
  it("accepts distinct generated staging values", () => {
    expect(checkSecretValues(strongSecrets, new Map([["SESSION_SECRET", "a-different-local-value-123456"]]))).toEqual([]);
  });

  it("rejects weak, reused, duplicated or unexpected values without echoing them", () => {
    const values = new Map(strongSecrets);
    values.set("SESSION_SECRET", "replace-with-at-least-32-random-characters");
    values.set("MFA_ENCRYPTION_KEY", values.get("AUDIT_SIGNING_KEY")!);
    values.set("PGPASSWORD", "database-password-value");
    const local = new Map([["AUDIT_SIGNING_KEY", strongSecrets.get("AUDIT_SIGNING_KEY")!]]);
    const problems = checkSecretValues(values, local);
    expect(problems).toEqual(expect.arrayContaining([
      "secrets file contains unexpected key PGPASSWORD; only SESSION_SECRET, AUDIT_SIGNING_KEY, MFA_ENCRYPTION_KEY may be uploaded",
      "SESSION_SECRET is a placeholder or test value",
      "AUDIT_SIGNING_KEY matches a local development value",
      "staging secrets must be distinct values",
    ]));
    const text = problems.join("\n");
    for (const value of values.values()) expect(text).not.toContain(value);
  });

  it("parses dotenv files", () => {
    expect(parseEnvFile("# comment\nSESSION_SECRET=\"abc\"\nlower=ignored\n").get("SESSION_SECRET")).toBe("abc");
  });

  it("uploads every required secret to a new Worker only when local files provide them all", () => {
    const names = [...strongSecrets.keys()];
    expect(planSecretUpload({ remoteNames: null, availableNames: names, required: names })).toEqual({
      upload: names, problems: [], notes: ["new Worker: secrets will be uploaded with the first deployment"],
    });
    expect(planSecretUpload({ remoteNames: null, availableNames: ["SESSION_SECRET"], required: names }).problems)
      .toEqual(["required secrets are not configured on the Worker and no local file provides them: AUDIT_SIGNING_KEY, MFA_ENCRYPTION_KEY"]);
  });

  it("never re-uploads secrets that already exist on the Worker", () => {
    const names = [...strongSecrets.keys()];
    expect(planSecretUpload({ remoteNames: names, availableNames: names, required: names })).toMatchObject({ upload: [], problems: [] });
    const withResend = [...names, "RESEND_API_KEY"];
    expect(planSecretUpload({ remoteNames: names, availableNames: withResend, required: withResend }))
      .toMatchObject({ upload: ["RESEND_API_KEY"], problems: [] });
    expect(planSecretUpload({ remoteNames: ["AUDIT_SIGNING_KEY"], availableNames: names, required: names }).upload)
      .toEqual(["SESSION_SECRET", "MFA_ENCRYPTION_KEY"]);
  });

  it("validates the Resend API key shape without echoing it", () => {
    expect(checkResendKey("re_" + "a".repeat(30))).toEqual([]);
    expect(checkResendKey(undefined)).toEqual(["the Resend secrets file is missing RESEND_API_KEY"]);
    expect(checkResendKey("sk_live_not_resend")).toEqual(["RESEND_API_KEY does not look like a Resend API key"]);
  });
});

describe("staging gate email rules", () => {
  it("requires a real sender and the Resend secret once Resend is selected", () => {
    const config = readyConfig();
    config.env.staging.vars.EMAIL_ADAPTER = "resend";
    config.env.staging.vars.EMAIL_FROM = "MedVeris <no-reply@medveris.local>";
    expect(requiredSecrets(config.env.staging)).toContain("RESEND_API_KEY");
    expect(checkStagingConfig(config)).toEqual([
      "EMAIL_FROM must use a verified Resend sending domain when EMAIL_ADAPTER is resend",
      "RESEND_API_KEY must be listed in env.staging.secrets.required",
    ]);
    config.env.staging.vars.EMAIL_FROM = "MedVeris <no-reply@mail.example.org>";
    config.env.staging.secrets.required.push("RESEND_API_KEY");
    expect(checkStagingConfig(config)).toEqual([]);
  });

  it("rejects an unknown email adapter", () => {
    const config = readyConfig();
    config.env.staging.vars.EMAIL_ADAPTER = "smtp";
    expect(checkStagingConfig(config)).toContain("EMAIL_ADAPTER must be local (no delivery) or resend");
  });
});
