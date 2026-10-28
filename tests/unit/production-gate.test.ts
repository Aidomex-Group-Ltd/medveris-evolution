import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWranglerConfig } from "../../scripts/staging-gate.mjs";
import {
  PRODUCTION,
  checkBackupAttestation,
  checkDomainState,
  checkMigrationState,
  checkProductionConfig,
  checkProductionHyperdrive,
  checkProductionIsolation,
  checkSmokeResponses,
  migrationSetDigest,
  verificationOrigin,
} from "../../scripts/production-gate.mjs";

const RUNTIME_ID = "0123456789abcdef0123456789abcdef";
const JOBS_ID = "fedcba9876543210fedcba9876543210";
const STAGING_RUNTIME_ID = "83900f032d264402bf1aaf495f4b0d23";

function repoConfig(): any {
  return parseWranglerConfig(readFileSync("wrangler.jsonc", "utf8"));
}

function readyConfig(): any {
  const config = repoConfig();
  config.env.production.hyperdrive = [
    { binding: "HYPERDRIVE", id: RUNTIME_ID },
    { binding: "HYPERDRIVE_JOBS", id: JOBS_ID },
  ];
  return config;
}

function remote(user: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: RUNTIME_ID,
    name: "medveris-production-runtime",
    origin: { host: "db.production.example.net", port: 5432, database: PRODUCTION.database, scheme: "postgresql", user },
    caching: { disabled: true },
    mtls: { sslmode: "verify-full", ca_certificate_id: "ca" },
    ...overrides,
  };
}

describe("production configuration rules", () => {
  it("passes the committed configuration", () => {
    expect(checkProductionConfig(repoConfig())).toEqual([]);
  });

  it("blocks placeholder Hyperdrive IDs", () => {
    const config = repoConfig();
    config.env.production.hyperdrive = [
      { binding: "HYPERDRIVE", id: "REPLACE_WITH_PRODUCTION_RUNTIME_HYPERDRIVE_ID" },
      { binding: "HYPERDRIVE_JOBS", id: "REPLACE_WITH_PRODUCTION_JOBS_HYPERDRIVE_ID" },
    ];
    expect(checkProductionConfig(config)).toEqual([
      "HYPERDRIVE needs a real 32-character Hyperdrive ID (found REPLACE_WITH_PRODUCTION_RUNTIME_HYPERDRIVE_ID)",
      "HYPERDRIVE_JOBS needs a real 32-character Hyperdrive ID (found REPLACE_WITH_PRODUCTION_JOBS_HYPERDRIVE_ID)",
      "production config still contains REPLACE_WITH placeholders",
    ]);
  });

  it("passes once real, distinct production Hyperdrive IDs are configured", () => {
    expect(checkProductionConfig(readyConfig())).toEqual([]);
  });

  it("rejects staging resources, keys and origins", () => {
    const config = readyConfig();
    config.env.production.hyperdrive[0].id = STAGING_RUNTIME_ID;
    config.env.production.r2_buckets = [{ binding: "UPLOADS", bucket_name: "medveris-staging-uploads" }];
    config.env.production.vars.AUDIT_SIGNING_KEY_ID = "staging-key-1";
    config.env.production.vars.APP_ORIGIN = "https://medveris-staging.aidomexgroupltd.workers.dev";
    expect(checkProductionConfig(config)).toEqual(expect.arrayContaining([
      "HYPERDRIVE must not reuse a staging Hyperdrive config",
      `UPLOADS must bind ${PRODUCTION.bucket}`,
      "AUDIT_SIGNING_KEY_ID must be a production key id (production-key-<n>)",
      `APP_ORIGIN must be ${PRODUCTION.origin}`,
      "production config references a staging, local or synthetic resource",
    ]));
  });

  it("rejects synthetic terminology, enabled external writes and inline secrets", () => {
    const config = readyConfig();
    Object.assign(config.env.production.vars, {
      TERMINOLOGY_MODE: "synthetic",
      FHIR_EXTERNAL_WRITES_ENABLED: "true",
      FEATURE_PAYMENTS: "true",
      DEV_SHOW_TOTP_SECRETS: "true",
      SESSION_SECRET: "inline-value",
    });
    const problems = checkProductionConfig(config);
    expect(problems).toEqual(expect.arrayContaining([
      "TERMINOLOGY_MODE must be unavailable or production (with a provider URL)",
      "FHIR_EXTERNAL_WRITES_ENABLED must be false",
      "FEATURE_PAYMENTS must be false until its adapter is implemented and verified",
      "DEV_SHOW_TOTP_SECRETS must be false",
      "SESSION_SECRET looks like a secret and must not be a plaintext var",
    ]));
    expect(problems.join("\n")).not.toContain("inline-value");
  });

  it("requires every secret, the cron and version metadata to be declared", () => {
    const config = readyConfig();
    config.env.production.secrets.required = ["SESSION_SECRET"];
    delete config.env.production.triggers;
    delete config.env.production.version_metadata;
    expect(checkProductionConfig(config)).toEqual(expect.arrayContaining([
      "AUDIT_SIGNING_KEY must be listed in env.production.secrets.required",
      "RESEND_API_KEY must be listed in env.production.secrets.required",
      "production cron trigger is missing",
      "env.production.version_metadata must bind CF_VERSION_METADATA",
    ]));
  });

  it("only allows routes that are custom domains of medveris.online", () => {
    const config = readyConfig();
    config.env.production.routes = [{ pattern: "medveris.online/*", zone_name: "medveris.online" }];
    expect(checkProductionConfig(config)).toContain("production routes must be custom domains for medveris.online or www.medveris.online");
    config.env.production.routes = [{ pattern: "medveris.online", custom_domain: true }];
    expect(checkProductionConfig(config)).toEqual([]);
  });
});

