/**
 * Parsers for the public feeds and APIs Medveris imports. They return plain-text fields only:
 * markup is stripped and entities decoded, so nothing from a feed is ever rendered as HTML.
 */

export interface FeedEntry {
  externalId: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: Date | null;
}

export type ImportedOpportunityType = "fellowship" | "training" | "funding";

export interface OpportunityEntry {
  externalId: string;
  title: string;
  description: string;
  organization: string;
  url: string;
  opensOn: string | null;
  closesOn: string | null;
  opportunityType: ImportedOpportunityType;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026", bull: "\u2022",
  middot: "\u00b7", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0", eacute: "\u00e9",
  egrave: "\u00e8", agrave: "\u00e0", ccedil: "\u00e7", ocirc: "\u00f4", uuml: "\u00fc", ouml: "\u00f6",
});

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+)$/i;
const MIN_SUMMARY_WORDS = 12;

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Plain text from an HTML fragment that may itself be entity-escaped (common in RSS descriptions). */
export function htmlToText(html: string): string {
  const markup = decodeEntities(unwrapCdata(html));
  const text = markup
    .replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

export function excerpt(text: string, max = 480): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s,.;:]+$/, "")}\u2026`;
}

/** Absolute http(s) URL with tracking parameters removed, or null when the value is not one. */
export function cleanUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(decodeEntities(raw.trim()), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.hash = "";
  return url.toString();
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function escapeTag(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagText(block: string, names: string[]): string | null {
  for (const name of names) {
    const match = new RegExp(`<${escapeTag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(name)}>`, "i").exec(block);
    if (match?.[1] != null) return unwrapCdata(match[1]);
  }
  return null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((match) => match[1] ?? "");
  const preferred = links.find((attrs) => !/\brel=/i.test(attrs) || /\brel=["']alternate["']/i.test(attrs)) ?? links[0];
  return preferred ? (/\bhref=["']([^"']+)["']/i.exec(preferred)?.[1] ?? null) : null;
}

/** RSS 2.0 `<item>` and Atom `<entry>` elements. Entries without a title or usable link are dropped. */
export function parseFeed(xml: string, baseUrl?: string): FeedEntry[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2] ?? "");
  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const title = htmlToText(tagText(block, ["title"]) ?? "");
    const rawLink = tagText(block, ["link"])?.trim() || atomLink(block);
    const url = cleanUrl(rawLink, baseUrl);
    if (!title || !url) continue;
    const guid = tagText(block, ["guid", "id"])?.trim();
    const externalId = guid ? decodeEntities(guid) : url;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    let summary = htmlToText(tagText(block, ["description", "summary", "content:encoded", "content"]) ?? "");
    if (summary.toLowerCase().startsWith(title.toLowerCase())) summary = summary.slice(title.length).trim();
    // Some feeds put only bylines and timestamps in the description; that is not a summary.
    if (summary.split(" ").length < MIN_SUMMARY_WORDS) summary = "";
    entries.push({
      externalId,
      title: excerpt(title, 300),
      summary: excerpt(summary || title),
      url,
      publishedAt: parseDate(tagText(block, ["pubDate", "published", "updated", "dc:date", "a10:updated"])),
    });
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

const WHO_DON_ITEM_BASE = "https://www.who.int/emergencies/disease-outbreak-news/item";

/** WHO Disease Outbreak News OData response (`/api/news/diseaseoutbreaknews`). */
export function parseWhoDiseaseOutbreakNews(payload: unknown): FeedEntry[] {
  if (!isRecord(payload) || !Array.isArray(payload.value)) throw new Error("Unexpected Disease Outbreak News response");
  const entries: FeedEntry[] = [];
  for (const item of payload.value) {
    if (!isRecord(item)) continue;
    const id = stringField(item, "Id");
    const path = stringField(item, "ItemDefaultUrl");
    const title = htmlToText((item.UseOverrideTitle === true && stringField(item, "OverrideTitle")) || stringField(item, "Title") || "");
    const url = path ? cleanUrl(`${WHO_DON_ITEM_BASE}${path.startsWith("/") ? path : `/${path}`}`) : null;
    if (!id || !title || !url) continue;
    entries.push({
      externalId: id,
      title: excerpt(title, 300),
      summary: excerpt(htmlToText(stringField(item, "Summary") ?? "") || title),
      url,
      publishedAt: parseDate(stringField(item, "PublicationDateAndTime")),
    });
  }
  return entries;
}

/** Grants.gov dates are MM/DD/YYYY. */
function usDate(raw: string | null): string | null {
  const match = raw ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim()) : null;
  return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
}

function grantType(title: string): ImportedOpportunityType {
  if (/fellow/i.test(title)) return "fellowship";
  if (/train|scholar|career development|mentor/i.test(title)) return "training";
  return "funding";
}

/** Grants.gov Search2 response (`POST /v1/api/search2`). */
export function parseGrantsGovSearch(payload: unknown): OpportunityEntry[] {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || !Array.isArray(data.oppHits)) throw new Error("Unexpected Grants.gov search response");
  const entries: OpportunityEntry[] = [];
  for (const hit of data.oppHits) {
    if (!isRecord(hit)) continue;
    const id = stringField(hit, "id");
    const title = htmlToText(stringField(hit, "title") ?? "");
    if (!id || !/^\d+$/.test(id) || !title) continue;
    const agency = htmlToText(stringField(hit, "agency") ?? "") || "U.S. federal agency";
    const number = stringField(hit, "number");
    const forecast = stringField(hit, "oppStatus") === "forecasted";
    entries.push({
      externalId: id,
      title: excerpt(title, 300),
      description: `${forecast ? "Forecasted" : "Open"} funding opportunity${number ? ` ${number}` : ""} from ${agency}. `
        + "Eligibility is set by the funder; many U.S. federal opportunities are limited to U.S.-based organisations or citizens.",
      organization: agency,
      url: `https://www.grants.gov/search-results-detail/${id}`,
      opensOn: usDate(stringField(hit, "openDate")),
      closesOn: usDate(stringField(hit, "closeDate")),
      opportunityType: grantType(title),
    });
  }
  return entries;
}
