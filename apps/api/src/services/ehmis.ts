import { decryptSecret, encryptSecret } from "@medveris/auth";
import type { Tx } from "@medveris/db";
import { canonicalJson, parsePeriod, periodSchedule, sha256Hex, type ParsedPeriod, type PeriodType, type ReportingRule } from "@medveris/domain";
import type { AppConfig } from "../config.js";
import { baseUrlProblems, type DataValueSet, type Dhis2Credentials } from "../integrations/dhis2.js";
import { integrationStatus } from "../integrations/registry.js";

export interface MappingElement {
  metric: string;
  sex: string;
  ageBand: string;
  dataElementUid: string;
  categoryOptionComboUid: string;
  label?: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
}

export interface ComputedValue {
  dataElement: string;
  categoryOptionCombo: string;
  value: number;
  metric: string;
  sex: string;
  ageBand: string;
  label: string | null;
}

/** Credentials are encrypted together with the facility ID, so a ciphertext copied to another facility will not decrypt for it. */
export async function encryptCredentials(config: AppConfig, tenantId: string, credentials: Dhis2Credentials): Promise<string> {
  if (!config.ehmis.credentialsKey) throw new Error("EHMIS_CREDENTIALS_KEY is not configured");
  return encryptSecret(`${tenantId}\n${JSON.stringify(credentials)}`, config.ehmis.credentialsKey);
}

export async function decryptCredentials(config: AppConfig, tenantId: string, ciphertext: string): Promise<Dhis2Credentials> {
  if (!config.ehmis.credentialsKey) throw new Error("EHMIS_CREDENTIALS_KEY is not configured");
  const plaintext = await decryptSecret(ciphertext, config.ehmis.credentialsKey);
  const separator = plaintext.indexOf("\n");
  if (separator < 0 || plaintext.slice(0, separator) !== tenantId) throw new Error("The stored credentials do not belong to this facility");
  return JSON.parse(plaintext.slice(separator + 1)) as Dhis2Credentials;
}

export function credentialHint(credentials: Dhis2Credentials): string {
  return credentials.kind === "basic" ? `user ${credentials.username}` : `token …${credentials.token.slice(-4)}`;
}

export async function connectionFingerprint(row: { dhis2BaseUrl?: unknown; dhis2OrgUnitUid?: unknown; credentialSetAt?: unknown }): Promise<string> {
  const setAt = row.credentialSetAt ? new Date(row.credentialSetAt as string).toISOString() : "";
  return sha256Hex(`${String(row.dhis2BaseUrl ?? "")}|${String(row.dhis2OrgUnitUid ?? "")}|${setAt}`);
}

export async function loadIntegration(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  const [row] = await tx`select * from hmis_integrations where tenant_id = ${tenantId}`;
  return row ?? { tenantId, eligibilityStatus: "not-assessed", connectionStatus: "not-tested", liveSubmissionEnabled: false, authorizationScope: "aggregate" };
}

/** Public shape of the facility integration; never includes the credential ciphertext. */
export function publicIntegration(row: Record<string, unknown>) {
  const { credentialCiphertext: _secret, connectionFingerprint: _fingerprint, ...rest } = row;
  return { ...rest, credentialsStored: Boolean(row.credentialKind) };
}

export interface Readiness {
  ready: boolean;
  problems: string[];
}

/** Everything that must hold before Medveris sends this facility's data to DHIS2. */
export async function liveReadiness(config: AppConfig, row: Record<string, unknown>, today: string): Promise<Readiness> {
  const problems: string[] = [];
  const environment = integrationStatus(config, "ehmis");
  if (environment.state !== "available") problems.push(`Deployment: ${environment.reason}`);
  if (row.eligibilityStatus !== "verified") problems.push("The facility's eligibility and Ministry authorization have not been verified by a platform operator");
  if (row.authorizationValidUntil && String(row.authorizationValidUntil).slice(0, 10) < today) problems.push("The recorded Ministry authorization has expired");
  if (!row.dhis2OrgUnitUid) problems.push("No DHIS2 organisation unit is mapped for this facility");
  problems.push(...baseUrlProblems((row.dhis2BaseUrl as string | null) ?? null, config.ehmis, config.appEnv));
  if (!row.credentialKind) problems.push("No DHIS2 credentials are stored for this facility");
  if (row.connectionStatus !== "verified") problems.push("The DHIS2 connection has not passed a test");
  else if (row.connectionFingerprint !== await connectionFingerprint(row)) problems.push("The DHIS2 settings changed after the last connection test; test again");
  if (!row.liveSubmissionEnabled) problems.push("Live submission is switched off for this facility");
  return { ready: problems.length === 0, problems };
}

