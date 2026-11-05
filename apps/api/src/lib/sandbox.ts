/**
 * Provenance tagging for records produced by sandbox adapters.
 *
 * Every row a sandbox adapter creates carries `simulated = true` and a `source` naming the adapter
 * (e.g. `sandbox:ollama`), so reports, eHMIS exports and FHIR output can exclude or clearly
 * separate simulated data. A sandbox adapter never writes a row without the tag, and a row without
 * the tag is never simulated.
 */

/** Adapter identifiers that may produce simulated records. */
export type SandboxSource = `sandbox:${string}` | "sandbox";

/** Rows that a sandbox adapter may create, with the provenance columns. */
export interface SandboxTagged {
  simulated: boolean;
  source: string | null;
}

/** Tag a row as produced by a sandbox adapter. */
export function sandboxTag(adapter: string): SandboxTagged {
  return { simulated: true, source: `sandbox:${adapter}` };
}

/** Rows that were produced by a real adapter. */
export function realTag(): SandboxTagged {
  return { simulated: false, source: null };
}

/** True when a row was produced by a sandbox adapter. */
export function isSandboxTagged(row: Pick<SandboxTagged, "simulated" | "source">): boolean {
  return row.simulated && typeof row.source === "string" && row.source.startsWith("sandbox");
}

/** Adapter name from a sandbox source, e.g. `ollama` for `sandbox:ollama`. */
export function sandboxAdapter(source: string | null | undefined): string | null {
  if (!source || !source.startsWith("sandbox")) return null;
  return source === "sandbox" ? "sandbox" : source.slice("sandbox:".length);
}

/** Assert a row is not simulated before it is treated as real. */
export function assertReal(row: Pick<SandboxTagged, "simulated" | "source">, what: string): void {
  if (isSandboxTagged(row)) {
    throw new Error(`${what} was produced by a sandbox adapter (${row.source}) and cannot be treated as real`);
  }
}