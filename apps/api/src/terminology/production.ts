import { breakerFor, CircuitOpenError, retry, withTimeout } from "@medveris/platform";
import { DependencyError } from "../lib/errors.js";
import type { TerminologyAdapter, TerminologyConcept, TerminologyStatus, TranslateInput, ValidateCodeResult } from "./types.js";

class ProviderStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export class ProductionTerminologyAdapter implements TerminologyAdapter {
  readonly mode = "production" as const;
  readonly label = "Production terminology adapter";
  #status: TerminologyStatus;

  get status(): TerminologyStatus {
    return this.#status;
  }

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly timeoutMs: number,
  ) {
    this.#status = {
      mode: "production",
      label: this.label,
      connected: false,
      providerHost: new URL(this.baseUrl).host,
      providerVersion: null,
      lastVerifiedAt: null,
      releases: [],
    };
  }

  /** Lookup and $validate-code are read-only FHIR operations, so a bounded retry cannot duplicate an effect. */
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const breaker = breakerFor("terminology", {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      isFailure: (error) => !(error instanceof ProviderStatus) || error.status >= 500 || error.status === 429,
    });
    try {
      return await retry(
        () => breaker.execute(() => withTimeout("terminology", this.timeoutMs, async (signal) => {
          const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
            ...init,
            signal,
            headers: {
              accept: "application/fhir+json",
              "content-type": "application/fhir+json",
              ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
              ...(init?.headers ?? {}),
            },
          });
          if (!response.ok) throw new ProviderStatus(response.status);
          return await response.json();
        })),
        {
          attempts: 2, baseDelayMs: 100, maxDelayMs: 500,
          retryable: (error) => !(error instanceof CircuitOpenError) && (!(error instanceof ProviderStatus) || error.status >= 500 || error.status === 429),
        },
      );
    } catch (error) {
      if (error instanceof ProviderStatus) throw new DependencyError(`Terminology provider returned HTTP ${error.status}`);
      throw new DependencyError("Terminology provider is unavailable");
    }
  }

  /**
   * A separate, read-only reachability check for the production provider. It is intentionally not
   * called on every operation so a provider outage cannot make every validateCode call pay a probe
   * latency; the probe is used only for status/health reporting and initial verification.
   */
  async verifyConnection(): Promise<void> {
    let version: string | null = null;
    try {
      const payload = (await this.request("/_version", { method: "GET" })) as { version?: string; error?: unknown } | null;
      if (payload && typeof payload === "object" && "version" in payload && typeof (payload as Record<string, unknown>).version === "string") {
        version = (payload as { version: string }).version;
      }
    } catch {
      // Provider may expose version under a different path; a failed probe does not by itself change status.
    }

    if (!version) {
      try {
        const payload = (await this.request("/api/version", { method: "GET" })) as { version?: string } | null;
        if (payload && typeof payload === "object" && "version" in payload && typeof (payload as Record<string, unknown>).version === "string") {
          version = (payload as { version: string }).version;
        }
      } catch {
        // Fall through: status stays connected=false until a successful probe.
      }
    }

    if (version) {
      this.#status = {
        ...this.#status,
        connected: true,
        providerVersion: version,
        lastVerifiedAt: new Date().toISOString(),
        releases: [
          { system: "https://medveris.example/fhir/TerminologyCapabilities/medveris-m1-terminology", version, source: "configured-provider" },
        ],
      };
    }
  }

  async lookup(system: string, code: string, version?: string): Promise<TerminologyConcept | null> {
    const qs = new URLSearchParams({ system, code, ...(version ? { version } : {}) });
    const data = (await this.request(`/CodeSystem/$lookup?${qs}`, { method: "GET" })) as {
      parameter?: Array<{ name: string; valueString?: string; valueBoolean?: boolean; valueCoding?: Record<string, string> }>;
    };
    if (!data.parameter) return null;
    const get = (name: string) => data.parameter?.find((p) => p.name === name);
    if (get("result")?.valueBoolean === false) return null;
    return {
      system,
      version: get("version")?.valueString ?? version ?? "",
      code,
      display: get("display")?.valueString ?? code,
      active: get("active")?.valueBoolean ?? true,
      synonyms: [],
    };
  }

  async validateCode(input: { system: string; code: string; version?: string; valueSet?: string; valueSetVersion?: string }): Promise<ValidateCodeResult> {
    const parameters = {
      resourceType: "Parameters",
      parameter: [
        { name: "system", valueString: input.system },
        { name: "code", valueString: input.code },
        ...(input.version ? [{ name: "version", valueString: input.version }] : []),
        ...(input.valueSet ? [{ name: "valueSet", valueString: input.valueSet }] : []),
        ...(input.valueSetVersion ? [{ name: "valueSetVersion", valueString: input.valueSetVersion }] : []),
      ],
    };
    const data = (await this.request("/CodeSystem/$validate-code", { method: "POST", body: JSON.stringify(parameters) })) as {
      parameter?: Array<{ name: string; valueBoolean?: boolean; valueString?: string }>;
    };
    const result = data.parameter?.find((p) => p.name === "result")?.valueBoolean ?? false;
    return {
      result,
      message: data.parameter?.find((p) => p.name === "message")?.valueString,
      display: data.parameter?.find((p) => p.name === "display")?.valueString,
      system: input.system,
      version: input.version ?? "",
      code: input.code,
      valueSet: input.valueSet,
      valueSetVersion: input.valueSetVersion,
    };
  }

  async expand(): Promise<never> {
    throw new DependencyError("Production ValueSet expansion requires a configured approved value set mapping; the local adapter cannot assume one");
  }

  async translate(_input: TranslateInput): Promise<never> {
    throw new DependencyError("Production ConceptMap translation requires an approved mapping registration");
  }

  async search(): Promise<never> {
    throw new DependencyError("Production contextual terminology search requires configured approved value sets");
  }
}
