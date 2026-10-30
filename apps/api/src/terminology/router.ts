import { Hono, type Context } from "hono";
import { terminology } from "../services/clinical.js";
import { AppError, ValidationError } from "../lib/errors.js";
import { requireAuth } from "../auth/middleware.js";
import type { AppEnv } from "../types.js";
import { FIELD_VALUE_SETS, LOINC_SYSTEM, SNOMED_SYSTEM, UCUM_SYSTEM } from "./synthetic.js";

export const terminologyRoutes = new Hono<AppEnv>();

const FHIR_CONTENT = "application/fhir+json; charset=utf-8";

function fhir(c: Context<AppEnv>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": FHIR_CONTENT, "cache-control": "no-store, private", "x-content-type-options": "nosniff" },
  });
}

function outcome(code: string, diagnostics: string) {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code, diagnostics }],
  };
}

interface Parameter {
  name?: string;
  valueString?: string;
  valueUri?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
}

async function readParameters(c: Context<AppEnv>): Promise<Record<string, string | boolean | number | undefined>> {
  if (c.req.method === "GET") {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(c.req.query())) values[key] = value;
    return values;
  }
  let body: { resourceType?: string; parameter?: Parameter[] };
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("FHIR Parameters body must be valid JSON");
  }
  if (body.resourceType !== "Parameters" || !Array.isArray(body.parameter)) {
    throw new ValidationError("A FHIR Parameters resource is required");
  }
  const values: Record<string, string | boolean | number | undefined> = {};
  for (const parameter of body.parameter) {
    if (!parameter.name) continue;
    values[parameter.name] = parameter.valueString ?? parameter.valueUri ?? parameter.valueBoolean ?? parameter.valueInteger;
  }
  return values;
}

function stringParam(values: Record<string, string | boolean | number | undefined>, name: string): string | undefined {
  const value = values[name];
  return value == null ? undefined : String(value);
}

function requireSession(c: Context<AppEnv>) {
  requireAuth(c);
}

terminologyRoutes.get("/terminology/fhir/r4/metadata", (c) => {
  const config = c.get("deps").config;
  return fhir(c, {
    resourceType: "TerminologyCapabilities",
    id: "medveris-m1-terminology",
    url: "https://medveris.example/fhir/TerminologyCapabilities/medveris-m1-terminology",
    name: "MedverisSyntheticTerminology",
    title: config.terminologyMode === "synthetic"
      ? "Synthetic development terminology (not for production)"
      : config.terminologyMode === "unavailable" ? "Terminology service not configured" : "Configured production terminology adapter",
    status: "draft",
    experimental: true,
    date: "2026-10-25",
    kind: "instance",
    software: { name: "Medveris Terminology Facade", version: "0.1.0" },
    implementation: {
      description:
        config.terminologyMode === "synthetic"
          ? "Synthetic fixtures for local development and automated tests. They are not production SNOMED CT or LOINC content."
          : config.terminologyMode === "unavailable"
          ? "No licensed terminology service is configured; every terminology operation returns 503 dependency_unavailable."
          : "Production adapter boundary. Supported operations depend on the configured licensed terminology service.",
      url: "/terminology/fhir/r4",
    },
    lockedDate: false,
    codeSystem: [
      { uri: SNOMED_SYSTEM, version: config.snomedEditionUri ?? "synthetic", content: "fragment", subsumption: false },
      { uri: LOINC_SYSTEM, version: config.loincRelease ?? "synthetic", content: "fragment", subsumption: false },
      { uri: UCUM_SYSTEM, version: "synthetic", content: "fragment", subsumption: false },
    ],
    expansion: { parameter: [{ name: "filter" }, { name: "count" }, { name: "offset" }, { name: "activeOnly" }] },
    validateCode: { translations: true },
    translation: { needsMap: true },
    valueSet: Object.entries(FIELD_VALUE_SETS).map(([field, canonical]) => ({
      url: canonical,
      version: "1.0.0",
      documentation: `Contextual value set for ${field}`,
    })),
  });
});