describe("production Hyperdrive rules", () => {
  it("accepts caching-disabled verify-full configs for the intended roles", () => {
    expect([
      ...checkProductionHyperdrive("HYPERDRIVE", remote(PRODUCTION.runtimeRole)),
      ...checkProductionHyperdrive("HYPERDRIVE_JOBS", remote(PRODUCTION.jobsRole, { id: JOBS_ID, name: "medveris-production-jobs" })),
    ]).toEqual([]);
  });

  it("rejects caching, weak TLS, wrong roles and databases", () => {
    const weak = remote(PRODUCTION.runtimeRole, { caching: { disabled: false }, mtls: { sslmode: "require" } });
    weak.origin.database = "medveris_staging";
    expect(checkProductionHyperdrive("HYPERDRIVE", weak)).toEqual([
      "HYPERDRIVE: query caching must be disabled",
      `HYPERDRIVE: origin database must be ${PRODUCTION.database}`,
      "HYPERDRIVE: TLS must verify the server certificate (sslmode verify-ca or verify-full)",
      "HYPERDRIVE: Hyperdrive config references staging",
    ]);
    expect(checkProductionHyperdrive("HYPERDRIVE_JOBS", remote(PRODUCTION.runtimeRole))).toContain("HYPERDRIVE_JOBS: origin user must be medveris_jobs");
    expect(checkProductionHyperdrive("HYPERDRIVE", null)).toEqual(["HYPERDRIVE: Hyperdrive config could not be read"]);
  });

  it("requires a production database server separate from staging", () => {
    const production = { runtime: remote(PRODUCTION.runtimeRole), jobs: remote(PRODUCTION.jobsRole) };
    const staging = [{ origin: { host: "db.production.example.net", port: 5432, database: "medveris_staging" } }];
    expect(checkProductionIsolation(production, staging)).toEqual([
      "production Hyperdrive targets the staging PostgreSQL server db.production.example.net:5432; production needs its own server",
    ]);
    expect(checkProductionIsolation(production, [{ origin: { host: "other.example.net", port: 5432 } }])).toEqual([]);
    const split = { runtime: remote(PRODUCTION.runtimeRole), jobs: remote(PRODUCTION.jobsRole) };
    split.jobs.origin.host = "elsewhere.example.net";
    expect(checkProductionIsolation(split, [])).toContain("HYPERDRIVE and HYPERDRIVE_JOBS must target the same production host, port and database");
  });
});

