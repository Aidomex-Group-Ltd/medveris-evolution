import type { MiddlewareHandler } from "hono";
import { metric } from "@medveris/platform";
import type { AppEnv } from "../types.js";
import { annotate } from "./observability.js";

/**
 * Explicit allowlist of responses that may be stored by browsers, the Cloudflare edge and the
 * Worker cache. Every rule is public, non-personal reference data served identically to every
 * anonymous caller. Anything not listed here, including every authenticated, tenant, patient,
 * clinical and credential response, is sent with `no-store, private`.
 */
export interface CacheRule {
  id: string;
  path: RegExp;
  dataClass: "public-reference" | "public-directory";
  browserMaxAgeSeconds: number;
  /** Freshness at the Worker cache; after this the entry is only used if the origin fails. */
  edgeTtlSeconds: number;
  staleWhileRevalidateSeconds: number;
  /** How long an expired entry may still be served when the origin errors. */
  staleIfErrorSeconds: number;
  /** Parameters that select a representation; any other parameter bypasses shared caching. */
  queryParams: readonly string[];
  /** Parameters carrying personal data (a caller's precise location) are never part of a shared key. */
  privateParams?: readonly string[];
}

const DIRECTORY_SEARCH_PARAMS = [
  "q", "country", "region", "district", "locality", "facilityType", "service", "capability", "participation",
  "minLat", "maxLat", "minLng", "maxLng", "sort", "limit", "offset", "surface",
] as const;

export const CACHE_RULES: readonly CacheRule[] = Object.freeze([
  { id: "public-config", path: /^\/api\/v1\/public\/config$/, dataClass: "public-reference", browserMaxAgeSeconds: 60, edgeTtlSeconds: 60, staleWhileRevalidateSeconds: 300, staleIfErrorSeconds: 3600, queryParams: [] },
  { id: "public-facilities", path: /^\/api\/v1\/public\/facilities$/, dataClass: "public-directory", browserMaxAgeSeconds: 30, edgeTtlSeconds: 60, staleWhileRevalidateSeconds: 60, staleIfErrorSeconds: 600, queryParams: [] },
  { id: "directory-meta", path: /^\/api\/v1\/public\/directory\/meta$/, dataClass: "public-directory", browserMaxAgeSeconds: 120, edgeTtlSeconds: 300, staleWhileRevalidateSeconds: 600, staleIfErrorSeconds: 3600, queryParams: [] },
  { id: "directory-map-config", path: /^\/api\/v1\/public\/directory\/map-config$/, dataClass: "public-reference", browserMaxAgeSeconds: 300, edgeTtlSeconds: 300, staleWhileRevalidateSeconds: 600, staleIfErrorSeconds: 3600, queryParams: [] },
  { id: "directory-search", path: /^\/api\/v1\/public\/directory\/facilities$/, dataClass: "public-directory", browserMaxAgeSeconds: 30, edgeTtlSeconds: 60, staleWhileRevalidateSeconds: 60, staleIfErrorSeconds: 600, queryParams: DIRECTORY_SEARCH_PARAMS, privateParams: ["lat", "lng", "radiusKm"] },
  { id: "directory-facility", path: /^\/api\/v1\/public\/directory\/facilities\/[A-Za-z0-9_-]{1,64}$/, dataClass: "public-directory", browserMaxAgeSeconds: 30, edgeTtlSeconds: 60, staleWhileRevalidateSeconds: 60, staleIfErrorSeconds: 600, queryParams: [] },
  { id: "integration-products", path: /^\/api\/v1\/public\/integrations\/products$/, dataClass: "public-reference", browserMaxAgeSeconds: 300, edgeTtlSeconds: 300, staleWhileRevalidateSeconds: 600, staleIfErrorSeconds: 3600, queryParams: [] },
]);

export function matchCacheRule(method: string, pathname: string): CacheRule | null {
  if (method !== "GET" && method !== "HEAD") return null;
  return CACHE_RULES.find((rule) => rule.path.test(pathname)) ?? null;
}

/** A session cookie or Authorization header means the response must not be shared or reused. */
export function hasCredentials(headers: Headers): boolean {
  if (headers.has("authorization")) return true;
  return /(?:^|;\s*)mv_session=/.test(headers.get("cookie") ?? "");
}

