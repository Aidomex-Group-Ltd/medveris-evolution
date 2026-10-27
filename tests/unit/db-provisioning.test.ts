import { describe, expect, it } from "vitest";
import { assertRoleProvisioningInputs } from "../../scripts/lib.js";

const hosted = {
  PGADMIN_URL: "postgres://admin:unused@db.staging.example.net:5432/postgres",
  MIGRATION_DATABASE_URL: "postgres://medveris_migrator:unused@db.staging.example.net:5432/medveris_staging",
  MIGRATOR_PASSWORD: "m".repeat(24),
  RUNTIME_PASSWORD: "r".repeat(24),
  JOBS_PASSWORD: "j".repeat(24),
};

describe("database role provisioning inputs", () => {
  it("keeps the local development defaults for medveris_dev and medveris_test", () => {
    expect(() => assertRoleProvisioningInputs({
      MIGRATION_DATABASE_URL: "postgres://medveris_migrator:medveris_migrator_dev@localhost:5432/medveris_dev",
    })).not.toThrow();
  });

  it("accepts explicit distinct passwords on the same hosted server", () => {
    expect(() => assertRoleProvisioningInputs(hosted)).not.toThrow();
  });

  it("refuses published development passwords or missing passwords for a hosted database", () => {
    expect(() => assertRoleProvisioningInputs({ ...hosted, RUNTIME_PASSWORD: "medveris_runtime_dev" })).toThrow("RUNTIME_PASSWORD");
    expect(() => assertRoleProvisioningInputs({ ...hosted, JOBS_PASSWORD: undefined })).toThrow("JOBS_PASSWORD");
    expect(() => assertRoleProvisioningInputs({ ...hosted, JOBS_PASSWORD: hosted.RUNTIME_PASSWORD })).toThrow("distinct");
  });

  it("refuses an admin connection to a different server", () => {
    expect(() => assertRoleProvisioningInputs({ ...hosted, PGADMIN_URL: "postgres://postgres:postgres@localhost:5432/postgres" }))
      .toThrow("same database server");
    expect(() => assertRoleProvisioningInputs({ ...hosted, PGADMIN_URL: undefined })).toThrow("PGADMIN_URL is required");
  });
});
