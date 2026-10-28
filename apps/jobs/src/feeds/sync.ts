import type { Sql } from "@medveris/db";
import {
  excerpt,
  parseFeed,
  parseGrantsGovSearch,
  parseWhoDiseaseOutbreakNews,
  type FeedEntry,
  type OpportunityEntry,
} from "./parse.js";

/** Non-login account that authors every imported item (migration 027). */
export const CONTENT_IMPORTER_USER_ID = "00000000-0000-4000-8000-00000000feed";

const USER_AGENT = "MedverisContentBot/1.0 (+https://medveris.online)";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CONTENT_TYPES = new Set(["public-health-advisory", "health-education", "research-update", "guideline", "professional-learning", "health-news"]);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FeedSyncOptions {
  fetch?: FetchLike;
  now?: Date;
  /** Sources processed per call; the rest wait for the next cycle. */
  maxSources?: number;
  timeoutMs?: number;
}

export interface FeedSyncResult {
  sourceId: string;
  name: string;
  outcome: "imported" | "failed";
  fetched: number;
  inserted: number;
  error?: string;
}

interface SourceRow {
  id: string;
  name: string;
  ingestAdapter: "rss" | "who-don" | "grants-gov";
  ingestUrl: string;
  ingestConfig: Record<string, unknown>;
  termsNote: string | null;
}

interface SourceSettings {
  contentType: string;
  maxItems: number;
  maxAgeDays: number;
  priority: number;
  geography: string | null;
  keyword: string | null;
  fundingCategories: string | null;
}

function settings(config: Record<string, unknown>): SourceSettings {
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const value = Number(config[key]);
    return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback;
  };
  const text = (key: string): string | null => (typeof config[key] === "string" && config[key] ? String(config[key]) : null);
  const contentType = text("contentType") ?? "health-news";
  return {
    contentType: CONTENT_TYPES.has(contentType) ? contentType : "health-news",
    maxItems: number("maxItems", 15, 1, 50),
    maxAgeDays: number("maxAgeDays", 90, 1, 3650),
    priority: number("priority", 40, 0, 100),
    geography: text("geography"),
    keyword: text("keyword"),
    fundingCategories: text("fundingCategories"),
  };
}

async function fetchBody(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) throw new Error("Response exceeds the size limit");
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new Error("Response exceeds the size limit");
  return body;
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
}

async function fetchArticles(source: SourceRow, options: SourceSettings, fetchImpl: FetchLike, timeoutMs: number): Promise<FeedEntry[]> {
  if (source.ingestAdapter === "who-don") {
    const url = new URL(source.ingestUrl);
    url.searchParams.set("sf_culture", "en");
    url.searchParams.set("$top", String(options.maxItems));
    url.searchParams.set("$orderby", "PublicationDateAndTime desc");
    url.searchParams.set("$select", "Id,Title,OverrideTitle,UseOverrideTitle,Summary,PublicationDateAndTime,ItemDefaultUrl");
    const body = await fetchBody(fetchImpl, url.toString(), { headers: { accept: "application/json" } }, timeoutMs);
    return parseWhoDiseaseOutbreakNews(parseJson(body, "Disease Outbreak News"));
  }
  const body = await fetchBody(fetchImpl, source.ingestUrl, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } }, timeoutMs);
  if (!/<(rss|feed|rdf:RDF)\b/i.test(body.slice(0, 2000))) throw new Error("The feed URL did not return RSS or Atom");
  return parseFeed(body, source.ingestUrl);
}

async function fetchOpportunities(source: SourceRow, options: SourceSettings, fetchImpl: FetchLike, timeoutMs: number): Promise<OpportunityEntry[]> {
  const body = await fetchBody(fetchImpl, source.ingestUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      keyword: options.keyword ?? "",
      fundingCategories: options.fundingCategories ?? "",
      oppStatuses: "forecasted|posted",
      rows: options.maxItems,
    }),
  }, timeoutMs);
  return parseGrantsGovSearch(parseJson(body, "Grants.gov"));
}

function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

