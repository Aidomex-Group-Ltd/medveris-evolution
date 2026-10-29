import type { AppConfig, DicomwebConfig } from "../config.js";
import { AppError } from "../lib/errors.js";

/**
 * DICOMweb adapter for an existing PACS: QIDO-RS search and WADO-RS rendered retrieval only.
 * Medveris stores no pixel data. Every request is built from UIDs validated here, so no caller
 * input reaches the PACS URL unchecked.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LOCAL_ENVIRONMENTS = new Set(["development", "test"]);
const UID = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+$/;
const RENDERED_TYPES = ["image/jpeg", "image/png"] as const;

export function isDicomUid(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && UID.test(value);
}

/** Configuration problems that keep the PACS unavailable; empty when the connection is fully described. */
export function dicomwebConfigProblems(config: Pick<AppConfig, "appEnv" | "dicomweb">): string[] {
  const settings = config.dicomweb;
  const problems: string[] = [];
  if (!settings.baseUrl) {
    problems.push("DICOMWEB_BASE_URL is not set");
  } else {
    let url: URL | null = null;
    try {
      url = new URL(settings.baseUrl);
    } catch {
      problems.push("DICOMWEB_BASE_URL is not an absolute URL");
    }
    if (url) {
      if (url.username || url.password) problems.push("DICOMWEB_BASE_URL must not embed credentials; use DICOMWEB_USERNAME and DICOMWEB_PASSWORD");
      if (url.search || url.hash) problems.push("DICOMWEB_BASE_URL must not contain a query or fragment");
      if (url.protocol !== "https:" && !(LOCAL_ENVIRONMENTS.has(config.appEnv) && url.protocol === "http:")) {
        problems.push("DICOMWEB_BASE_URL must use HTTPS outside local development and tests");
      }
    }
  }
  if (settings.auth === "basic" && (!settings.username || !settings.password)) problems.push("DICOMWEB_AUTH=basic requires DICOMWEB_USERNAME and DICOMWEB_PASSWORD");
  if (settings.auth === "bearer" && !settings.bearerToken) problems.push("DICOMWEB_AUTH=bearer requires DICOMWEB_BEARER_TOKEN");
  if (settings.auth === "none" && !LOCAL_ENVIRONMENTS.has(config.appEnv)) problems.push("DICOMWEB_AUTH must be basic or bearer outside local development and tests");
  return problems;
}

