import { Hono, type Context } from "hono";
import { z } from "zod";
import { randomToken, sha256Hex } from "@medveris/auth";
import { permissionsForRoles, withImpliedRoles } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestAudit } from "../lib/actor.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { actorScope, assertDepartmentInScope } from "../lib/scope.js";
import { csvCell } from "./reports.js";
import type { AppEnv } from "../types.js";

/**
 * Controlled bulk import and export.
 *
 * Three rules shape this route:
 *  - the caller's role decides which dataset they may touch, and a department/unit-scoped role can
 *    never widen its scope through a request parameter;
 *  - an import only ever creates patients. It never updates or deletes an existing patient,
 *    financial or clinical record, and a duplicate is reported instead of overwritten;
 *  - export content is generated inside the database transaction, audited, stored server-side and
 *    released only through a short-lived token shown once to the requester.
 */

export const dataExchangeRoutes = new Hono<AppEnv>();

const MAX_IMPORT_ROWS = 200;
const MAX_EXPORT_ROWS = 1_000;
const DOWNLOAD_TTL_MINUTES = 15;
const MAX_RANGE_DAYS = 366;

const DATASETS = {
  patients: {
    label: "Patient demographics",
    scoped: false,
    /** Creating a patient is a registration action, not a general administration action. */
    importPermission: "patient.register",
    exportPermissions: ["patient.lookup.exact", "clinical.record.read_authorized"],
    sensitiveExportPermission: "clinical.record.read_authorized",
  },
  appointments: {
    label: "Appointments",
    scoped: false,
    importPermission: null,
    exportPermissions: ["patient.lookup.exact", "clinical.record.read_authorized"],
    sensitiveExportPermission: "clinical.record.read_authorized",
  },
  invoices: {
    label: "Invoices",
    scoped: true,
    importPermission: null,
    exportPermissions: ["finance.dashboard.read", "finance.payment.record"],
    sensitiveExportPermission: "clinical.record.read_authorized",
  },
} as const;

type Dataset = keyof typeof DATASETS;

const datasetSchema = z.enum(["patients", "appointments", "invoices"]);

const importSchema = z.object({
  dataset: datasetSchema,
  format: z.enum(["csv", "json"]),
  data: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  allowPartial: z.boolean().default(false),
  purpose: z.string().trim().max(200).optional(),
}).strict();

const exportSchema = z.object({
  dataset: datasetSchema,
  format: z.enum(["csv", "json"]),
  departmentId: z.string().uuid().optional().nullable(),
  unitId: z.string().uuid().optional().nullable(),
  includeSensitive: z.boolean().default(false),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  purpose: z.string().trim().max(200).optional(),
}).strict();

const patientRowSchema = z.object({
  givenName: z.string().trim().min(1).max(120),
  familyName: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().date(),
  sex: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().toLowerCase().email().max(254).optional().nullable(),
}).strict();

interface RowError { row: number; field: string; message: string }

interface ParsedTable {
  columns: string[];
  rows: Record<string, unknown>[];
  errors: RowError[];
}

