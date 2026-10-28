import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, type Sql, type Tx } from "@medveris/db";
import { CONTENT_IMPORTER_USER_ID, syncContentFeeds } from "../../apps/jobs/src/feeds/sync.js";
import { createHarness, type Session } from "./support.js";

const WHO_NEWS = "c0f1ed00-0000-4000-8000-000000000001";
const WHO_AFRO = "c0f1ed00-0000-4000-8000-000000000003";
const GRANTS_FELLOWSHIPS = "c0f1ed00-0000-4000-8000-000000000005";
const SUMMARY = "Health ministers agreed a new regional plan to expand vaccination, strengthen surveillance and train community health workers across twelve districts.";

const jobsUrl = process.env.JOBS_DATABASE_URL;
if (!jobsUrl) throw new Error("JOBS_DATABASE_URL is required for content feed tests");
const jobs = createSql(jobsUrl, { max: 2 });
const { call, expectOk, login } = createHarness("content-feeds");

class Rollback extends Error {}

/** Runs as medveris_jobs and always rolls back, so seeded source state is left untouched. */
async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await jobs.begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

function rss(items: Array<{ guid: string; title: string; pubDate: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${items.map((item) => `
    <item><title>${item.title}</title><link>https://www.who.int/news/item/${item.guid}</link><guid>${item.guid}</guid>
      <description>&lt;p&gt;${SUMMARY}&lt;/p&gt;</description><pubDate>${item.pubDate}</pubDate></item>`).join("")}
  </channel></rss>`;
}

function respond(body: string, status = 200, type = "application/rss+xml"): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

afterAll(async () => {
  await jobs.end({ timeout: 5 });
});

describe("content feed import job", () => {
  it("imports recent feed items and open opportunities once, as the importer", async () => {
    const run = crypto.randomUUID();
    const grantId = String(Date.now());
    const now = new Date("2026-10-27T12:00:00Z");
    const fetched: string[] = [];
    const fetch = async (url: string): Promise<Response> => {
      fetched.push(url);
      if (url.includes("who.int/rss-feeds")) {
        return respond(rss([
          { guid: `${run}-new`, title: "Regional vaccination plan agreed", pubDate: "Mon, 26 Oct 2026 09:00:00 GMT" },
          { guid: `${run}-old`, title: "An item from long ago", pubDate: "Mon, 05 Jan 2020 09:00:00 GMT" },
        ]));
      }
      if (url.includes("api.grants.gov")) {
        return respond(JSON.stringify({ data: { oppHits: [
          { id: grantId, title: "Global Health Research Fellowship", agency: "Fogarty International Center", openDate: "10/01/2026", closeDate: "01/15/2027", oppStatus: "posted" },
          { id: "1", title: "Closed training call", agency: "NIH", closeDate: "01/01/2026", oppStatus: "posted" },
        ] } }), 200, "application/json");
      }
      return respond("unavailable", 503, "text/plain");
    };

    await rolledBack(async (tx) => {
      const sql = tx as unknown as Sql;
      await tx`update content_sources set last_checked_at = ${now} where tenant_id is null and ingest_adapter is not null`;
      await tx`update content_sources set last_checked_at = null, ingest_enabled = true where id in (${WHO_NEWS}, ${WHO_AFRO}, ${GRANTS_FELLOWSHIPS})`;

      const first = await syncContentFeeds(sql, { fetch, now, maxSources: 10 });
      expect(first.map((result) => [result.sourceId, result.outcome, result.inserted]).sort()).toEqual([
        [GRANTS_FELLOWSHIPS, "imported", 1],
        [WHO_AFRO, "failed", 0],
        [WHO_NEWS, "imported", 1],
      ].sort());
      expect(fetched).toHaveLength(3);

      const [article] = await tx`
        select status, content_type, title, summary, source_url, author_user_id, clinical_reviewed, visibility_scope, attribution, imported_at
          from content_items where source_id = ${WHO_NEWS} and external_id = ${`${run}-new`}
      `;
      expect(article).toMatchObject({
        status: "published", contentType: "health-news", title: "Regional vaccination plan agreed", summary: SUMMARY,
        sourceUrl: `https://www.who.int/news/item/${run}-new`, authorUserId: CONTENT_IMPORTER_USER_ID, clinicalReviewed: false, visibilityScope: "public",
      });
      expect(article!.attribution).toMatch(/not reviewed by Medveris/);
      expect((await tx`select 1 from content_items where external_id = ${`${run}-old`}`).length).toBe(0);

      const [opportunity] = await tx`
        select opportunity_type, moderation_state, verification_status, closes_on::text as closes_on
          from opportunities where source_id = ${GRANTS_FELLOWSHIPS} and imported_at = ${now}
      `;
      expect(opportunity).toEqual({ opportunityType: "fellowship", moderationState: "published", verificationStatus: "unverified", closesOn: "2027-01-15" });

      const [afro] = await tx`select status, last_error, last_success_at from content_sources where id = ${WHO_AFRO}`;
      expect(afro).toMatchObject({ status: "unavailable", lastError: "HTTP 503 from www.afro.who.int", lastSuccessAt: null });

      expect(await syncContentFeeds(sql, { fetch, now, maxSources: 10 })).toEqual([]);
      const later = new Date(now.getTime() + 7 * 3_600_000);
      await tx`update content_sources set last_checked_at = ${later} where id not in (${WHO_NEWS}, ${GRANTS_FELLOWSHIPS}) and ingest_adapter is not null`;
      const second = await syncContentFeeds(sql, { fetch, now: later, maxSources: 10 });
      expect(second.map((result) => [result.sourceId, result.outcome, result.fetched, result.inserted]).sort()).toEqual([
        [GRANTS_FELLOWSHIPS, "imported", 2, 0],
        [WHO_NEWS, "imported", 2, 0],
      ].sort());

      await expect(tx.savepoint((sp) => sp`update content_items set title = 'Changed' where external_id = ${`${run}-new`}`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`delete from opportunities where source_id = ${GRANTS_FELLOWSHIPS}`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe("imported content API", () => {
  let staff: Session;
  let operator: Session;
  const opportunityId = crypto.randomUUID();
  const itemId = crypto.randomUUID();

  beforeAll(async () => {
    [staff, operator] = await Promise.all([login("admin@medveris.local"), login("reviewer@medveris.local")]);
    const external = `api-test-${crypto.randomUUID()}`;
    await jobs`
      insert into content_items (id, tenant_id, content_type, slug, title, summary, source_id, source_organization, source_url,
        publication_date, language, audience, visibility_scope, attribution, clinical_reviewed, status, author_user_id,
        published_at, external_id, imported_at)
      values (${itemId}, null, 'health-news', ${external}, 'Imported test headline', ${SUMMARY}, ${WHO_NEWS}, 'WHO',
        ${`https://www.who.int/news/item/${external}`}, current_date, 'en', 'general', 'public', 'Imported for a test',
        false, 'published', ${CONTENT_IMPORTER_USER_ID}, now(), ${external}, now())
    `;
    await jobs`
      insert into opportunities (id, tenant_id, opportunity_type, title, description, organization, audience, specialty_tags,
        remote, application_url, source_evidence, verification_status, sponsorship_status, moderation_state,
        author_user_id, published_at, source_id, external_id, imported_at)
      values (${opportunityId}, null, 'funding', 'Imported test funding call', 'Open funding opportunity for a test.', 'Test funder',
        'professional', '{}', true, 'https://www.grants.gov/search-results-detail/1', 'Imported for a test', 'unverified', 'none',
        'published', ${CONTENT_IMPORTER_USER_ID}, now(), ${GRANTS_FELLOWSHIPS}, ${external}, now())
    `;
  });

  it("lists sources to staff and to platform operators without a facility role", async () => {
    const forStaff = await expectOk(await call(staff, "/api/v1/content-feeds"));
    expect(forStaff.canManage).toBe(false);
    expect(forStaff.sources.map((source: { id: string }) => source.id)).toContain(WHO_NEWS);
    const forOperator = await expectOk(await call(operator, "/api/v1/content-feeds"));
    expect(forOperator.canManage).toBe(true);
  });

  it("filters imported opportunities and lets only an operator withdraw imports", async () => {
    const imported = await expectOk(await call(staff, "/api/v1/opportunities?imported=true&limit=100"));
    expect(imported.opportunities.every((row: { importedAt: string | null }) => row.importedAt)).toBe(true);
    expect(imported.opportunities.map((row: { id: string }) => row.id)).toContain(opportunityId);

    const body = JSON.stringify({ note: "Test withdrawal of imported items" });
    expect((await call(staff, `/api/v1/content-feeds/opportunities/${opportunityId}/withdraw`, { method: "POST", body })).status).toBe(403);
    await expectOk(await call(operator, `/api/v1/content-feeds/opportunities/${opportunityId}/withdraw`, { method: "POST", body }));
    await expectOk(await call(operator, `/api/v1/content-feeds/items/${itemId}/withdraw`, { method: "POST", body }));
    expect((await call(operator, `/api/v1/content-feeds/items/${itemId}/withdraw`, { method: "POST", body })).status).toBe(409);

    const after = await expectOk(await call(staff, "/api/v1/opportunities?imported=true&limit=100"));
    expect(after.opportunities.map((row: { id: string }) => row.id)).not.toContain(opportunityId);
    const feed = await expectOk(await call(staff, "/api/v1/content?type=health-news&limit=100"));
    expect(feed.items.map((row: { id: string }) => row.id)).not.toContain(itemId);
  });

  it("lets only an operator pause and resume a source", async () => {
    const pause = JSON.stringify({ enabled: false, note: "Pausing during a test" });
    expect((await call(staff, `/api/v1/content-feeds/${WHO_AFRO}/ingest`, { method: "POST", body: pause })).status).toBe(403);
    const [before] = await jobs`select ingest_enabled, status from content_sources where id = ${WHO_AFRO}`;
    try {
      await expectOk(await call(operator, `/api/v1/content-feeds/${WHO_AFRO}/ingest`, { method: "POST", body: pause }));
      const [paused] = await jobs`select ingest_enabled, status from content_sources where id = ${WHO_AFRO}`;
      expect(paused).toEqual({ ingestEnabled: false, status: "disabled" });
    } finally {
      await jobs`update content_sources set ingest_enabled = ${before!.ingestEnabled}, status = ${before!.status} where id = ${WHO_AFRO}`;
    }
  });
});
