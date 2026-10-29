import type { Sql, Tx } from "@medveris/db";
import type { AppConfig } from "../config.js";
import { DicomwebClient, dicomwebConfigProblems, dicomwebFingerprint, isDicomUid, PacsError } from "./dicomweb.js";
import { IMPLEMENTED_ADAPTERS, type IntegrationId, type VerificationLookup, type VerificationRecord } from "./registry.js";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  /** Counts, statuses and timings only; never identifiers or demographics. */
  detail: string;
  durationMs: number;
}

export interface VerificationRun {
  outcome: "passed" | "failed";
  checks: VerificationCheck[];
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { record: VerificationRecord | null; expiresAt: number }>();

export function clearVerificationCache(): void {
  cache.clear();
}

async function cacheKey(config: AppConfig, id: IntegrationId): Promise<{ key: string; fingerprint: string }> {
  const fingerprint = await dicomwebFingerprint(config.dicomweb);
  return { key: `${id}|${config.appEnv}|${fingerprint}`, fingerprint };
}

function needsLookup(config: AppConfig, id: IntegrationId): boolean {
  return IMPLEMENTED_ADAPTERS.has(id) && Boolean(config.features[id]) && dicomwebConfigProblems(config).length === 0;
}

/**
 * Latest verification for each requested, configured adapter. A database failure is treated as "never
 * verified", so the integration fails closed instead of the request failing.
 */
export async function loadVerifications(sql: Sql | Tx, config: AppConfig): Promise<VerificationLookup> {
  const out: VerificationLookup = {};
  for (const id of IMPLEMENTED_ADAPTERS) {
    if (!needsLookup(config, id)) continue;
    const { key, fingerprint } = await cacheKey(config, id);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      out[id] = cached.record;
      continue;
    }
    try {
      const [row] = await sql`
        select outcome, finished_at, checks from integration_verifications
         where integration_id = ${id} and app_env = ${config.appEnv} and endpoint_fingerprint = ${fingerprint}
         order by finished_at desc limit 1
      `;
      const record: VerificationRecord | null = row ? {
        outcome: row.outcome === "passed" ? "passed" : "failed",
        finishedAt: new Date(row.finishedAt as string).toISOString(),
        failure: ((row.checks as VerificationCheck[] | null) ?? []).find((check) => !check.passed)?.detail ?? null,
      } : null;
      cache.set(key, { record, expiresAt: Date.now() + CACHE_TTL_MS });
      out[id] = record;
    } catch {
      out[id] = null;
    }
  }
  return out;
}

export async function recordVerification(tx: Tx, config: AppConfig, id: IntegrationId, run: VerificationRun, runBy: string, startedAt: Date): Promise<string> {
  const { key, fingerprint } = await cacheKey(config, id);
  const recordId = crypto.randomUUID();
  await tx`
    insert into integration_verifications (id, integration_id, app_env, endpoint_fingerprint, outcome, checks, run_by, started_at)
    values (${recordId}, ${id}, ${config.appEnv}, ${fingerprint}, ${run.outcome}, ${tx.json(run.checks as never)}, ${runBy}, ${startedAt})
  `;
  cache.delete(key);
  return recordId;
}

function isRenderedImage(body: ArrayBuffer): boolean {
  const bytes = new Uint8Array(body.slice(0, 8));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return jpeg || png;
}

function failureDetail(error: unknown): string {
  if (error instanceof PacsError) return `${error.failure}${error.upstreamStatus ? ` (HTTP ${error.upstreamStatus})` : ""}: ${error.message}`;
  return error instanceof Error ? error.message : "unexpected failure";
}

/**
 * QIDO-RS and WADO-RS conformance against the configured PACS, run from the same runtime that serves
 * users so it also proves network reachability. Stops at the first failed step; later steps depend on it.
 */
export async function runDicomwebVerification(config: AppConfig, configured: DicomwebClient | null, sampleStudyInstanceUid?: string): Promise<VerificationRun> {
  const checks: VerificationCheck[] = [];
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, passed: true, detail, durationMs: Date.now() - started });
      return true;
    } catch (error) {
      checks.push({ name, passed: false, detail: failureDetail(error), durationMs: Date.now() - started });
      return false;
    }
  };
  const done = (): VerificationRun => ({ outcome: checks.every((check) => check.passed) ? "passed" : "failed", checks });

  const problems = dicomwebConfigProblems(config);
  if (!(await step("configuration", async () => {
    if (problems.length) throw new Error(problems.join("; "));
    if (!configured) throw new Error("no DICOMweb client could be created");
    return `endpoint configured with ${config.dicomweb.auth} authentication`;
  }))) return done();
  const client = configured!;

  if (!(await step("credentials-required", async () => {
    if (config.dicomweb.auth === "none") return "skipped: unauthenticated PACS allowed only in local development and tests";
    const status = await client.unauthenticatedProbe();
    if (status === 401 || status === 403) return `unauthenticated search refused with HTTP ${status}`;
    throw new Error(`the PACS answered an unauthenticated search with HTTP ${status}; it must require credentials`);
  }))) return done();

  let studyUid: string | null = null;
  if (!(await step("qido-rs-studies", async () => {
    if (sampleStudyInstanceUid !== undefined && !isDicomUid(sampleStudyInstanceUid)) throw new Error("the sample Study Instance UID is not a valid DICOM UID");
    const studies = sampleStudyInstanceUid
      ? await client.searchStudies({ studyInstanceUid: sampleStudyInstanceUid, limit: 1 })
      : await client.searchStudies({ limit: 5 });
    if (!studies.length) throw new Error(sampleStudyInstanceUid ? "the sample study was not found" : "the PACS returned no studies, so retrieval cannot be verified; give a sample study");
    studyUid = studies[0]!.studyInstanceUid;
    return `${studies.length} study result(s) parsed as DICOM JSON`;
  }))) return done();

  let seriesUid: string | null = null;
  if (!(await step("qido-rs-series", async () => {
    const series = await client.searchSeries(studyUid!);
    if (!series.length) throw new Error("the sample study has no series");
    seriesUid = series[0]!.seriesInstanceUid;
    return `${series.length} series`;
  }))) return done();

  let instanceUid: string | null = null;
  if (!(await step("qido-rs-instances", async () => {
    const instances = await client.searchInstances(studyUid!, seriesUid!);
    if (!instances.length) throw new Error("the first series has no instances");
    instanceUid = instances[0]!.sopInstanceUid;
    return `${instances.length} instance(s)`;
  }))) return done();

  await step("wado-rs-rendered", async () => {
    const image = await client.renderFrame(studyUid!, seriesUid!, instanceUid!, 1, { viewport: 256 });
    if (!isRenderedImage(image.body)) throw new Error(`the rendered frame is not a valid ${image.contentType} image`);
    return `${image.contentType}, ${image.body.byteLength} bytes`;
  });
  return done();
}
