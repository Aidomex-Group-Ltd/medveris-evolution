import { Hono } from "hono";
import { reportQuerySchema } from "@medveris/contracts";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit } from "../lib/actor.js";
import { writeAudit } from "../lib/audit.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { parseQuery } from "../lib/http.js";
import { REPORTS, reportById, type ReportDefinition } from "../reports/definitions.js";
import type { AppEnv } from "../types.js";

export const reportRoutes = new Hono<AppEnv>();

const MAX_RANGE_DAYS = 366;
const DEFINITION_VERSION = "medveris-reports-1";

function allowed(report: ReportDefinition, roles: readonly string[]): boolean {
  return report.roles.some((role) => roles.includes(role));
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Spreadsheet formula injection guard: cells starting with = + - @ or control characters are prefixed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

reportRoutes.get("/reports", (c) => {
  requireStaff(c);
  const roles = requestActor(c).roles;
  return c.json({
    reports: REPORTS.filter((report) => allowed(report, roles)).map(({ run: _run, ...report }) => report),
    definitionVersion: DEFINITION_VERSION,
  });
});

reportRoutes.get("/reports/:id", async (c) => {
  requireStaff(c);
  const report = reportById(c.req.param("id"));
  if (!report) throw new NotFoundError("Report not found");
  const roles = requestActor(c).roles;
  if (!allowed(report, roles)) throw new ForbiddenError("Your active role cannot run this report");
  const query = parseQuery(c, reportQuerySchema);
  if (!validTimeZone(query.timeZone)) throw new ValidationError("Unknown time zone");
  const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000;
  if (days < 0) throw new ValidationError("The start date must be on or before the end date");
  if (days >= MAX_RANGE_DAYS) throw new ValidationError(`Reports cover at most ${MAX_RANGE_DAYS} days`);
  const auth = c.get("auth")!;
  const config = c.get("deps").config;
  const generatedAt = new Date();
  const result = await withStaffActor(c, async (tx) => {
    const [range] = await tx`
      select ((${query.from}::date)::timestamp at time zone ${query.timeZone}) as start_at,
             ((${query.to}::date + 1)::timestamp at time zone ${query.timeZone}) as end_at
    `;
    const output = await report.run(tx, {
      tenantId: auth.activeTenant!.id, from: query.from, to: query.to, timeZone: query.timeZone,
      startAt: range!.startAt as Date, endAt: range!.endAt as Date,
      params: query.expiryWindowDays ? { expiryWindowDays: query.expiryWindowDays } : {},
    }, config);
    if (report.sensitive || query.format === "csv") {
      await writeAudit(tx, config, requestAudit(c, query.format === "csv" ? "report.export" : "report.view", {
        resourceType: "Report", resourceId: null,
        metadata: { report: report.id, from: query.from, to: query.to, timeZone: query.timeZone, rows: output.rows.length, format: query.format },
      }));
    }
    return output;
  });
  const metadata = {
    report: report.id, title: report.title, definitionVersion: DEFINITION_VERSION,
    facility: auth.activeTenant!.name, from: query.from, to: query.to, timeZone: query.timeZone,
    generatedAt: generatedAt.toISOString(), generatedBy: auth.user.displayName,
  };
  if (query.format === "csv") {
    const lines = [
      [`# ${report.title}`, `${metadata.facility}`, `${query.from} to ${query.to} (${query.timeZone})`, `generated ${metadata.generatedAt} by ${metadata.generatedBy}`].map(csvCell).join(","),
      report.columns.map((column) => csvCell(column.label)).join(","),
      ...result.rows.map((row) => report.columns.map((column) => csvCell(row[column.key])).join(",")),
      ...result.summary.map((item) => [csvCell(item.label), csvCell(item.value), csvCell(item.definition)].join(",")),
    ];
    return new Response(`${lines.join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${report.id}-${query.from}-${query.to}.csv"`,
        "cache-control": "no-store, private",
      },
    });
  }
  return c.json({ metadata, columns: report.columns, definitions: report.definitions, ...result });
});
