import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@medveris/db";
import { CLINICIAN_ID, KAMPALA_TENANT, createHarness, type Session } from "./support.js";

const h = createHarness("data-exchange");
const stamp = Date.now();

let reception: Session;
let clinician: Session;
let finance: Session;
let admin: Session;

function csv(rows: string[]): string {
  return rows.join("\r\n");
}

function uniqueFamily(label: string): string {
  return `${label}${stamp}`;
}

async function patientCount(familyName: string): Promise<number> {
  return withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => {
    const [row] = await tx`select count(*)::int as count from patients where lower(family_name) = lower(${familyName})`;
    return Number(row?.count ?? 0);
  });
}

beforeAll(async () => {
  reception = await h.login("reception@medveris.local");
  clinician = await h.login("clinician@medveris.local");
  finance = await h.login("finance@medveris.local");
  admin = await h.login("admin@medveris.local");
});

afterAll(async () => {
  await h.sql.end({ timeout: 5 });
});

describe("dataset catalogue", () => {
  it("shows each role only the datasets it may import or export", async () => {
    const forReception = await h.expectOk(await h.call(reception, "/api/v1/data/datasets"));
    const byId = Object.fromEntries(forReception.datasets.map((dataset: { id: string }) => [dataset.id, dataset]));
    expect(byId.patients).toMatchObject({ canImport: true, canExport: true, scoped: false, formats: ["csv", "json"] });
    expect(byId.appointments).toMatchObject({ canImport: false, canExport: true });
    expect(byId.invoices).toMatchObject({ canImport: false, canExport: false, scoped: true });

    const forFinance = await h.expectOk(await h.call(finance, "/api/v1/data/datasets"));
    const financeById = Object.fromEntries(forFinance.datasets.map((dataset: { id: string }) => [dataset.id, dataset]));
    expect(financeById.invoices.canExport).toBe(true);
    expect(financeById.patients.canExport).toBe(false);
    expect(financeById.patients.canImport).toBe(false);
  });
});

