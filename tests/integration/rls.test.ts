import { afterAll, describe, expect, it } from "vitest";
import { createSql, withContext } from "@medveris/db";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const clinicianA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const clinicianB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const adminA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encounterB = "e0000000-0000-4000-8000-000000000003";
const patientA = "a0000000-0000-4000-8000-000000000001";
const patientB = "b0000000-0000-4000-8000-000000000001";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for PostgreSQL isolation tests");
const sql = createSql(url, { max: 1 });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("PostgreSQL runtime tenant isolation", () => {
  it("filters clinical versions to the transaction-local tenant", async () => {
    const a = await withContext(sql, { tenantId: tenantA, userId: clinicianA, actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      select id, tenant_id from clinical_entry_versions order by recorded_at
    `);
    const b = await withContext(sql, { tenantId: tenantB, userId: clinicianB, actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      select id, tenant_id from clinical_entry_versions order by recorded_at
    `);
    const crossTenant = await withContext(sql, { tenantId: tenantA, userId: clinicianA, actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      select id from clinical_entry_versions where tenant_id = ${tenantB}
    `);
    expect(a.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(b.every((row) => row.tenantId === tenantB)).toBe(true);
    expect(crossTenant).toHaveLength(0);
    const aIds = new Set(a.map((row) => row.id));
    expect(b.every((row) => !aIds.has(row.id))).toBe(true);
  });

  it("denies direct cross-tenant encounter reads", async () => {
    const rows = await withContext(sql, { tenantId: tenantA, userId: clinicianA, actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      select id, tenant_id from encounters where id = ${encounterB}
    `);
    expect(rows).toHaveLength(0);
  });

  it("rejects a cross-tenant insert through the RLS check policy", async () => {
    await expect(withContext(sql, { tenantId: tenantA, userId: clinicianA, actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      insert into observations (id, tenant_id, patient_id, encounter_id, loinc_system, loinc_version, loinc_code, display,
        original_text, coding, value_num, unit_code, unit_system, occurred_at, recorded_at, author_id, status, sensitivity)
      values (gen_random_uuid(), ${tenantB}, ${patientB}, ${encounterB}, 'http://loinc.org', 'test', '8867-4', 'Heart rate',
        'Heart rate', '{}'::jsonb, 70, '/min', 'http://unitsofmeasure.org', now(), now(), ${clinicianA}, 'final', ARRAY[]::text[])
    `)).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("does not leak tenant context across pooled connections", async () => {
    await withContext(sql, { tenantId: tenantA, userId: clinicianA, actorKind: "staff", roles: ["clinician"] }, async (tx) => {
      const current = await tx`select current_setting('app.tenant_id', true) as tenant`;
      expect(current[0]?.tenant).toBe(tenantA);
    });
    const reset = await sql`select current_setting('app.tenant_id', true) as tenant, current_setting('app.user_id', true) as user_id`;
    expect(reset[0]?.tenant ?? "").toBe("");
    expect(reset[0]?.user_id ?? "").toBe("");
    const noContext = await sql`select id from clinical_entry_versions limit 1`;
    expect(noContext).toHaveLength(0);
  });

  it("restricts audit reads to the active tenant and governance role", async () => {
    const adminRows = await withContext(sql, { tenantId: tenantA, userId: adminA, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => tx`
      select tenant_id from audit_events
    `);
    expect(adminRows.length).toBeGreaterThan(0);
    expect(adminRows.every((row) => row.tenantId === tenantA)).toBe(true);
    const clinicianRows = await withContext(sql, { tenantId: tenantA, userId: clinicianA, actorKind: "staff", roles: ["clinician"] }, async (tx) => tx`
      select tenant_id from audit_events
    `);
    expect(clinicianRows).toHaveLength(0);
    const patientRows = await withContext(sql, { patientId: patientA, userId: "99999999-9999-4999-8999-999999999999", actorKind: "patient" }, async (tx) => tx`
      select subject_patient_id from audit_events
    `);
    expect(patientRows.every((row) => row.subjectPatientId === patientA)).toBe(true);
  });
});
