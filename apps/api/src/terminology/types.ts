export interface TerminologyConcept {
  system: string;
  version: string;
  code: string;
  display: string;
  active: boolean;
  synonyms: string[];
}

export interface ValueSetDefinition {
  canonical: string;
  version: string;
  title: string;
  system: string;
  codes: string[];
}

export interface ConceptMapEntry {
  fromCode: string;
  toCode: string;
  toDisplay: string;
  equivalence: string;
  /** Reviewed specimen context for laboratory mappings. Omitted when the map is not context-specific. */
  specimen?: string;
  /** Reviewed method context for laboratory mappings. */
  method?: string;
  /** Reviewed UCUM unit for laboratory mappings. */
  unit?: string;
}

export interface ConceptMapDefinition {
  canonical: string;
  version: string;
  name: string;
  fromSystem: string;
  toSystem: string;
  reviewed: boolean;
  entries: ConceptMapEntry[];
}

export interface TranslateInput {
  conceptMap: string;
  conceptMapVersion?: string;
  system: string;
  code: string;
  specimen?: string;
  method?: string;
  unit?: string;
}

export interface ValidateCodeResult {
  result: boolean;
  message?: string;
  display?: string;
  active?: boolean;
  system: string;
  version: string;
  code: string;
  valueSet?: string;
  valueSetVersion?: string;
}

export interface TerminologyStatus {
  readonly mode: TerminologyAdapter["mode"];
  readonly label: string;
  /** For the production adapter, whether a live connection to the configured provider has been verified. */
  readonly connected: boolean;
  /** For the production adapter, the provider host the adapter is configured to call. */
  readonly providerHost: string | null;
  /** For the production adapter, the provider API version observed during the last successful verification, if any. */
  readonly providerVersion: string | null;
  /** For the production adapter, when the connection was last successfully verified; null before any successful verification. */
  readonly lastVerifiedAt: string | null;
  /** For the production adapter, the canonical terminology releases the adapter is configured to use. Empty for the production adapter without a configured provider; populated explicitly for local reference catalogues only. */
  readonly releases: Array<{ system: string; version: string; source: "configured-provider" | "local-reference-catalogue" }>;
}

export interface TerminologyAdapter {
  readonly mode: "synthetic" | "production" | "local-reference" | "unavailable";
  readonly label: string;
  readonly status: TerminologyStatus;
  lookup(system: string, code: string, version?: string): Promise<TerminologyConcept | null>;
  validateCode(input: {
    system: string;
    code: string;
    version?: string;
    valueSet?: string;
    valueSetVersion?: string;
  }): Promise<ValidateCodeResult>;
  expand(input: {
    valueSet: string;
    valueSetVersion?: string;
    filter?: string;
    count: number;
    offset: number;
    activeOnly: boolean;
  }): Promise<{ valueSet: ValueSetDefinition; concepts: TerminologyConcept[]; total: number }>;
  translate(input: TranslateInput): Promise<{
    result: boolean;
    message?: string;
    map?: ConceptMapDefinition;
    match?: { toCode: string; toDisplay: string; equivalence: string; specimen?: string; method?: string; unit?: string };
  }>;
  search(field: string, query: string, limit: number): Promise<TerminologyConcept[]>;
  /** An adapter-specific reachability/connectivity probe, used only for status and operator-initiated
   * verification. It must not modify clinical data and must be safe to call infrequently. */
  verifyConnection(): Promise<void>;
}
