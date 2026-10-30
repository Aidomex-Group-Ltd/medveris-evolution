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

export interface TerminologyAdapter {
  readonly mode: "synthetic" | "production" | "unavailable";
  readonly label: string;
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
}