describe("patient import", () => {
  it("previews a CSV without writing anything, reporting row errors and duplicates", async () => {
    const alpha = uniqueFamily("ImportAlpha");
    const preview = await h.post(reception, "/api/v1/data/import/preview", {
      dataset: "patients",
      format: "csv",
      data: csv([
        "Given Name,Family Name,Date of Birth,Phone,Email",
        `Synthetic,${alpha},1991-02-03,+256700111222,alpha@example.test`,
        `Synthetic,${uniqueFamily("ImportBeta")},1992-03-04,,`,
        "Synthetic,,1993-04-05,,",
        `Synthetic,${alpha},1991-02-03,+256700111222,alpha@example.test`,
      ]),
    }, 200);
    expect(preview.preview).toMatchObject({ dataset: "patients", total: 4, valid: 2, invalid: 2, duplicates: 1 });
    // Row 3 reports both a missing family name and a missing date of birth; row 4 repeats row 2.
    expect(preview.preview.errors).toHaveLength(3);
    expect(preview.preview.sample).toHaveLength(2);
    expect(await patientCount(alpha)).toBe(0);
  });

  it("imports valid rows, creates patients through the import provenance, and never overwrites a duplicate", async () => {
    const existing = uniqueFamily("ImportExisting");
    await h.registerPatient(reception, existing);

    const fresh = uniqueFamily("ImportFresh");
    const result = await h.post(reception, "/api/v1/data/import", {
      dataset: "patients",
      format: "csv",
      allowPartial: true,
      purpose: "Synthetic bulk registration test",
      data: csv([
        "Given Name,Family Name,Date of Birth",
        `Synthetic,${fresh},1988-07-09`,
        `Synthetic,${existing},1990-01-01`,
      ]),
    }, 201);

    expect(result.job).toMatchObject({ dataset: "patients", kind: "import", applied: 1 });
    expect(result.job.errors).toHaveLength(1);
    expect(String(result.job.errors[0].message)).toMatch(/already exists/i);
    expect(await patientCount(existing)).toBe(1);
    expect(await patientCount(fresh)).toBe(1);

    const created = await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff", roles: ["facility_admin"] }, async (tx) => {
      const [row] = await tx`
        select p.created_via, p.identity_confidence, l.local_mrn, l.tenant_id
          from patients p join tenant_patient_links l on l.patient_id = p.id
         where lower(p.family_name) = lower(${fresh}) and l.tenant_id = ${KAMPALA_TENANT}
      `;
      return row;
    });
    expect(created).toBeDefined();
    expect(created).toMatchObject({ createdVia: "import", identityConfidence: "temporary", tenantId: KAMPALA_TENANT });
    expect(String(created!.localMrn)).toContain("KAMP");
  });

  it("refuses a partial write when any row is invalid and the caller did not opt in", async () => {
    const wouldBeCreated = uniqueFamily("ImportRejected");
    const rejected = await h.call(reception, "/api/v1/data/import", {
      method: "POST",
      body: JSON.stringify({
        dataset: "patients",
        format: "csv",
        data: csv([
          "Given Name,Family Name,Date of Birth",
          `Synthetic,${wouldBeCreated},1980-01-01`,
          "Synthetic,,1981-01-01",
        ]),
      }),
    });
    expect(rejected.status).toBe(422);
    expect(await patientCount(wouldBeCreated)).toBe(0);
  });

  it("rejects datasets that cannot be imported and unknown columns", async () => {
    const invoices = await h.call(reception, "/api/v1/data/import", {
      method: "POST",
      body: JSON.stringify({ dataset: "invoices", format: "json", data: [] }),
    });
    expect(invoices.status).toBe(422);

    const unknown = await h.call(reception, "/api/v1/data/import/preview", {
      method: "POST",
      body: JSON.stringify({
        dataset: "patients",
        format: "csv",
        data: csv(["Given Name,Family Name,Date of Birth,Favourite Colour", "Synthetic,Colourful,1990-01-01,blue"]),
      }),
    });
    expect(unknown.status).toBe(422);
  });

  it("denies import to a role without patient registration rights", async () => {
    const denied = await h.call(finance, "/api/v1/data/import/preview", {
      method: "POST",
      body: JSON.stringify({
        dataset: "patients",
        format: "csv",
        data: csv(["Given Name,Family Name,Date of Birth", "Synthetic,Denied,1990-01-01"]),
      }),
    });
    expect(denied.status).toBe(403);
  });
});