export async function effectiveRule(tx: Tx, tenantId: string, periodType: PeriodType): Promise<(ReportingRule & { scope: "facility" | "platform" }) | null> {
  const rows = await tx`
    select tenant_id, submission_due_day, validation_start_day, validation_end_day, lock_after_day, source, to_char(verified_on, 'YYYY-MM-DD') as verified_on
      from hmis_reporting_rules where period_type = ${periodType} and (tenant_id = ${tenantId} or tenant_id is null)
     order by tenant_id nulls last limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    scope: row.tenantId ? "facility" : "platform",
    submissionDueDay: Number(row.submissionDueDay), validationStartDay: Number(row.validationStartDay),
    validationEndDay: Number(row.validationEndDay), lockAfterDay: Number(row.lockAfterDay),
    source: String(row.source), verifiedOn: String(row.verifiedOn),
  };
}

export function schedule(parsed: ParsedPeriod, rule: ReportingRule | null, today: string) {
  return rule ? periodSchedule(parsed, rule, today) : null;
}

/** Values for each mapped element from the facility's own aggregate source metrics. */
export async function computeValues(tx: Tx, tenantId: string, elements: MappingElement[], parsed: ParsedPeriod): Promise<ComputedValue[]> {
  const rows = await tx`select metric, sex, age_band, value from app.hmis_source_metrics(${tenantId}, ${parsed.start}::date, ${parsed.end}::date)`;
  const lookup = new Map(rows.map((row) => [`${row.metric}|${row.sex}|${row.ageBand}`, Number(row.value)]));
  return elements.map((element) => ({
    dataElement: element.dataElementUid,
    categoryOptionCombo: element.categoryOptionComboUid,
    value: lookup.get(`${element.metric}|${element.sex}|${element.ageBand}`) ?? 0,
    metric: element.metric,
    sex: element.sex,
    ageBand: element.ageBand,
    label: element.label || null,
  }));
}

export function validate(input: {
  values: ComputedValue[];
  parsed: ParsedPeriod;
  today: string;
  orgUnit: string | null;
  mappingApproved: boolean;
  scheduleInfo: ReturnType<typeof schedule>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.parsed.end >= input.today) issues.push({ severity: "error", message: `The period ends on ${input.parsed.end}; it can be reported once it has ended` });
  if (!input.orgUnit) issues.push({ severity: "error", message: "No DHIS2 organisation unit is mapped for this facility" });
  if (!input.mappingApproved) issues.push({ severity: "error", message: "The dataset mapping has not been approved" });
  const seen = new Set<string>();
  for (const value of input.values) {
    const key = `${value.dataElement}|${value.categoryOptionCombo}`;
    if (seen.has(key)) issues.push({ severity: "error", message: `Data element ${value.dataElement} / ${value.categoryOptionCombo} is mapped more than once` });
    seen.add(key);
    if (!Number.isInteger(value.value) || value.value < 0) issues.push({ severity: "error", message: `${value.label ?? value.dataElement} is not a non-negative whole number` });
  }
  if (input.values.every((value) => value.value === 0)) issues.push({ severity: "warning", message: "Every value is zero; confirm that the facility recorded its activity in Medveris for this period" });
  if (input.scheduleInfo?.phase === "locked") issues.push({ severity: "warning", message: `eHMIS is normally locked for this period after ${input.scheduleInfo.lockedAfter}; a late submission may need district approval` });
  return issues;
}

export function dataValueSet(input: { dataSetUid: string; period: string; orgUnit: string; attributeOptionCombo: string | null; values: ComputedValue[]; completedDate: string }): DataValueSet {
  return {
    dataSet: input.dataSetUid,
    period: input.period,
    orgUnit: input.orgUnit,
    ...(input.attributeOptionCombo ? { attributeOptionCombo: input.attributeOptionCombo } : {}),
    completedDate: input.completedDate,
    dataValues: input.values.map((value) => ({ dataElement: value.dataElement, categoryOptionCombo: value.categoryOptionCombo, value: String(value.value) })),
  };
}

export async function payloadDigest(payload: DataValueSet): Promise<string> {
  const { completedDate: _completed, ...stable } = payload;
  return sha256Hex(canonicalJson(stable));
}

export function idempotencyKey(input: { tenantId: string; dataSetUid: string; orgUnit: string; period: string; revision: number }): string {
  return `${input.tenantId}:${input.dataSetUid}:${input.orgUnit || "unmapped"}:${input.period}:r${input.revision}`;
}

export function periodDates(period: string, periodType: PeriodType): ParsedPeriod {
  return parsePeriod(period, periodType);
}

export function dhis2Csv(payload: DataValueSet): string {
  const header = "dataelement,period,orgunit,categoryoptioncombo,attributeoptioncombo,value";
  const rows = payload.dataValues.map((value) => [value.dataElement, payload.period, payload.orgUnit, value.categoryOptionCombo, payload.attributeOptionCombo ?? "", value.value].join(","));
  return `${[header, ...rows].join("\r\n")}\r\n`;
}