terminologyRoutes.get("/terminology/fhir/r4/CodeSystem/$lookup", async (c) => {
  requireSession(c);
  const values = await readParameters(c);
  const system = stringParam(values, "system");
  const code = stringParam(values, "code");
  const version = stringParam(values, "version");
  if (!system || !code) return fhir(c, outcome("required", "system and code are required"), 400);
  const concept = await terminology(c).lookup(system, code, version);
  if (!concept) return fhir(c, outcome("not-found", "Code not found in the configured terminology release"), 404);
  return fhir(c, {
    resourceType: "Parameters",
    parameter: [
      { name: "name", valueString: concept.display },
      { name: "display", valueString: concept.display },
      { name: "version", valueString: concept.version },
      { name: "active", valueBoolean: concept.active },
      { name: "system", valueString: concept.system },
      { name: "code", valueString: concept.code },
      { name: "designation", part: concept.synonyms.map((value) => ({ name: "designation", part: [{ name: "value", valueString: value }] })) },
    ],
  });
});

terminologyRoutes.post("/terminology/fhir/r4/CodeSystem/$lookup", async (c) => {
  return c.req.method === "POST" ? lookupPost(c) : undefined;
});

async function lookupPost(c: Context<AppEnv>) {
  requireSession(c);
  const values = await readParameters(c);
  const system = stringParam(values, "system");
  const code = stringParam(values, "code");
  if (!system || !code) return fhir(c, outcome("required", "system and code are required"), 400);
  const concept = await terminology(c).lookup(system, code, stringParam(values, "version"));
  if (!concept) return fhir(c, outcome("not-found", "Code not found in the configured terminology release"), 404);
  return fhir(c, {
    resourceType: "Parameters",
    parameter: [
      { name: "name", valueString: concept.display },
      { name: "display", valueString: concept.display },
      { name: "version", valueString: concept.version },
      { name: "active", valueBoolean: concept.active },
      { name: "system", valueString: concept.system },
      { name: "code", valueString: concept.code },
    ],
  });
}

async function validateCodeResponse(c: Context<AppEnv>) {
  requireSession(c);
  const values = await readParameters(c);
  const system = stringParam(values, "system") ?? stringParam(values, "url");
  const code = stringParam(values, "code");
  if (!system || !code) return fhir(c, outcome("required", "system and code are required"), 400);
  const result = await terminology(c).validateCode({
    system,
    code,
    version: stringParam(values, "version"),
    valueSet: stringParam(values, "valueSet"),
    valueSetVersion: stringParam(values, "valueSetVersion"),
  });
  return fhir(c, {
    resourceType: "Parameters",
    parameter: [
      { name: "result", valueBoolean: result.result },
      ...(result.message ? [{ name: "message", valueString: result.message }] : []),
      ...(result.display ? [{ name: "display", valueString: result.display }] : []),
      ...(result.active != null ? [{ name: "active", valueBoolean: result.active }] : []),
      { name: "system", valueString: result.system },
      { name: "version", valueString: result.version },
      { name: "code", valueString: result.code },
      ...(result.valueSet ? [{ name: "valueSet", valueString: result.valueSet }] : []),
      ...(result.valueSetVersion ? [{ name: "valueSetVersion", valueString: result.valueSetVersion }] : []),
    ],
  });
}

terminologyRoutes.get("/terminology/fhir/r4/CodeSystem/$validate-code", (c) => validateCodeResponse(c));
terminologyRoutes.post("/terminology/fhir/r4/CodeSystem/$validate-code", (c) => validateCodeResponse(c));