async function shortHash(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest.slice(0, 5)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function storeArticles(sql: Sql, source: SourceRow, options: SourceSettings, entries: FeedEntry[], now: Date): Promise<number> {
  const oldest = now.getTime() - options.maxAgeDays * 86_400_000;
  const recent = entries
    .filter((entry) => !entry.publishedAt || (entry.publishedAt.getTime() >= oldest && entry.publishedAt.getTime() <= now.getTime() + 86_400_000))
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, options.maxItems);
  const attribution = `Source: ${source.name}. Imported automatically on ${isoDate(now)}; not reviewed by Medveris.`;
  let inserted = 0;
  for (const entry of recent) {
    const rows = await sql`
      insert into content_items (id, tenant_id, content_type, slug, title, summary, source_id, source_organization, source_url,
        publication_date, retrieval_date, language, geography, audience, visibility_scope, attribution, reuse_terms,
        peer_review_status, clinical_reviewed, editorial_priority, status, author_user_id, published_at, external_id, imported_at)
      values (${crypto.randomUUID()}, null, ${options.contentType}, ${`${slugify(entry.title)}-${await shortHash(`${source.id}:${entry.externalId}`)}`},
        ${entry.title}, ${excerpt(entry.summary)}, ${source.id}, ${source.name}, ${entry.url},
        ${entry.publishedAt ? isoDate(entry.publishedAt) : isoDate(now)}, ${isoDate(now)}, 'en', ${options.geography},
        'general', 'public', ${attribution}, ${source.termsNote}, 'not-applicable', false, ${options.priority},
        'published', ${CONTENT_IMPORTER_USER_ID}, ${now}, ${entry.externalId.slice(0, 500)}, ${now})
      on conflict (source_id, external_id) where external_id is not null do nothing
      returning id
    `;
    inserted += rows.length;
  }
  return inserted;
}

async function storeOpportunities(sql: Sql, source: SourceRow, options: SourceSettings, entries: OpportunityEntry[], now: Date): Promise<number> {
  const today = isoDate(now);
  let inserted = 0;
  for (const entry of entries.slice(0, options.maxItems)) {
    if (entry.closesOn && entry.closesOn < today) continue;
    const opensOn = entry.opensOn && entry.closesOn && entry.opensOn > entry.closesOn ? null : entry.opensOn;
    const rows = await sql`
      insert into opportunities (id, tenant_id, opportunity_type, title, description, organization, audience, specialty_tags,
        remote, application_url, opens_on, closes_on, source_evidence, verification_status, sponsorship_status,
        moderation_state, author_user_id, published_at, source_id, external_id, imported_at)
      values (${crypto.randomUUID()}, null, ${entry.opportunityType}, ${entry.title}, ${entry.description}, ${entry.organization},
        'professional', '{}', true, ${entry.url}, ${opensOn}, ${entry.closesOn},
        ${`Imported automatically from ${source.name} on ${today}; not verified by Medveris.`}, 'unverified', 'none',
        'published', ${CONTENT_IMPORTER_USER_ID}, ${now}, ${source.id}, ${entry.externalId.slice(0, 500)}, ${now})
      on conflict (source_id, external_id) where external_id is not null do nothing
      returning id
    `;
    inserted += rows.length;
  }
  return inserted;
}

/**
 * Imports due platform-wide sources. Runs as medveris_jobs, which may insert imported items but
 * never update or delete content. A failing source is recorded and does not stop the others.
 */
export async function syncContentFeeds(sql: Sql, options: FeedSyncOptions = {}): Promise<FeedSyncResult[]> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sources = await sql<SourceRow[]>`
    select id, name, ingest_adapter, ingest_url, ingest_config, terms_note
      from content_sources
     where tenant_id is null and ingest_enabled and ingest_adapter is not null and ingest_url is not null
       and (last_checked_at is null or last_checked_at <= ${now}::timestamptz - make_interval(mins => fetch_interval_minutes))
     order by last_checked_at nulls first, name
     limit ${options.maxSources ?? 3}
  `;
  const results: FeedSyncResult[] = [];
  for (const source of sources) {
    const sourceSettings = settings(source.ingestConfig ?? {});
    try {
      let fetched: number;
      let inserted: number;
      if (source.ingestAdapter === "grants-gov") {
        const entries = await fetchOpportunities(source, sourceSettings, fetchImpl, timeoutMs);
        fetched = entries.length;
        inserted = await storeOpportunities(sql, source, sourceSettings, entries, now);
      } else {
        const entries = await fetchArticles(source, sourceSettings, fetchImpl, timeoutMs);
        fetched = entries.length;
        inserted = await storeArticles(sql, source, sourceSettings, entries, now);
      }
      await sql`
        update content_sources set status = 'available', last_checked_at = ${now}, last_success_at = ${now},
          last_error = null, last_item_count = ${inserted}, updated_at = now()
         where id = ${source.id}
      `;
      results.push({ sourceId: source.id, name: source.name, outcome: "imported", fetched, inserted });
    } catch (error) {
      const message = ((error as Error).name === "TimeoutError" ? "Timed out fetching the source" : (error as Error).message).slice(0, 500);
      await sql`
        update content_sources set status = 'unavailable', last_checked_at = ${now}, last_error = ${message}, updated_at = now()
         where id = ${source.id}
      `;
      results.push({ sourceId: source.id, name: source.name, outcome: "failed", fetched: 0, inserted: 0, error: message });
    }
  }
  return results;
}