const COLUMN_ALIASES: Record<string, keyof z.infer<typeof patientRowSchema>> = {
  given_name: "givenName", givenname: "givenName", given: "givenName", first_name: "givenName", firstname: "givenName",
  family_name: "familyName", familyname: "familyName", family: "familyName", surname: "familyName", last_name: "familyName", lastname: "familyName",
  date_of_birth: "dateOfBirth", dateofbirth: "dateOfBirth", dob: "dateOfBirth", birth_date: "dateOfBirth",
  sex: "sex", gender: "sex",
  phone: "phone", phone_number: "phone", telephone: "phone", msisdn: "phone",
  email: "email", email_address: "email",
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Minimal RFC 4180 parser: quoted commas, escaped quotes and quoted newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === "\"") {
        if (text[index + 1] === "\"") { field += "\""; index += 1; } else { quoted = false; }
      } else field += character;
      continue;
    }
    if (character === "\"") { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function toObjects(format: "csv" | "json", data: string | Record<string, unknown>[]): ParsedTable {
  const errors: RowError[] = [];
  let header: string[] = [];
  let raw: Array<Record<string, unknown>> = [];
  if (format === "csv") {
    if (typeof data !== "string") throw new ValidationError("CSV imports must send the file as text");
    const table = parseCsv(data);
    if (table.length < 2) throw new ValidationError("The CSV needs a header row and at least one data row");
    header = table[0]!.map(normalizeHeader);
    raw = table.slice(1).map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
  } else {
    let parsed: unknown = data;
    if (typeof data === "string") {
      try { parsed = JSON.parse(data); } catch { throw new ValidationError("The JSON file could not be parsed"); }
    }
    if (!Array.isArray(parsed)) throw new ValidationError("JSON imports must be an array of objects");
    raw = parsed as Array<Record<string, unknown>>;
    header = [...new Set(raw.flatMap((row) => Object.keys(row).map(normalizeHeader)))];
  }
  if (raw.length > MAX_IMPORT_ROWS) throw new ValidationError(`Imports are limited to ${MAX_IMPORT_ROWS} rows at a time`);
  if (!raw.length) throw new ValidationError("The import contains no data rows");
  const unknownColumns = header.filter((name) => !(name in COLUMN_ALIASES));
  if (unknownColumns.length) {
    throw new ValidationError(`Unknown columns: ${unknownColumns.join(", ")}`, unknownColumns.map((column) => ({ path: column, message: "Column is not recognised for this dataset" })));
  }
  const mapped = raw.map((row, index) => {
    const value: Record<string, unknown> = {};
    for (const [name, target] of Object.entries(COLUMN_ALIASES)) {
      const source = row[name];
      if (source !== undefined) value[target] = typeof source === "string" ? source.trim() : source;
    }
    for (const key of ["givenName", "familyName", "dateOfBirth"] as const) {
      if (!value[key]) errors.push({ row: index + 2, field: key, message: `${key} is required` });
    }
    if (value.sex === "" || value.sex === undefined) value.sex = "unknown";
    if (value.phone === "") value.phone = null;
    if (value.email === "") value.email = null;
    return value;
  });
  return { columns: header, rows: mapped, errors };
}

async function validatePatientRows(tx: Tx, tenantId: string, rows: Record<string, unknown>[], baseErrors: RowError[]): Promise<{ valid: Array<z.infer<typeof patientRowSchema> & { row: number }>; errors: RowError[] }> {
  const errors = [...baseErrors];
  const valid: Array<z.infer<typeof patientRowSchema> & { row: number }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const rowNumber = index + 2;
    const parsed = patientRowSchema.safeParse(rows[index]);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ row: rowNumber, field: issue.path.join(".") || "row", message: issue.message });
      }
      continue;
    }
    const value = parsed.data;
    const key = `${value.givenName.toLowerCase()}|${value.familyName.toLowerCase()}|${value.dateOfBirth}|${(value.phone ?? "").replace(/\s+/g, "")}`;
    if (seen.has(key)) {
      errors.push({ row: rowNumber, field: "row", message: "This row duplicates another row in the same file" });
      continue;
    }
    seen.add(key);
    const [duplicate] = await tx`
      select p.id from patients p
        join tenant_patient_links l on l.patient_id = p.id and l.tenant_id = ${tenantId}
       where lower(p.given_name) = lower(${value.givenName})
         and lower(p.family_name) = lower(${value.familyName})
         and p.date_of_birth = ${value.dateOfBirth}
         and (${value.phone ?? null}::text is null or p.phone = ${value.phone ?? null})
         and p.merged_into is null
       limit 1
    `;
    if (duplicate) {
      errors.push({ row: rowNumber, field: "row", message: "A matching patient already exists in this facility; nothing was overwritten" });
      continue;
    }
    valid.push({ ...value, row: rowNumber });
  }
  return { valid, errors };
}