async function expandResponse(c: Context<AppEnv>) {
  requireSession(c);
  const values = await readParameters(c);
  const valueSet = stringParam(values, "valueSet") ?? stringParam(values, "url");
  if (!valueSet) return fhir(c, outcome("required", "valueSet is required"), 400);
  const count = Math.min(Math.max(Number(stringParam(values, "count") ?? 50), 1), 100);
  const offset = Math.max(Number(stringParam(values, "offset") ?? 0), 0);
  try {
    const expanded = await terminology(c).expand({
      valueSet,
      valueSetVersion: stringParam(values, "valueSetVersion"),
      filter: stringParam(values, "filter"),
      count,
      offset,
      activeOnly: stringParam(values, "activeOnly") !== "false",
    });
    return fhir(c, {
      resourceType: "ValueSet",
      url: expanded.valueSet.canonical,
      version: expanded.valueSet.version,
      name: expanded.valueSet.title,
      status: "draft",
      experimental: true,
      expansion: {
        identifier: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        total: expanded.total,
        offset,
        contains: expanded.concepts.map((concept) => ({
          system: concept.system,
          version: concept.version,
          code: concept.code,
          display: concept.display,
          inactive: !concept.active,
        })),
      },
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("not_found")) return fhir(c, outcome("not-found", "Value set or version is not approved by this adapter"), 404);
    throw error;
  }
}

terminologyRoutes.get("/terminology/fhir/r4/ValueSet/$expand", (c) => expandResponse(c));
terminologyRoutes.post("/terminology/fhir/r4/ValueSet/$expand", (c) => expandResponse(c));

async function valueSetValidate(c: Context<AppEnv>) {
  requireSession(c);
  const values = await readParameters(c);
  const system = stringParam(values, "system");
  const code = stringParam(values, "code");
  const valueSet = stringParam(values, "valueSet") ?? stringParam(values, "url");
  if (!system || !code || !valueSet) return fhir(c, outcome("required", "system, code and valueSet are required"), 400);
  const result = await terminology(c).validateCode({ system, code, version: stringParam(values, "version"), valueSet, valueSetVersion: stringParam(values, "valueSetVersion") });
  return fhir(c, {
    resourceType: "Parameters",
    parameter: [
      { name: "result", valueBoolean: result.result },
      ...(result.message ? [{ name: "message", valueString: result.message }] : []),
      ...(result.display ? [{ name: "display", valueString: result.display }] : []),
    ],
  });
}

terminologyRoutes.get("/terminology/fhir/r4/ValueSet/$validate-code", (c) => valueSetValidate(c));
terminologyRoutes.post("/terminology/fhir/r4/ValueSet/$validate-code", (c) => valueSetValidate(c));

async function translateResponse(c: Context<AppEnv>) {
  requireSession(c);
  const values = await readParameters(c);
  const conceptMap = stringParam(values, "conceptMap") ?? stringParam(values, "url");
  const system = stringParam(values, "system");
  const code = stringParam(values, "code");
  if (!conceptMap || !system || !code) return fhir(c, outcome("required", "conceptMap, system and code are required"), 400);
  const result = await terminology(c).translate({
    conceptMap, conceptMapVersion: stringParam(values, "conceptMapVersion"), system, code,
    specimen: stringParam(values, "specimen"), method: stringParam(values, "method"), unit: stringParam(values, "unit"),
  });
  return fhir(c, {
    resourceType: "Parameters",
    parameter: [
      { name: "result", valueBoolean: result.result },
      ...(result.message ? [{ name: "message", valueString: result.message }] : []),
      ...(result.map ? [{ name: "conceptMap", valueString: result.map.canonical }, { name: "conceptMapVersion", valueString: result.map.version }] : []),
      ...(result.match
        ? [{
            name: "match",
            part: [
              { name: "equivalence", valueString: result.match.equivalence },
              { name: "concept", valueCoding: { system: result.map?.toSystem, code: result.match.toCode, display: result.match.toDisplay } },
              ...(result.match.specimen ? [{ name: "specimen", valueString: result.match.specimen }] : []),
              ...(result.match.method ? [{ name: "method", valueString: result.match.method }] : []),
              ...(result.match.unit ? [{ name: "unit", valueString: result.match.unit }] : []),
            ],
          }]
        : []),
    ],
  });
}

terminologyRoutes.get("/terminology/fhir/r4/ConceptMap/$translate", (c) => translateResponse(c));
terminologyRoutes.post("/terminology/fhir/r4/ConceptMap/$translate", (c) => translateResponse(c));

terminologyRoutes.get("/terminology/fhir/r4/*", (c) => fhir(c, outcome("not-supported", "Terminology operation is not implemented"), 404));

terminologyRoutes.get("/api/v1/terminology/search", async (c) => {
  requireSession(c);
  const field = c.req.query("field") ?? "";
  const query = c.req.query("q") ?? "";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 50);
  if (!FIELD_VALUE_SETS[field]) throw new AppError(400, "invalid_field", "Unsupported contextual terminology field");
  if (query.length > 100) throw new ValidationError("Search text is too long");
  const adapter = terminology(c);
  const concepts = await adapter.search(field, query, limit);
  return c.json({
    field,
    valueSet: FIELD_VALUE_SETS[field],
    terminologyMode: adapter.mode,
    label: adapter.label,
    concepts,
  });
});
