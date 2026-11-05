import { DependencyError } from "../lib/errors.js";
import type { TerminologyAdapter } from "./types.js";

export const UNAVAILABLE_LABEL = "Terminology service not configured — coded entries cannot be validated";

/** Used where no licensed terminology service is configured: every operation reports the outage instead of a result. */
export class UnavailableTerminologyAdapter implements TerminologyAdapter {
  readonly mode = "unavailable" as const;
  readonly label = UNAVAILABLE_LABEL;

  private fail(): never {
    throw new DependencyError("Terminology service is not configured for this environment");
  }

  async lookup(): Promise<import("./types.js").TerminologyConcept | null> {
    return this.fail();
  }

  async validateCode(): Promise<import("./types.js").ValidateCodeResult> {
    return this.fail();
  }

  async expand(): Promise<{ valueSet: import("./types.js").ValueSetDefinition; concepts: import("./types.js").TerminologyConcept[]; total: number }> {
    return this.fail();
  }

  async translate(): Promise<{ result: boolean; message?: string; map?: import("./types.js").ConceptMapDefinition; match?: { toCode: string; toDisplay: string; equivalence: string; specimen?: string; method?: string; unit?: string } }> {
    return this.fail();
  }

  async search(): Promise<import("./types.js").TerminologyConcept[]> {
    return this.fail();
  }
}