function requirePermissions(c: Context<AppEnv>, permissions: readonly string[], message: string): void {
  const roles = c.get("auth")!.activeTenant!.roles;
  const granted = permissionsForRoles(withImpliedRoles(roles));
  if (!permissions.some((permission) => granted.has(permission as never))) throw new ForbiddenError(message);
}

function hasPermission(c: Context<AppEnv>, permission: string): boolean {
  const roles = c.get("auth")!.activeTenant!.roles;
  return permissionsForRoles(withImpliedRoles(roles)).has(permission as never);
}

function dateWindow(from?: string, to?: string): { start: Date | null; end: Date | null } {
  if (!from && !to) return { start: null, end: null };
  const start = from ? new Date(`${from}T00:00:00.000Z`) : null;
  const end = to ? new Date(`${to}T23:59:59.999Z`) : null;
  if (start && Number.isNaN(start.getTime())) throw new ValidationError("from must be a date (YYYY-MM-DD)");
  if (end && Number.isNaN(end.getTime())) throw new ValidationError("to must be a date (YYYY-MM-DD)");
  if (start && end && start > end) throw new ValidationError("from must be on or before to");
  if (start && end && (end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new ValidationError(`Exports cover at most ${MAX_RANGE_DAYS} days`);
  }
  return { start, end };
}

dataExchangeRoutes.get("/data/datasets", (c) => {
  requireStaff(c);
  return c.json({
    datasets: (Object.keys(DATASETS) as Dataset[]).map((id) => {
      const dataset = DATASETS[id];
      const allowed = dataset.exportPermissions.some((permission) => hasPermission(c, permission));
      return {
        id,
        label: dataset.label,
        canImport: dataset.importPermission ? hasPermission(c, dataset.importPermission) : false,
        canExport: allowed,
        scoped: dataset.scoped,
        formats: ["csv", "json"],
      };
    }),
  });
});

dataExchangeRoutes.post("/data/import/preview", async (c) => {
  requireStaff(c);
  await enforceRateLimit(c, "jobs.submit", c.get("auth")!.user.id);
  const body = await parseJson(c, importSchema);
  const dataset = DATASETS[body.dataset];
  if (!dataset.importPermission) throw new ValidationError(`${dataset.label} cannot be imported`);
  requirePermissions(c, [dataset.importPermission], `Importing ${dataset.label.toLowerCase()} is not permitted for your active role`);
  const table = toObjects(body.format, body.data);
  const tenantId = c.get("auth")!.activeTenant!.id;
  const { valid, errors } = await withStaffActor(c, (tx) => validatePatientRows(tx, tenantId, table.rows, table.errors));
  return c.json({
    preview: {
      dataset: body.dataset,
      columns: table.columns,
      total: table.rows.length,
      valid: valid.length,
      invalid: table.rows.length - valid.length,
      duplicates: errors.filter((error) => error.field === "row" && /duplicate|already exists/i.test(error.message)).length,
      errors: errors.slice(0, 50),
      sample: valid.slice(0, 5).map(({ row, ...value }) => ({ row, ...value })),
      truncationNote: errors.length > 50 ? "Only the first 50 errors are shown." : null,
    },
  });
});

dataExchangeRoutes.post("/data/import", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  await enforceRateLimit(c, "jobs.submit", auth.user.id);
  const body = await parseJson(c, importSchema);
  const dataset = DATASETS[body.dataset];
  if (!dataset.importPermission) throw new ValidationError(`${dataset.label} cannot be imported`);
  requirePermissions(c, [dataset.importPermission], `Importing ${dataset.label.toLowerCase()} is not permitted for your active role`);
  const table = toObjects(body.format, body.data);
  const tenantId = auth.activeTenant!.id;
  const config = c.get("deps").config;
  const meta = auditMeta(c);
  const result = await withStaffActor(c, async (tx) => {
    const { valid, errors } = await validatePatientRows(tx, tenantId, table.rows, table.errors);
    if (!body.allowPartial && errors.length) {
      throw new ValidationError("The file has rows that cannot be imported. Fix them or choose a partial import.", errors.slice(0, 50).map((error) => ({ path: `row ${error.row}.${error.field}`, message: error.message })));
    }
    const jobId = crypto.randomUUID();
    const applied: string[] = [];
    for (const row of valid) {
      const patientId = crypto.randomUUID();
      let publicId = "";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = (await import("@medveris/domain")).randomPatientPublicId();
        const [clash] = await tx`select 1 from patients where public_id = ${candidate}`;
        if (!clash) { publicId = candidate; break; }
      }
      if (!publicId) throw new AppError(409, "public_id_unavailable", "A patient identifier could not be allocated; nothing was imported");
      await tx`
        insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, email, phone,
          identity_confidence, identity_evidence, created_via, created_tenant_id)
        values (${patientId}, ${publicId}, ${row.givenName}, ${row.familyName}, ${row.dateOfBirth}, ${row.sex},
          ${row.email ?? null}, ${row.phone ?? null}, 'temporary', 'bulk import reviewed by facility staff',
          'import', ${tenantId})
      `;
      const { localMedicalRecordNumber } = await import("@medveris/domain");
      await tx`
        insert into tenant_patient_links (id, tenant_id, patient_id, local_mrn)
        values (${crypto.randomUUID()}, ${tenantId}, ${patientId}, ${localMedicalRecordNumber(auth.activeTenant!.slug, publicId)})
      `;
      applied.push(patientId);
    }
    await tx`
      insert into data_exchange_jobs (
        id, tenant_id, kind, dataset, format, scope, status, requested_by,
        row_count, applied_count, error_count, errors, includes_sensitive, completed_at
      ) values (
        ${jobId}, ${tenantId}, 'import', ${body.dataset}, ${body.format}, 'tenant', ${errors.length && !applied.length ? "failed" : "completed"}, ${auth.user.id},
        ${table.rows.length}, ${applied.length}, ${errors.length}, ${tx.json(errors as never)}, false, now()
      )
    `;
    await writeAudit(tx, config, requestAudit(c, "data.import", {
      resourceType: "DataExchangeJob", resourceId: jobId,
      metadata: { dataset: body.dataset, format: body.format, rows: table.rows.length, applied: applied.length, errors: errors.length, allowPartial: body.allowPartial, purpose: body.purpose ?? null, ...meta },
    }));
    return { jobId, applied: applied.length, errors };
  });
  return c.json({
    ok: true,
    job: { id: result.jobId, dataset: body.dataset, kind: "import", applied: result.applied, errors: result.errors.slice(0, 50) },
  }, 201);
});

