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

  async lookup(): ReturnType<TerminologyAdapter["lookup"]> {
    return this.fail();
  }

  async validateCode(): ReturnType<TerminologyAdapter["validateCode"]> {
    return this.fail();
  }

  async expand(): ReturnType<TerminologyAdapter["expand"]> {
    return this.fail();
  }

  async translate(): ReturnType<TerminologyAdapter["translate"]> {
    return this.fail();
  }

  async search(): ReturnType<TerminologyAdapter["search"]> {
    return this.fail();
  }
}
