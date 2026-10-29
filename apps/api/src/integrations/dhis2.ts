import type { EhmisConfig } from "../config.js";

/**
 * DHIS2 Web API client for facility-scoped eHMIS aggregate reporting. Credentials only ever travel in
 * the Authorization header of requests to the facility's configured base URL; they are never logged,
 * returned or included in error messages. Response bodies from the server are reduced to DHIS2 import
 * counts and conflict descriptions before they are stored.
 *
 * Endpoints used (DHIS2 Web API, core 2.41 documentation): GET /api/system/info, GET /api/me,
 * GET /api/organisationUnits/{uid}, POST /api/dataValueSets (dryRun, importStrategy=CREATE_AND_UPDATE).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Dhis2Credentials =
  | { kind: "basic"; username: string; password: string }
  | { kind: "personal-access-token"; token: string };

export interface DataValue {
  dataElement: string;
  categoryOptionCombo: string;
  value: string;
}

export interface DataValueSet {
  dataSet: string;
  period: string;
  orgUnit: string;
  attributeOptionCombo?: string;
  completedDate?: string;
  dataValues: DataValue[];
}

export interface ImportOutcome {
  status: "SUCCESS" | "OK" | "WARNING" | "ERROR";
  imported: number;
  updated: number;
  ignored: number;
  deleted: number;
  conflicts: Array<{ object: string; value: string }>;
}

export class Dhis2Error extends Error {
  readonly httpStatus: number | null;
  readonly failure: "timeout" | "network" | "unauthorized" | "http" | "invalid-response" | "refused-host";
  constructor(failure: Dhis2Error["failure"], message: string, httpStatus: number | null = null) {
    super(message);
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

const LOCAL_ENVIRONMENTS = new Set(["development", "test"]);
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|0\.)/i;

/** Why this base URL may not be used from this deployment; empty when it may. */
export function baseUrlProblems(baseUrl: string | null, config: Pick<EhmisConfig, "allowedHosts">, appEnv: string): string[] {
  if (!baseUrl) return ["No DHIS2 base URL is configured for this facility"];
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return ["The DHIS2 base URL is not an absolute URL"];
  }
  const local = LOCAL_ENVIRONMENTS.has(appEnv);
  const problems: string[] = [];
  if (url.protocol !== "https:" && !local) problems.push("The DHIS2 base URL must use HTTPS");
  if (url.username || url.password) problems.push("Credentials must not be embedded in the DHIS2 base URL");
  if (!local && PRIVATE_HOST.test(url.hostname)) problems.push("The DHIS2 base URL must not point at a private or loopback address");
  if (!local && !config.allowedHosts.includes(url.hostname.toLowerCase())) {
    problems.push(`${url.hostname} is not in EHMIS_ALLOWED_HOSTS for this deployment`);
  }
  return problems;
}

function authorization(credentials: Dhis2Credentials): string {
  if (credentials.kind === "personal-access-token") return `ApiToken ${credentials.token}`;
  return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
}

function numberOf(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Accepts both the WebMessage envelope (2.38+) and a bare ImportSummary (older servers). */
export function parseImportSummary(body: unknown): ImportOutcome {
  const record = (body ?? {}) as Record<string, unknown>;
  const summary = (record.response && typeof record.response === "object" ? record.response : record) as Record<string, unknown>;
  const counts = (summary.importCount ?? {}) as Record<string, unknown>;
  const status = String(summary.status ?? record.status ?? "").toUpperCase();
  if (!["SUCCESS", "OK", "WARNING", "ERROR"].includes(status)) throw new Dhis2Error("invalid-response", "The DHIS2 response did not contain an import summary");
  const conflicts = Array.isArray(summary.conflicts) ? summary.conflicts : [];
  return {
    status: status as ImportOutcome["status"],
    imported: numberOf(counts.imported),
    updated: numberOf(counts.updated),
    ignored: numberOf(counts.ignored),
    deleted: numberOf(counts.deleted),
    conflicts: conflicts.slice(0, 50).map((conflict) => {
      const item = (conflict ?? {}) as Record<string, unknown>;
      return { object: String(item.object ?? "").slice(0, 120), value: String(item.value ?? "").slice(0, 300) };
    }),
  };
}

export class Dhis2Client {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: Dhis2Credentials,
    private readonly timeoutMs: number,
    private readonly transport: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async request(path: string, init: { method?: string; body?: unknown; okStatuses?: number[] } = {}): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: authorization(this.credentials),
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Dhis2Error("timeout", `DHIS2 did not answer within ${this.timeoutMs} ms`);
      throw new Dhis2Error("network", error instanceof Error ? `DHIS2 could not be reached (${error.name})` : "DHIS2 could not be reached");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) throw new Dhis2Error("unauthorized", "DHIS2 refused the facility credentials", response.status);
    let body: unknown = null;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const ok = response.ok || (init.okStatuses ?? []).includes(response.status);
    if (!ok) throw new Dhis2Error("http", `DHIS2 answered HTTP ${response.status}`, response.status);
    return { status: response.status, body };
  }

  async systemInfo(): Promise<{ version: string | null }> {
    const { body } = await this.request("/api/system/info");
    const version = (body as Record<string, unknown> | null)?.version;
    return { version: typeof version === "string" ? version.slice(0, 40) : null };
  }

  /**
   * Confirms the organisation unit exists and that the credential's user may capture data for it: the
   * unit is one of the user's data-capture units or below one of them in the hierarchy.
   */
  async verifyOrgUnit(uid: string): Promise<{ name: string; assigned: boolean }> {
    const [me, unit] = await Promise.all([
      this.request("/api/me?fields=id,organisationUnits[id]"),
      this.request(`/api/organisationUnits/${encodeURIComponent(uid)}?fields=id,name,path`),
    ]);
    const unitBody = (unit.body ?? {}) as Record<string, unknown>;
    if (unitBody.id !== uid) throw new Dhis2Error("invalid-response", "DHIS2 did not return the organisation unit");
    const path = String(unitBody.path ?? "").split("/").filter(Boolean);
    const units = (((me.body ?? {}) as Record<string, unknown>).organisationUnits ?? []) as Array<{ id?: string }>;
    const assigned = units.some((item) => typeof item.id === "string" && path.includes(item.id));
    return { name: String(unitBody.name ?? uid).slice(0, 200), assigned };
  }

  async submit(dataValueSet: DataValueSet, options: { dryRun: boolean }): Promise<{ httpStatus: number; outcome: ImportOutcome }> {
    const query = `dryRun=${options.dryRun}&importStrategy=CREATE_AND_UPDATE&idScheme=UID&async=false`;
    // DHIS2 answers 409 with an import summary when values conflict; that is a result, not a transport failure.
    const { status, body } = await this.request(`/api/dataValueSets?${query}`, { method: "POST", body: dataValueSet, okStatuses: [409] });
    return { httpStatus: status, outcome: parseImportSummary(body) };
  }
}