interface ExportContext {
  tenantId: string;
  departmentId: string | null;
  unitId: string | null;
  scope: "tenant" | "department" | "unit";
  includeSensitive: boolean;
  start: Date | null;
  end: Date | null;
}

async function exportRows(tx: Tx, dataset: Dataset, context: ExportContext): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  if (dataset === "patients") {
    const rows = await tx`
      select p.public_id as "patientId", p.given_name as "givenName", p.family_name as "familyName",
             p.date_of_birth as "dateOfBirth", p.sex,
             ${context.includeSensitive ? tx`p.phone` : tx`null`} as phone,
             ${context.includeSensitive ? tx`p.email` : tx`null`} as email,
             l.created_at as "registeredAt"
        from patients p join tenant_patient_links l on l.patient_id = p.id
       where l.tenant_id = ${context.tenantId} and p.merged_into is null
         ${context.start ? tx`and l.created_at >= ${context.start}` : tx``}
         ${context.end ? tx`and l.created_at <= ${context.end}` : tx``}
       order by l.created_at desc
       limit ${MAX_EXPORT_ROWS}
    `;
    return {
      columns: ["patientId", "givenName", "familyName", "dateOfBirth", "sex", "phone", "email", "registeredAt"],
      rows,
    };
  }
  if (dataset === "appointments") {
    const rows = await tx`
      select a.id, p.public_id as "patientId", a.start_at as "startAt", a.duration_minutes as "durationMinutes",
             a.status, ${context.includeSensitive ? tx`a.reason` : tx`null`} as reason
        from appointments a join patients p on p.id = a.patient_id
       where a.tenant_id = ${context.tenantId}
         ${context.start ? tx`and a.start_at >= ${context.start}` : tx``}
         ${context.end ? tx`and a.start_at <= ${context.end}` : tx``}
       order by a.start_at desc
       limit ${MAX_EXPORT_ROWS}
    `;
    return { columns: ["id", "patientId", "startAt", "durationMinutes", "status", "reason"], rows };
  }
  const rows = await tx`
    select i.number, i.status, i.currency, p.public_id as "patientId",
           d.name as department, u.name as unit,
           coalesce(sum(ii.amount), 0)::float8 as total,
           i.created_at as "createdAt"
      from invoices i
      join patients p on p.id = i.patient_id
      left join invoice_items ii on ii.invoice_id = i.id and ii.released_at is null
      left join departments d on d.id = i.department_id
      left join units u on u.id = i.unit_id
     where i.tenant_id = ${context.tenantId}
       ${context.departmentId ? tx`and i.department_id = ${context.departmentId}` : tx``}
       ${context.unitId ? tx`and i.unit_id = ${context.unitId}` : tx``}
       ${context.start ? tx`and i.created_at >= ${context.start}` : tx``}
       ${context.end ? tx`and i.created_at <= ${context.end}` : tx``}
     group by i.id, i.number, i.status, i.currency, p.public_id, d.name, u.name, i.created_at
     order by i.created_at desc
     limit ${MAX_EXPORT_ROWS}
  `;
  return { columns: ["number", "status", "currency", "patientId", "department", "unit", "total", "createdAt"], rows };
}