export type CacheDecision =
  | { kind: "none" }
  | { kind: "private"; rule: CacheRule; reason: "credentials" | "private-param" | "unknown-param" | "ambiguous-param" | "oversized-key" }
  | { kind: "shared"; rule: CacheRule; key: string };

const MAX_PARAM_VALUE = 120;
const MAX_KEY_LENGTH = 1024;

/**
 * Deterministic shared-cache key: origin, key version (deployment + epoch), rule, path and the
 * sorted representation parameters. Requests with credentials, personal parameters, unknown or
 * repeated parameters never get a shared key, so attacker-chosen parameters cannot pollute or
 * fragment the cache and no identity-bearing request can read or write it.
 */
export function cacheDecision(request: Request, keyVersion: string): CacheDecision {
  const url = new URL(request.url);
  const rule = matchCacheRule(request.method, url.pathname);
  if (!rule) return { kind: "none" };
  if (hasCredentials(request.headers)) return { kind: "private", rule, reason: "credentials" };
  const names = [...url.searchParams.keys()];
  if (new Set(names).size !== names.length) return { kind: "private", rule, reason: "ambiguous-param" };
  const params: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    if (rule.privateParams?.includes(name)) return { kind: "private", rule, reason: "private-param" };
    if (!rule.queryParams.includes(name)) return { kind: "private", rule, reason: "unknown-param" };
    if (value.length > MAX_PARAM_VALUE) return { kind: "private", rule, reason: "oversized-key" };
    if (value !== "") params.push([name, value]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(params).toString();
  const key = `${url.origin}/__edge-cache/${encodeURIComponent(keyVersion)}/${rule.id}${url.pathname}${query ? `?${query}` : ""}`;
  if (key.length > MAX_KEY_LENGTH) return { kind: "private", rule, reason: "oversized-key" };
  return { kind: "shared", rule, key };
}

export function publicCacheControl(rule: CacheRule): string {
  return `public, max-age=${rule.browserMaxAgeSeconds}, stale-while-revalidate=${rule.staleWhileRevalidateSeconds}, stale-if-error=${rule.staleIfErrorSeconds}`;
}

export const PRIVATE_NO_STORE = "no-store, private";

export async function strongEtag(body: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return `"${[...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

/** RFC 9110 weak comparison for If-None-Match, including lists and `*`. */
export function etagMatches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

function isProtectedPath(path: string): boolean {
  return path.startsWith("/api/") || path.startsWith("/fhir/") || path.startsWith("/terminology/");
}

/**
 * Sets Cache-Control on every API/FHIR/terminology response. Only allowlisted rules answered
 * with 200 to an anonymous caller become public, and they get a strong ETag with 304 handling.
 * A handler cannot opt a response into public caching by setting its own header.
 */
export function httpCachePolicy(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (!isProtectedPath(c.req.path)) return;
    const rule = matchCacheRule(c.req.method, c.req.path);
    const anonymous = !hasCredentials(c.req.raw.headers);
    const response = c.res;
    if (!rule || !anonymous || response.status !== 200 || response.headers.has("set-cookie")) {
      c.res.headers.set("cache-control", PRIVATE_NO_STORE);
      return;
    }
    const decision = cacheDecision(c.req.raw, "http");
    if (decision.kind !== "shared") {
      c.res.headers.set("cache-control", PRIVATE_NO_STORE);
      annotate(c, { cache: `private:${decision.kind === "private" ? decision.reason : "none"}` });
      return;
    }
    const etag = await strongEtag(await response.clone().arrayBuffer());
    response.headers.set("cache-control", publicCacheControl(rule));
    response.headers.set("etag", etag);
    response.headers.set("vary", "accept-encoding");
    if (etagMatches(c.req.header("if-none-match") ?? null, etag)) {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      metric("http.conditional", 1, { rule: rule.id, outcome: "not-modified" });
      // Clearing first stops Hono from copying the 200's headers onto the 304.
      c.res = undefined;
      c.res = new Response(null, { status: 304, headers });
    }
  };
}
