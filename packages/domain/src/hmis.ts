/**
 * HMIS aggregate reporting helpers: Medveris source metrics, DHIS2 period identifiers and reporting
 * schedule arithmetic. Which DHIS2 data elements a metric feeds is facility configuration approved
 * against the Ministry's current forms; nothing here asserts an official mapping.
 */

import { DomainError } from "./errors.js";

export const HMIS_AGE_BANDS = ["0-28d", "29d-4y", "5-9y", "10-19y", "20y+"] as const;
export type HmisAgeBand = (typeof HMIS_AGE_BANDS)[number];
export const HMIS_SEXES = ["female", "male", "other", "unknown"] as const;

export interface HmisMetric {
  code: string;
  label: string;
  definition: string;
  disaggregations: Array<"sex" | "age">;
}

export const HMIS_METRICS: readonly HmisMetric[] = Object.freeze([
  {
    code: "opd.new-attendance", label: "OPD new attendances", disaggregations: ["sex", "age"],
    definition: "Encounters opened in the period that are the patient's first encounter at this facility in the calendar year. Confirm this matches the HMIS 105 definition before approving a mapping.",
  },
  {
    code: "opd.re-attendance", label: "OPD re-attendances", disaggregations: ["sex", "age"],
    definition: "Encounters opened in the period for patients already seen at this facility earlier in the calendar year.",
  },
  { code: "ipd.admissions", label: "Admissions", disaggregations: ["sex"], definition: "Admissions recorded in the period, excluding cancelled admissions." },
  { code: "ipd.discharges", label: "Discharges (alive)", disaggregations: ["sex"], definition: "Admissions discharged or transferred out in the period." },
  { code: "ipd.deaths", label: "Inpatient deaths", disaggregations: ["sex"], definition: "Admissions closed as deceased in the period." },
  { code: "maternity.deliveries", label: "Deliveries", disaggregations: [], definition: "Maternity episodes with a delivery time in the period." },
  { code: "lab.tests-resulted", label: "Laboratory tests resulted", disaggregations: ["sex"], definition: "Laboratory order items with a result, by order update time in the period." },
  { code: "imaging.examinations-resulted", label: "Imaging examinations resulted", disaggregations: ["sex"], definition: "Imaging order items with a result, by order update time in the period." },
]);

export function hmisMetric(code: string): HmisMetric {
  const found = HMIS_METRICS.find((metric) => metric.code === code);
  if (!found) throw new DomainError(`Unknown HMIS source metric ${code}`);
  return found;
}

export type PeriodType = "Weekly" | "Monthly" | "Quarterly";

export interface ParsedPeriod {
  period: string;
  periodType: PeriodType;
  start: string;
  end: string;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO week 1 contains 4 January; DHIS2 weekly periods use the same numbering (yyyyWn). */
function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1) * 7);
  return monday;
}

/** Parses a DHIS2 period identifier for the given period type and returns its inclusive date range. */
export function parsePeriod(period: string, periodType: PeriodType): ParsedPeriod {
  if (periodType === "Monthly") {
    const match = /^(\d{4})(\d{2})$/.exec(period);
    const month = Number(match?.[2]);
    if (!match || month < 1 || month > 12) throw new DomainError("Monthly periods are written yyyyMM, e.g. 202610");
    const year = Number(match[1]);
    return { period, periodType, start: iso(new Date(Date.UTC(year, month - 1, 1))), end: iso(new Date(Date.UTC(year, month, 0))) };
  }
  if (periodType === "Quarterly") {
    const match = /^(\d{4})Q([1-4])$/.exec(period);
    if (!match) throw new DomainError("Quarterly periods are written yyyyQn, e.g. 2026Q3");
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    return { period, periodType, start: iso(new Date(Date.UTC(year, (quarter - 1) * 3, 1))), end: iso(new Date(Date.UTC(year, quarter * 3, 0))) };
  }
  const match = /^(\d{4})W(\d{1,2})$/.exec(period);
  const week = Number(match?.[2]);
  if (!match || week < 1 || week > 53) throw new DomainError("Weekly periods are written yyyyWn, e.g. 2026W43");
  const start = isoWeekStart(Number(match[1]), week);
  if (week === 53 && isoWeekStart(Number(match[1]) + 1, 1).getTime() <= start.getTime()) throw new DomainError(`${match[1]} has no week 53`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { period, periodType, start: iso(start), end: iso(end) };
}

export interface ReportingRule {
  submissionDueDay: number;
  validationStartDay: number;
  validationEndDay: number;
  lockAfterDay: number;
  source: string;
  verifiedOn: string;
}

export interface PeriodSchedule {
  submissionDue: string;
  validationStart: string;
  validationEnd: string;
  lockedAfter: string;
  /** Where today falls relative to the schedule. */
  phase: "open" | "due" | "validation" | "locked";
}

/** Deadlines in the month after the period ends, from a configurable rule. */
export function periodSchedule(parsed: ParsedPeriod, rule: ReportingRule, today: string): PeriodSchedule {
  const end = new Date(`${parsed.end}T00:00:00Z`);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() + 1;
  const day = (value: number) => iso(new Date(Date.UTC(year, month, value)));
  const schedule = {
    submissionDue: day(rule.submissionDueDay),
    validationStart: day(rule.validationStartDay),
    validationEnd: day(rule.validationEndDay),
    lockedAfter: day(rule.lockAfterDay),
  };
  const phase = today <= parsed.end ? "open" : today <= schedule.submissionDue ? "due" : today <= schedule.lockedAfter ? "validation" : "locked";
  return { ...schedule, phase };
}

/** The period that most recently ended for a period type, as of `today` (yyyy-mm-dd). */
export function previousPeriod(periodType: PeriodType, today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  if (periodType === "Monthly") {
    const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
    return `${previous.getUTCFullYear()}${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (periodType === "Quarterly") {
    const quarter = Math.floor(date.getUTCMonth() / 3);
    return quarter === 0 ? `${date.getUTCFullYear() - 1}Q4` : `${date.getUTCFullYear()}Q${quarter}`;
  }
  const lastWeek = new Date(date);
  lastWeek.setUTCDate(date.getUTCDate() - 7);
  const thursday = new Date(lastWeek);
  thursday.setUTCDate(lastWeek.getUTCDate() + 3 - ((lastWeek.getUTCDay() + 6) % 7));
  const weekYear = thursday.getUTCFullYear();
  const week = Math.round((thursday.getTime() - isoWeekStart(weekYear, 1).getTime()) / (7 * 86_400_000)) + 1;
  return `${weekYear}W${week}`;
}