function renderExport(format: "csv" | "json", columns: string[], rows: Record<string, unknown>[]): string {
  if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
  return [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n") + "\r\n";
}

dataExchangeRoutes.post("/data/exports", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  await enforceRateLimit(c, "jobs.submit", auth.user.id);
  const body = await parseJson(c, exportSchema);
  const dataset = DATASETS[body.dataset];
  requirePermissions(c, dataset.exportPermissions, `Exporting ${dataset.label.toLowerCase()} is not permitted for your active role`);
  if (body.includeSensitive && !hasPermission(c, dataset.sensitiveExportPermission)) {
    throw new ForbiddenError("Sensitive fields require clinical record access; export them without sensitive fields instead");
  }
  const { start, end } = dateWindow(body.from, body.to);
  const config = c.get("deps").config;
  const tenantId = auth.activeTenant!.id;
  const tenantSlug = auth.activeTenant!.slug;
  const meta = auditMeta(c);
  const result = await withStaffActor(c, async (tx) => {
    const scope = await actorScope(tx, c);
    if (scope.kind !== "workspace" && !dataset.scoped) {
      throw new ForbiddenError("This dataset is facility-wide and is not available to a department or unit-scoped role");
    }
    let departmentId = body.departmentId ?? null;
    let unitId = body.unitId ?? null;
    if (scope.kind === "department") {
      departmentId = scope.departmentId;
      unitId = null;
    } else if (scope.kind === "unit") {
      departmentId = scope.departmentId;
      unitId = scope.unitId;
    } else {
      await assertDepartmentInScope(tx, c, departmentId, unitId);
    }
    const exportScope = unitId ? "unit" : departmentId ? "department" : "tenant";
    const { columns, rows } = await exportRows(tx, body.dataset, {
      tenantId, departmentId, unitId, scope: exportScope, includeSensitive: body.includeSensitive, start, end,
    });
    const content = renderExport(body.format, columns, rows);
    const token = randomToken(32);
    const jobId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_MINUTES * 60_000);
    await tx`
      insert into data_exchange_jobs (
        id, tenant_id, kind, dataset, format, scope, department_id, unit_id, status, requested_by,
        row_count, applied_count, error_count, errors, includes_sensitive, content, content_digest,
        download_token_hash, expires_at, completed_at
      ) values (
        ${jobId}, ${tenantId}, 'export', ${body.dataset}, ${body.format}, ${exportScope}, ${departmentId}, ${unitId}, 'completed', ${auth.user.id},
        ${rows.length}, ${rows.length}, 0, ${tx.json([] as never)}, ${body.includeSensitive}, ${content}, ${await sha256Hex(content)},
        ${await sha256Hex(token)}, ${expiresAt}, now()
      )
    `;
    await writeAudit(tx, config, requestAudit(c, "data.export", {
      resourceType: "DataExchangeJob", resourceId: jobId,
      metadata: {
        dataset: body.dataset, format: body.format, scope: exportScope, departmentId, unitId,
        rows: rows.length, includesSensitive: body.includeSensitive, from: body.from ?? null, to: body.to ?? null,
        purpose: body.purpose ?? null, contentDigest: await sha256Hex(content), ...meta,
      },
    }));
    return {
      id: jobId, dataset: body.dataset, format: body.format, scope: exportScope,
      rows: rows.length, includesSensitive: body.includeSensitive,
      expiresAt: expiresAt.toISOString(),
      downloadPath: `/api/v1/data/exchange/${jobId}/download?token=${token}`,
      filename: `${tenantSlug}-${body.dataset}-${new Date().toISOString().slice(0, 10)}.${body.format}`,
    };
  });
  return c.json({ ok: true, export: result }, 201);
});

