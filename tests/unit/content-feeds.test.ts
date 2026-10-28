import { describe, expect, it } from "vitest";
import {
  cleanUrl,
  decodeEntities,
  excerpt,
  htmlToText,
  parseFeed,
  parseGrantsGovSearch,
  parseWhoDiseaseOutbreakNews,
} from "../../apps/jobs/src/feeds/parse.js";

const LONG_SUMMARY = "Health ministers agreed a new regional plan to expand vaccination, strengthen surveillance and train community health workers across twelve districts.";

describe("feed text handling", () => {
  it("decodes named and numeric entities and leaves unknown ones alone", () => {
    expect(decodeEntities("Fish &amp; chips &#8211; &#x2014; &rsquo; &bogus;")).toBe("Fish & chips \u2013 \u2014 \u2019 &bogus;");
  });

  it("strips escaped markup, scripts and CDATA to plain text", () => {
    expect(htmlToText("<![CDATA[<p>Hello <b>world</b></p><script>alert(1)</script>]]>")).toBe("Hello world");
    expect(htmlToText("&lt;p&gt;Escaped &amp;amp; markup&lt;/p&gt;")).toBe("Escaped & markup");
  });

  it("cuts long text at a word boundary with an ellipsis", () => {
    const text = excerpt("word ".repeat(200).trim(), 50);
    expect(text.length).toBeLessThanOrEqual(51);
    expect(text.endsWith("\u2026")).toBe(true);
    expect(excerpt("short")).toBe("short");
  });

  it("accepts only http(s) URLs and removes tracking parameters", () => {
    expect(cleanUrl("https://example.org/a?utm_source=x&id=7#top")).toBe("https://example.org/a?id=7");
    expect(cleanUrl("/news/1", "https://www.who.int/rss")).toBe("https://www.who.int/news/1");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("not a url")).toBeNull();
    expect(cleanUrl(null)).toBeNull();
  });
});

describe("parseFeed", () => {
  it("reads RSS items, dedupes by guid and drops items without a title or link", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Plan &amp; vaccines</title><link>https://example.org/a?utm_medium=rss</link><guid>a-1</guid>
        <description><![CDATA[<p>${LONG_SUMMARY}</p>]]></description><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate></item>
      <item><title>Plan &amp; vaccines</title><link>https://example.org/a</link><guid>a-1</guid></item>
      <item><title></title><link>https://example.org/b</link></item>
      <item><title>No link</title></item>
    </channel></rss>`;
    const entries = parseFeed(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ externalId: "a-1", title: "Plan & vaccines", summary: LONG_SUMMARY, url: "https://example.org/a" });
    expect(entries[0]!.publishedAt?.toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("falls back to the title when the description is only a byline", () => {
    const xml = `<rss><channel><item><title>Outbreak update</title><link>https://example.org/c</link>
      <description>Outbreak update 26 October 2026 | News</description></item></channel></rss>`;
    const [entry] = parseFeed(xml);
    expect(entry).toMatchObject({ externalId: "https://example.org/c", summary: "Outbreak update" });
    expect(entry!.publishedAt).toBeNull();
  });

  it("reads Atom entries with relative alternate links", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:x,1</id><title type="html">Atom &lt;i&gt;item&lt;/i&gt;</title>
      <link rel="self" href="https://example.org/self"/><link rel="alternate" href="/news/atom-1"/>
      <summary>${LONG_SUMMARY}</summary><updated>2026-10-01T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(xml, "https://example.org/feed")).toEqual([{
      externalId: "tag:x,1", title: "Atom item", summary: LONG_SUMMARY, url: "https://example.org/news/atom-1",
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    }]);
  });
});

describe("parseWhoDiseaseOutbreakNews", () => {
  it("builds item URLs, prefers override titles and rejects unexpected payloads", () => {
    const entries = parseWhoDiseaseOutbreakNews({
      value: [
        { Id: "d1", Title: "Cholera - Country A", UseOverrideTitle: true, OverrideTitle: "Cholera \u2013 Country A (update)", Summary: `<p>${LONG_SUMMARY}</p>`, PublicationDateAndTime: "2026-10-20T10:00:00Z", ItemDefaultUrl: "/2026-DON900" },
        { Id: "d2", Title: "Missing URL" },
        "junk",
      ],
    });
    expect(entries).toEqual([{
      externalId: "d1", title: "Cholera \u2013 Country A (update)", summary: LONG_SUMMARY,
      url: "https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON900", publishedAt: new Date("2026-10-20T10:00:00Z"),
    }]);
    expect(() => parseWhoDiseaseOutbreakNews({ items: [] })).toThrow(/Unexpected/);
  });
});

describe("parseGrantsGovSearch", () => {
  it("maps hits to opportunities with ISO dates and an inferred type", () => {
    const entries = parseGrantsGovSearch({
      data: {
        oppHits: [
          { id: "100", number: "PAR-26-001", title: "Global Health Research Fellowship", agency: "National Institutes of Health", openDate: "10/01/2026", closeDate: "01/15/2027", oppStatus: "posted" },
          { id: "101", title: "Research Training Program", agency: "Fogarty International Center", oppStatus: "forecasted" },
          { id: "102", title: "Laboratory Capacity Grants" },
          { id: "abc", title: "Bad id" },
        ],
      },
    });
    expect(entries.map((entry) => [entry.externalId, entry.opportunityType])).toEqual([["100", "fellowship"], ["101", "training"], ["102", "funding"]]);
    expect(entries[0]).toMatchObject({ opensOn: "2026-10-01", closesOn: "2027-01-15", organization: "National Institutes of Health", url: "https://www.grants.gov/search-results-detail/100" });
    expect(entries[0]!.description).toMatch(/^Open funding opportunity PAR-26-001 from National Institutes of Health\./);
    expect(entries[1]!.description).toMatch(/^Forecasted/);
    expect(entries[2]).toMatchObject({ organization: "U.S. federal agency", opensOn: null, closesOn: null });
    expect(() => parseGrantsGovSearch({ errorcode: 1 })).toThrow(/Unexpected/);
  });
});