/** Identifies the configured endpoint and principal, so a verification run only covers the PACS it tested. */
export async function dicomwebFingerprint(settings: DicomwebConfig): Promise<string> {
  const material = `${settings.baseUrl ?? ""}|${settings.auth}|${settings.auth === "basic" ? settings.username ?? "" : ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- DICOM JSON

type DicomAttribute = { vr?: string; Value?: unknown[] };
export type DicomDataset = Record<string, DicomAttribute | undefined>;

const TAG = {
  studyInstanceUid: "0020000D",
  seriesInstanceUid: "0020000E",
  sopInstanceUid: "00080018",
  sopClassUid: "00080016",
  accession: "00080050",
  studyDate: "00080020",
  studyTime: "00080030",
  studyDescription: "00081030",
  modalitiesInStudy: "00080061",
  modality: "00080060",
  patientName: "00100010",
  patientId: "00100020",
  patientBirthDate: "00100030",
  patientSex: "00100040",
  studySeriesCount: "00201206",
  studyInstanceCount: "00201208",
  seriesNumber: "00200011",
  seriesDescription: "0008103E",
  seriesInstanceCount: "00201209",
  bodyPart: "00180015",
  instanceNumber: "00200013",
  numberOfFrames: "00280008",
  rows: "00280010",
  columns: "00280011",
} as const;

function first(dataset: DicomDataset, tag: string): unknown {
  return dataset[tag]?.Value?.[0];
}

function text(dataset: DicomDataset, tag: string): string | null {
  const value = first(dataset, tag);
  if (value == null) return null;
  if (typeof value === "object") {
    const name = (value as { Alphabetic?: unknown }).Alphabetic;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  }
  const out = String(value).trim();
  return out || null;
}

function texts(dataset: DicomDataset, tag: string): string[] {
  return (dataset[tag]?.Value ?? []).map((value) => String(value).trim()).filter(Boolean);
}

function count(dataset: DicomDataset, tag: string): number | null {
  const value = Number(first(dataset, tag));
  return Number.isFinite(value) ? value : null;
}

/** DICOM DA (YYYYMMDD) to ISO date; anything else is dropped rather than guessed. */
function isoDate(value: string | null): string | null {
  const match = value ? /^(\d{4})(\d{2})(\d{2})$/.exec(value) : null;
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export interface PacsPatient {
  name: string | null;
  familyName: string | null;
  givenName: string | null;
  patientId: string | null;
  birthDate: string | null;
  sex: string | null;
}

export interface PacsStudy {
  studyInstanceUid: string;
  accession: string | null;
  studyDate: string | null;
  studyTime: string | null;
  description: string | null;
  modalities: string[];
  seriesCount: number | null;
  instanceCount: number | null;
  patient: PacsPatient;
}

export interface PacsSeries {
  seriesInstanceUid: string;
  modality: string | null;
  seriesNumber: number | null;
  description: string | null;
  bodyPart: string | null;
  instanceCount: number | null;
}

export interface PacsInstance {
  sopInstanceUid: string;
  sopClassUid: string | null;
  instanceNumber: number | null;
  frames: number;
  rows: number | null;
  columns: number | null;
}

function patientOf(dataset: DicomDataset): PacsPatient {
  const name = text(dataset, TAG.patientName);
  const [family, given] = (name ?? "").split("^");
  return {
    name: name ? name.replace(/\^+/g, " ").trim() : null,
    familyName: family?.trim() || null,
    givenName: given?.trim() || null,
    patientId: text(dataset, TAG.patientId),
    birthDate: isoDate(text(dataset, TAG.patientBirthDate)),
    sex: text(dataset, TAG.patientSex),
  };
}

export function parseStudy(dataset: DicomDataset): PacsStudy | null {
  const uid = text(dataset, TAG.studyInstanceUid);
  if (!isDicomUid(uid)) return null;
  return {
    studyInstanceUid: uid,
    accession: text(dataset, TAG.accession),
    studyDate: isoDate(text(dataset, TAG.studyDate)),
    studyTime: text(dataset, TAG.studyTime),
    description: text(dataset, TAG.studyDescription),
    modalities: texts(dataset, TAG.modalitiesInStudy),
    seriesCount: count(dataset, TAG.studySeriesCount),
    instanceCount: count(dataset, TAG.studyInstanceCount),
    patient: patientOf(dataset),
  };
}

export function parseSeries(dataset: DicomDataset): PacsSeries | null {
  const uid = text(dataset, TAG.seriesInstanceUid);
  if (!isDicomUid(uid)) return null;
  return {
    seriesInstanceUid: uid,
    modality: text(dataset, TAG.modality),
    seriesNumber: count(dataset, TAG.seriesNumber),
    description: text(dataset, TAG.seriesDescription),
    bodyPart: text(dataset, TAG.bodyPart),
    instanceCount: count(dataset, TAG.seriesInstanceCount),
  };
}

export function parseInstance(dataset: DicomDataset): PacsInstance | null {
  const uid = text(dataset, TAG.sopInstanceUid);
  if (!isDicomUid(uid)) return null;
  return {
    sopInstanceUid: uid,
    sopClassUid: text(dataset, TAG.sopClassUid),
    instanceNumber: count(dataset, TAG.instanceNumber),
    frames: Math.max(1, count(dataset, TAG.numberOfFrames) ?? 1),
    rows: count(dataset, TAG.rows),
    columns: count(dataset, TAG.columns),
  };
}

// ---------------------------------------------------------------- identity check

function normalizedName(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}

export interface IdentityComparison {
  familyName: "match" | "mismatch" | "missing";
  givenName: "match" | "mismatch" | "missing";
  birthDate: "match" | "mismatch" | "missing";
  sex: "match" | "mismatch" | "missing";
  /** Family name and date of birth both match; anything less needs a recorded override. */
  confirmed: boolean;
}

/** Compares PACS demographics with the Medveris patient; never decides a link on its own. */
export function compareIdentity(
  pacs: PacsPatient,
  patient: { familyName: string; givenName: string; dateOfBirth: string | null; sex: string | null },
): IdentityComparison {
  const nameCheck = (left: string | null, right: string) => {
    const a = normalizedName(left);
    const b = normalizedName(right);
    if (!a || !b) return "missing" as const;
    return a === b ? "match" as const : "mismatch" as const;
  };
  const familyName = nameCheck(pacs.familyName, patient.familyName);
  const givenName = nameCheck(pacs.givenName, patient.givenName);
  const birthDate = !pacs.birthDate || !patient.dateOfBirth ? "missing" : pacs.birthDate === patient.dateOfBirth ? "match" : "mismatch";
  const pacsSex = (pacs.sex ?? "").toUpperCase();
  const ourSex = (patient.sex ?? "").toLowerCase();
  const expected = ourSex === "female" ? "F" : ourSex === "male" ? "M" : ourSex === "other" ? "O" : "";
  const sex = !pacsSex || !expected ? "missing" : pacsSex === expected ? "match" : "mismatch";
  return { familyName, givenName, birthDate, sex, confirmed: familyName === "match" && birthDate === "match" };
}

// ---------------------------------------------------------------- client

export type PacsFailure = "timeout" | "unreachable" | "unauthorized" | "not-found" | "rejected" | "bad-response" | "upstream";

export class PacsError extends AppError {
  readonly failure: PacsFailure;
  readonly upstreamStatus: number | null;
  constructor(failure: PacsFailure, message: string, upstreamStatus: number | null = null) {
    const status = failure === "not-found" ? 404 : failure === "rejected" ? 422 : failure === "timeout" ? 504 : 502;
    super(status, failure === "not-found" ? "pacs_not_found" : failure === "rejected" ? "pacs_rejected" : "pacs_unavailable", message, {
      integration: "dicomweb",
      failure,
      upstreamStatus,
      retryable: failure === "timeout" || failure === "unreachable" || failure === "upstream",
    });
    this.failure = failure;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface StudySearch {
  accession?: string;
  patientId?: string;
  studyInstanceUid?: string;
  /** Inclusive ISO dates. */
  fromDate?: string;
  toDate?: string;
  modality?: string;
  limit: number;
}

export interface RenderOptions {
  /** Bounding box in pixels; the PACS scales the image to fit, so leave unset for native resolution. */
  viewport?: number;
  /** Window centre and width in stored-value units, applied by the PACS (PS3.18 rendered parameters). */
  window?: { center: number; width: number };
  accept?: "image/jpeg" | "image/png";
}

export interface RenderedImage {
  body: ArrayBuffer;
  contentType: string;
}

const STUDY_FIELDS = [TAG.studyDescription, TAG.modalitiesInStudy, TAG.studySeriesCount, TAG.studyInstanceCount, TAG.patientBirthDate, TAG.patientSex];
const SERIES_FIELDS = [TAG.seriesDescription, TAG.seriesInstanceCount, TAG.bodyPart];
const INSTANCE_FIELDS = [TAG.numberOfFrames, TAG.rows, TAG.columns];

function dicomDate(iso: string): string {
  return iso.replace(/-/g, "");
}

/** Values placed into QIDO matching keys; wildcard characters are rejected so a search cannot widen itself. */
function matchingValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || /[*?\\\u0000-\u001f]/.test(trimmed)) throw new AppError(422, "validation_error", `${label} is not a valid DICOM matching value`);
  return trimmed;
}

export class DicomwebClient {
  private readonly settings: DicomwebConfig;
  private readonly fetcher: FetchLike;

  constructor(settings: DicomwebConfig, fetcher: FetchLike = (input, init) => fetch(input, init)) {
    if (!settings.baseUrl) throw new Error("DicomwebClient requires a base URL");
    this.settings = settings;
    this.fetcher = fetcher;
  }

  private headers(accept: string, authenticated: boolean): Headers {
    const headers = new Headers({ accept });
    if (!authenticated) return headers;
    if (this.settings.auth === "basic") {
      headers.set("authorization", `Basic ${btoa(`${this.settings.username}:${this.settings.password}`)}`);
    } else if (this.settings.auth === "bearer") {
      headers.set("authorization", `Bearer ${this.settings.bearerToken}`);
    }
    return headers;
  }

  private async request(path: string, accept: string, authenticated = true): Promise<Response> {
    const url = `${this.settings.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: this.headers(accept, authenticated),
        redirect: "manual",
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new PacsError("timeout", `The PACS did not answer within ${this.settings.timeoutMs} ms`);
      throw new PacsError("unreachable", "The PACS could not be reached");
    }
    return response;
  }

  private async checked(path: string, accept: string): Promise<Response> {
    const response = await this.request(path, accept);
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new PacsError("unauthorized", "The PACS rejected the configured credentials", response.status);
    if (response.status === 404) throw new PacsError("not-found", "The PACS has no such study, series or image", 404);
    if (response.status === 400) throw new PacsError("rejected", "The PACS rejected the request, for example a frame number beyond the image", 400);
    if (response.status >= 300 && response.status < 400) throw new PacsError("bad-response", "The PACS answered with a redirect; configure its final DICOMweb URL", response.status);
    throw new PacsError("upstream", `The PACS answered ${response.status}`, response.status);
  }

  private async datasets(path: string): Promise<DicomDataset[]> {
    const response = await this.checked(path, "application/dicom+json");
    if (response.status === 204) return [];
    const raw = await response.text();
    if (!raw.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PacsError("bad-response", "The PACS returned a search response that is not DICOM JSON");
    }
    if (!Array.isArray(parsed)) throw new PacsError("bad-response", "The PACS returned a search response that is not a DICOM JSON array");
    return parsed.filter((item): item is DicomDataset => Boolean(item) && typeof item === "object");
  }

  async searchStudies(search: StudySearch): Promise<PacsStudy[]> {
    const params = new URLSearchParams();
    if (search.accession) params.set("AccessionNumber", matchingValue(search.accession, "Accession number"));
    if (search.patientId) params.set("PatientID", matchingValue(search.patientId, "PACS patient ID"));
    if (search.studyInstanceUid) {
      if (!isDicomUid(search.studyInstanceUid)) throw new AppError(422, "validation_error", "Study Instance UID is not a valid DICOM UID");
      params.set("StudyInstanceUID", search.studyInstanceUid);
    }
    if (search.fromDate || search.toDate) params.set("StudyDate", `${search.fromDate ? dicomDate(search.fromDate) : ""}-${search.toDate ? dicomDate(search.toDate) : ""}`);
    if (search.modality) params.set("ModalitiesInStudy", matchingValue(search.modality, "Modality"));
    params.set("limit", String(Math.max(1, Math.min(search.limit, 100))));
    for (const field of STUDY_FIELDS) params.append("includefield", field);
    return (await this.datasets(`/studies?${params.toString()}`)).map(parseStudy).filter((study): study is PacsStudy => study !== null);
  }

  async findStudy(studyInstanceUid: string): Promise<PacsStudy | null> {
    const studies = await this.searchStudies({ studyInstanceUid, limit: 2 });
    return studies.find((study) => study.studyInstanceUid === studyInstanceUid) ?? null;
  }

  async searchSeries(studyInstanceUid: string): Promise<PacsSeries[]> {
    if (!isDicomUid(studyInstanceUid)) throw new AppError(422, "validation_error", "Invalid Study Instance UID");
    const params = new URLSearchParams();
    for (const field of SERIES_FIELDS) params.append("includefield", field);
    const series = (await this.datasets(`/studies/${studyInstanceUid}/series?${params.toString()}`))
      .map(parseSeries).filter((item): item is PacsSeries => item !== null);
    return series.sort((a, b) => (a.seriesNumber ?? Number.MAX_SAFE_INTEGER) - (b.seriesNumber ?? Number.MAX_SAFE_INTEGER));
  }

  async searchInstances(studyInstanceUid: string, seriesInstanceUid: string): Promise<PacsInstance[]> {
    if (!isDicomUid(studyInstanceUid) || !isDicomUid(seriesInstanceUid)) throw new AppError(422, "validation_error", "Invalid DICOM UID");
    const params = new URLSearchParams();
    for (const field of INSTANCE_FIELDS) params.append("includefield", field);
    const instances = (await this.datasets(`/studies/${studyInstanceUid}/series/${seriesInstanceUid}/instances?${params.toString()}`))
      .map(parseInstance).filter((item): item is PacsInstance => item !== null);
    return instances.sort((a, b) => (a.instanceNumber ?? Number.MAX_SAFE_INTEGER) - (b.instanceNumber ?? Number.MAX_SAFE_INTEGER));
  }

  /** WADO-RS rendered frame. The PACS path carries the study UID, so it enforces the study/series/instance hierarchy. */
  async renderFrame(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string, frame: number, options: RenderOptions = {}): Promise<RenderedImage> {
    if (![studyInstanceUid, seriesInstanceUid, sopInstanceUid].every(isDicomUid)) throw new AppError(422, "validation_error", "Invalid DICOM UID");
    if (!Number.isInteger(frame) || frame < 1 || frame > 100_000) throw new AppError(422, "validation_error", "Invalid frame number");
    const params = new URLSearchParams();
    if (options.viewport) params.set("viewport", `${options.viewport},${options.viewport}`);
    if (options.window) params.set("window", `${options.window.center},${options.window.width},linear`);
    const query = params.toString() ? `?${params.toString()}` : "";
    const accept = options.accept ?? "image/jpeg";
    const response = await this.checked(
      `/studies/${studyInstanceUid}/series/${seriesInstanceUid}/instances/${sopInstanceUid}/frames/${frame}/rendered${query}`,
      `${accept}, ${RENDERED_TYPES.filter((type) => type !== accept).join(", ")};q=0.5`,
    );
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!(RENDERED_TYPES as readonly string[]).includes(contentType)) {
      await response.body?.cancel();
      throw new PacsError("bad-response", `The PACS returned ${contentType || "an untyped body"} instead of a rendered image`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.settings.maxImageBytes) {
      await response.body?.cancel();
      throw new PacsError("bad-response", "The rendered image exceeds the configured size limit");
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > this.settings.maxImageBytes) throw new PacsError("bad-response", "The rendered image exceeds the configured size limit");
    if (!body.byteLength) throw new PacsError("bad-response", "The PACS returned an empty image");
    return { body, contentType };
  }

  /** Status of a search sent without credentials; a PACS that answers 2xx is open to anyone who can reach it. */
  async unauthenticatedProbe(): Promise<number> {
    const response = await this.request("/studies?limit=1", "application/dicom+json", false);
    await response.body?.cancel();
    return response.status;
  }
}

const clients = new WeakMap<DicomwebConfig, DicomwebClient>();

/** One client per configuration object; null while the connection is not fully configured. */
export function dicomwebClientFor(config: AppConfig, override?: DicomwebClient | null): DicomwebClient | null {
  if (override !== undefined) return override;
  if (dicomwebConfigProblems(config).length) return null;
  let client = clients.get(config.dicomweb);
  if (!client) {
    client = new DicomwebClient(config.dicomweb);
    clients.set(config.dicomweb, client);
  }
  return client;
}