dataExchangeRoutes.get("/data/exchange", async (c) => {
  requireStaff(c);
  const tenantId = c.get("auth")!.activeTenant!.id;
  const jobs = await withStaffActor(c, (tx) => tx`
    select j.id, j.kind, j.dataset, j.format, j.scope, j.status, j.row_count as "rowCount",
           j.applied_count as "appliedCount", j.error_count as "errorCount", j.includes_sensitive as "includesSensitive",
           j.expires_at as "expiresAt", j.created_at as "createdAt", j.completed_at as "completedAt",
           u.display_name as "requestedBy"
      from data_exchange_jobs j join users u on u.id = j.requested_by
     where j.tenant_id = ${tenantId}
     order by j.created_at desc limit 100
  `);
  return c.json({ jobs });
});

dataExchangeRoutes.get("/data/exchange/:id/download", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const jobId = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new ValidationError("Unknown export");
  const token = c.req.query("token") ?? "";
  if (!token) throw new ValidationError("A download token is required");
  const tenantId = auth.activeTenant!.id;
  const config = c.get("deps").config;
  const result = await withStaffActor(c, async (tx) => {
    const [job] = await tx`
      select id, requested_by, content, content_digest, download_token_hash, expires_at, dataset, format, includes_sensitive
        from data_exchange_jobs
       where id = ${jobId} and tenant_id = ${tenantId} and kind = 'export'
    `;
    if (!job) throw new NotFoundError("Export not found");
    if (String(job.requestedBy) !== auth.user.id && !withImpliedRoles(auth.activeTenant!.roles).includes("facility_admin")) {
      throw new ForbiddenError("Only the requester or a facility administrator may download this export");
    }
    if (!job.expiresAt || new Date(job.expiresAt as Date).getTime() < Date.now()) {
      throw new AppError(410, "export_expired", "This export has expired; create a new one");
    }
    if (String(job.downloadTokenHash) !== await sha256Hex(token)) throw new ForbiddenError("The download token is not valid");
    if (await sha256Hex(String(job.content ?? "")) !== String(job.contentDigest)) {
      throw new AppError(409, "export_integrity_failed", "The export content no longer matches its recorded digest; it will not be released");
    }
    await writeAudit(tx, config, requestAudit(c, "data.export.download", {
      resourceType: "DataExchangeJob", resourceId: jobId,
      metadata: { dataset: String(job.dataset), format: String(job.format), includesSensitive: Boolean(job.includesSensitive) },
    }));
    return { content: String(job.content ?? ""), format: String(job.format), dataset: String(job.dataset) };
  });
  const filename = `medveris-${result.dataset}-${jobId.slice(0, 8)}.${result.format}`;
  return new Response(result.content, {
    headers: {
      "content-type": result.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
});