describe("production domain rules", () => {
  it("verifies on workers.dev until the domain is attached and declared", () => {
    expect(checkDomainState({ declared: [], attached: [], workersDev: true })).toEqual([]);
    expect(verificationOrigin({ declared: [], attached: [] })).toBe(PRODUCTION.workersDevOrigin);
    expect(verificationOrigin({ declared: ["medveris.online"], attached: ["medveris.online"] })).toBe(PRODUCTION.origin);
  });

  it("refuses a declared domain that was not attached through the verified domain step", () => {
    expect(checkDomainState({ declared: ["medveris.online"], attached: [], workersDev: true }))
      .toEqual(["medveris.online is declared in wrangler.jsonc but not attached; run npm run domain:production after verification"]);
  });

  it("requires attached domains to be declared so releases keep them", () => {
    expect(checkDomainState({ declared: [], attached: ["medveris.online"], workersDev: true }))
      .toEqual(["medveris.online is attached but not declared in env.production.routes as a custom domain"]);
  });

  it("refuses to disable workers.dev before a domain serves production", () => {
    expect(checkDomainState({ declared: [], attached: [], workersDev: false }))
      .toEqual(["workers_dev may only be disabled after medveris.online is attached and declared"]);
  });
});

describe("production migration and recovery rules", () => {
  const files = [{ version: "001_a.sql", body: "select 1" }, { version: "002_b.sql", body: "select 2" }];

  it("passes only when every migration is applied and nothing unknown is recorded", () => {
    expect(checkMigrationState({ files, applied: ["001_a.sql", "002_b.sql"] })).toEqual([]);
    expect(checkMigrationState({ files, applied: ["001_a.sql"] }))
      .toEqual(["1 migration(s) not applied to production: 002_b.sql; apply them with the reviewed migration procedure first"]);
    expect(checkMigrationState({ files, applied: ["001_a.sql", "002_b.sql", "003_c.sql"] }))
      .toEqual(["production has migrations this release does not contain: 003_c.sql"]);
    expect(checkMigrationState({ files, applied: null })).toEqual(["production migration state could not be read"]);
  });

  it("fingerprints the migration set", () => {
    expect(migrationSetDigest(files)).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationSetDigest(files)).not.toBe(migrationSetDigest([files[0]!]));
  });

  it("requires a recent recorded restore drill with point-in-time recovery", () => {
    const now = new Date("2026-10-28T00:00:00Z");
    const good = { provider: "managed", pointInTimeRecovery: true, encryptedBackups: true, restoreDrillAt: "2026-10-01T00:00:00Z", restoreDrillBy: "ops" };
    expect(checkBackupAttestation(good, now)).toEqual([]);
    expect(checkBackupAttestation(null, now)).toEqual([
      "no backup and restore verification is recorded in ~/.config/medveris/production/backup-verification.json",
    ]);
    expect(checkBackupAttestation({ ...good, pointInTimeRecovery: false, restoreDrillAt: "2026-01-01T00:00:00Z" }, now)).toEqual([
      "point-in-time recovery must be enabled on the production database",
      "the last restore drill is older than 90 days",
    ]);
  });
});

describe("production smoke rules", () => {
  const ok = {
    config: { status: 200, body: JSON.stringify({ appEnv: "production", terminology: { mode: "unavailable", synthetic: false }, features: { lab: false } }) },
    me: { status: 401, body: JSON.stringify({ error: { code: "unauthenticated", correlationId: "x" } }) },
    missing: { status: 404, body: JSON.stringify({ error: { code: "not_found", correlationId: "y" } }) },
  };

  it("passes a production deployment that reports its limits truthfully", () => {
    expect(checkSmokeResponses(ok)).toBeNull();
  });

  it("detects staging, synthetic terminology, open protected routes and leaky errors", () => {
    expect(checkSmokeResponses({ ...ok, config: { status: 200, body: JSON.stringify({ appEnv: "staging", terminology: { synthetic: false }, features: {} }) } }))
      .toBe("public config reports appEnv=staging");
    expect(checkSmokeResponses({ ...ok, config: { status: 200, body: JSON.stringify({ appEnv: "production", terminology: { synthetic: true }, features: {} }) } }))
      .toBe("synthetic terminology is active");
    expect(checkSmokeResponses({ ...ok, config: { status: 200, body: JSON.stringify({ appEnv: "production", terminology: { synthetic: false }, features: { lab: true } }) } }))
      .toBe("integration lab reports available");
    expect(checkSmokeResponses({ ...ok, me: { status: 200, body: "{}" } })).toBe("protected route /api/v1/me answered 200 without a session");
    expect(checkSmokeResponses({ ...ok, missing: { status: 500, body: "Error: at handler (worker.js:1)" } }))
      .toBe("unknown API route answered 500 instead of a JSON 404");
  });
});