describe("export and download", () => {
  it("stages a CSV export server-side and releases it once through a short-lived token", async () => {
    await h.registerPatient(reception, "=2+2");

    const created = await h.post(reception, "/api/v1/data/exports", {
      dataset: "patients",
      format: "csv",
      purpose: "Synthetic export test",
    }, 201);
    expect(created.export).toMatchObject({ dataset: "patients", format: "csv", scope: "tenant", includesSensitive: false });
    expect(created.export.rows).toBeGreaterThan(0);
    expect(created.export.downloadPath).toContain("token=");
    expect(new Date(created.export.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const download = await h.call(reception, created.export.downloadPath);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/csv");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    const body = await download.text();
    expect(body.split("\r\n")[0]).toBe("patientId,givenName,familyName,dateOfBirth,sex,phone,email,registeredAt");
    // Spreadsheet formula injection is neutralised in every cell.
    expect(body).toContain("'=2+2");

    const listing = await h.expectOk(await h.call(reception, "/api/v1/data/exchange"));
    expect(listing.jobs[0]).toMatchObject({ id: created.export.id, kind: "export", status: "completed" });
  });

  it("refuses a download by anyone other than the requester or a facility administrator", async () => {
    const created = await h.post(clinician, "/api/v1/data/exports", { dataset: "patients", format: "json" }, 201);
    const denied = await h.call(reception, created.export.downloadPath);
    expect(denied.status).toBe(403);
  });

  it("refuses a download with the wrong token", async () => {
    const created = await h.post(reception, "/api/v1/data/exports", { dataset: "patients", format: "json" }, 201);
    const path = created.export.downloadPath.replace(/token=.*/, "token=not-the-token");
    expect((await h.call(reception, path)).status).toBe(403);
  });

  it("will not release content that no longer matches its recorded digest", async () => {
    const created = await h.post(clinician, "/api/v1/data/exports", {
      dataset: "patients",
      format: "json",
      includeSensitive: true,
    }, 201);
    await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff", roles: ["facility_admin"] }, (tx) =>
      tx`update data_exchange_jobs set content = content || 'tampered' where id = ${created.export.id}`);
    expect((await h.call(clinician, created.export.downloadPath)).status).toBe(409);
  });

  it("treats an expired export as gone", async () => {
    const created = await h.post(reception, "/api/v1/data/exports", { dataset: "patients", format: "csv" }, 201);
    await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff", roles: ["facility_admin"] }, (tx) =>
      tx`update data_exchange_jobs set expires_at = now() - interval '1 minute' where id = ${created.export.id}`);
    expect((await h.call(reception, created.export.downloadPath)).status).toBe(410);
  });

  it("requires clinical record access before including sensitive fields", async () => {
    const denied = await h.call(reception, "/api/v1/data/exports", {
      method: "POST",
      body: JSON.stringify({ dataset: "patients", format: "csv", includeSensitive: true }),
    });
    expect(denied.status).toBe(403);

    const allowed = await h.post(clinician, "/api/v1/data/exports", {
      dataset: "patients",
      format: "csv",
      includeSensitive: true,
    }, 201);
    expect(allowed.export.includesSensitive).toBe(true);
  });

  it("scopes invoice exports to a department and refuses one from another facility", async () => {
    const departments = await h.expectOk(await h.call(admin, "/api/v1/organization/departments"));
    const departmentId = departments.departments[0].id;

    const created = await h.post(finance, "/api/v1/data/exports", {
      dataset: "invoices",
      format: "json",
      departmentId,
    }, 201);
    expect(created.export).toMatchObject({ dataset: "invoices", format: "json", scope: "department" });

    const unknown = await h.call(finance, "/api/v1/data/exports", {
      method: "POST",
      body: JSON.stringify({ dataset: "invoices", format: "json", departmentId: crypto.randomUUID() }),
    });
    expect(unknown.status).toBe(422);
  });

  it("validates the export date window and refuses a role without export access", async () => {
    const tooLong = await h.call(reception, "/api/v1/data/exports", {
      method: "POST",
      body: JSON.stringify({ dataset: "patients", format: "csv", from: "2020-01-01", to: "2022-01-01" }),
    });
    expect(tooLong.status).toBe(422);

    const reversed = await h.call(reception, "/api/v1/data/exports", {
      method: "POST",
      body: JSON.stringify({ dataset: "patients", format: "csv", from: "2026-01-02", to: "2026-01-01" }),
    });
    expect(reversed.status).toBe(422);

    const denied = await h.call(reception, "/api/v1/data/exports", {
      method: "POST",
      body: JSON.stringify({ dataset: "invoices", format: "csv" }),
    });
    expect(denied.status).toBe(403);
  });

  it("refuses a facility-wide export to a department-scoped membership even when a scope is supplied", async () => {
    const departments = await h.expectOk(await h.call(admin, "/api/v1/organization/departments"));
    const departmentId = departments.departments[0].id;

    await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff", roles: ["facility_admin"] }, (tx) =>
      tx`update memberships set roles = ${["department_admin", "receptionist"]}, scope_department_id = ${departmentId}
           where tenant_id = ${KAMPALA_TENANT} and user_id = (select id from users where email = 'reception@medveris.local')`);
    try {
      const denied = await h.call(reception, "/api/v1/data/exports", {
        method: "POST",
        body: JSON.stringify({ dataset: "patients", format: "csv", departmentId }),
      });
      expect(denied.status).toBe(403);
      const body = await denied.json() as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/facility-wide/i);
    } finally {
      await withContext(h.sql, { tenantId: KAMPALA_TENANT, userId: CLINICIAN_ID, actorKind: "staff", roles: ["facility_admin"] }, (tx) =>
        tx`update memberships set roles = ${["receptionist"]}, scope_department_id = null
             where tenant_id = ${KAMPALA_TENANT} and user_id = (select id from users where email = 'reception@medveris.local')`);
    }
  });
});
