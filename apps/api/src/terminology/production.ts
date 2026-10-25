import { DependencyError } from "../lib/errors.js";
import type { TerminologyAdapter, TerminologyConcept, ValidateCodeResult } from "./types.js";

export class ProductionTerminologyAdapter implements TerminologyAdapter {
  readonly mode = "production" as const;
  readonly label = "Production terminology adapter";

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly timeoutMs: number,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/fhir+json",
          "content-type": "application/fhir+json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) throw new DependencyError(`Terminology provider returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof DependencyError) throw error;
      throw new DependencyError("Terminology provider is unavailable");
    } finally {
      clearTimeout(timer);
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

  async translate(): Promise<never> {
    throw new DependencyError("Production ConceptMap translation requires an approved mapping registration");
  }

  async search(): Promise<never> {
    throw new DependencyError("Production contextual terminology search requires configured approved value sets");
  }
}
