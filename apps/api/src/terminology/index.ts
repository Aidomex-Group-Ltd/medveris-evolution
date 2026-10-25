import type { AppConfig } from "../config.js";
import { ProductionTerminologyAdapter } from "./production.js";
import { SyntheticTerminologyAdapter } from "./synthetic.js";
import type { TerminologyAdapter } from "./types.js";

export type { TerminologyAdapter } from "./types.js";
export * from "./synthetic.js";

export function createTerminology(config: AppConfig): TerminologyAdapter {
  if (config.terminologyMode === "production" && config.terminologyProviderUrl) {
    return new ProductionTerminologyAdapter(config.terminologyProviderUrl, config.terminologyProviderToken, config.terminologyTimeoutMs);
  }
  return new SyntheticTerminologyAdapter();
}
