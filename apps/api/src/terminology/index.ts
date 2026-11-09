import type { AppConfig } from "../config.js";
import { ProductionTerminologyAdapter } from "./production.js";
import { SyntheticTerminologyAdapter } from "./synthetic.js";
import { LocalReferenceTerminologyAdapter } from "./local-reference.js";
import type { TerminologyAdapter } from "./types.js";
import { UnavailableTerminologyAdapter } from "./unavailable.js";

export type { TerminologyAdapter, TerminologyStatus } from "./types.js";
export { FIELD_VALUE_SETS, SNOMED_SYSTEM, LOINC_SYSTEM, UCUM_SYSTEM, LOCAL_LAB_SYSTEM, SNOMED_LOCAL_VERSION, LOINC_LOCAL_VERSION, UCUM_LOCAL_VERSION, LOCAL_REF_SYSTEM, LOCAL_REF_VERSION, LOCAL_REF_LABEL, lookupConcept, valueSetByCanonical, conceptMapByCanonical } from "./local-reference.js";

export function createTerminology(config: AppConfig): TerminologyAdapter {
  if (config.terminologyMode === "unavailable") return new UnavailableTerminologyAdapter();
  if (config.terminologyMode === "production" && config.terminologyProviderUrl) {
    return new ProductionTerminologyAdapter(config.terminologyProviderUrl, config.terminologyProviderToken, config.terminologyTimeoutMs);
  }
  if (config.terminologyMode === "local-reference") {
    return new LocalReferenceTerminologyAdapter();
  }
  return new SyntheticTerminologyAdapter();
}
