// The news feed dry test's checks. No network: every source format is a recorded sample (Nov 6 2026, the same
// samples Market Waves tests with), and the collector's end-to-end check runs against a fake fetch.
// Run: node newsfeed/test/test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as R from "../lib/parse.mjs";
import * as S from "../lib/sources.mjs";
import * as C from "../collect.mjs";
import * as K from "../scorecard.mjs";

let n = 0;
const ok = (msg) => { n++; console.log(`  ok ${n} - ${msg}`); };

// ---------- normalizing ----------
assert.equal(R.isoS("Fri, 6 Nov 2026 06:43:00 +0000"), "2026-11-06T06:43:00Z");
assert.equal(R.isoS("2026-11-05T16:05:12.987-05:00"), "2026-11-05T21:05:12Z", "to the second");
assert.equal(R.isoS("nonsense"), null); assert.equal(R.isoS(null), null);
assert.equal(R.normTitle("BREAKING: Micron   pauses work on Taiwan plant!"), "micron pauses work on taiwan plant");
assert.equal(R.dedupeKey("Update 2: Micron pauses work on Taiwan plant"), R.dedupeKey("micron pauses work on taiwan plant."), "prefix, case and punctuation don't count");
assert.notEqual(R.dedupeKey("Micron pauses work on Taiwan plant"), R.dedupeKey("Micron resumes work on Taiwan plant"));
assert.equal(R.urlKey("https://www.NPR.org/2026/11/05/nx-s1-6031987/stock-markets?utm=x#top"), "npr.org/2026/11/05/nx-s1-6031987/stock-markets");
assert.equal(R.urlKey("http://example.com/a/"), "example.com/a"); assert.equal(R.urlKey("not a url"), null); assert.equal(R.urlKey("ftp://x.com/a"), null);
assert.deepEqual(R.tickersIn("Micron (NASDAQ: MU) and Vistra (NYSE:VST) report; $SNDK too; $1.5 billion", "NYSE American: XYZ"), ["SNDK", "MU", "VST", "XYZ"]);
const it = R.item({ source: "npr_business", source_id: "g1", published_at: "Fri, 6 Nov 2026 06:43:00 +0000", title: "&lt;b&gt;Acme&lt;/b&gt; (NASDAQ: ACME) &amp; Co. results", summary: "<p>Text &amp; more</p>", url: "https://www.npr.org/x.html", tickers: ["msft", "not a ticker!"] });
assert.deepEqual([it.title, it.summary, it.tickers, it.time_basis, it.published_at], ["Acme (NASDAQ: ACME) & Co. results", "Text & more", ["MSFT", "ACME"], "published", "2026-11-06T06:43:00Z"]);
assert.equal(R.item({ source: "x", source_id: "1", title: "  " }), null, "no title, no item");
assert.equal(R.item({ source: "x", source_id: "1", title: "t" }).time_basis, "day", "no time: a day item");
// The tape's keyword tags of the title, for matching an alarm to its story (the tickers stay in tickers).
assert.deepEqual(R.item({ source: "fed", source_id: "f1", title: "Fed raises interest rates as oil prices jump" }).tags.sort(), ["fed", "oil", "rates"]);
assert.deepEqual(R.tagsOf("Nvidia earnings: $NVDA beats").sort(), ["ai", "earnings"], "an earnings title's cashtag stays out of tags");
assert.deepEqual(R.tagsOf("Quarterly Refunding Statement"), []);
ok("normalizing: times to the second, the title and url keys, tickers named in the text (cashtags and exchange tags), entities and tags out, the title's keyword tags");

// ---------- parsers (each source's recorded format) ----------
const npr = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>NPR Topics: Business</title>
<item><title>Fears of an AI crackdown after midterms spark $2 trillion rout in tech stocks</title><description>Shares sank, with the tech-heavy Nasdaq dropping over 5%.</description><pubDate>Thu, 05 Nov 2026 19:16:53 -0500</pubDate><link>https://www.npr.org/2026/11/05/nx-s1-6031987/stock-markets-ai-midterm-elections</link><guid>https://www.npr.org/2026/11/05/nx-s1-6031987/stock-markets-ai-midterm-elections</guid></item>
<item><title>Untimed item</title><link>https://www.npr.org/u-1</link></item>
</channel></rss>`;
const p = R.parseFeed(npr, "npr_business");
assert.equal(p.length, 2);
assert.deepEqual([p[0].source_id, p[0].published_at, p[0].kind, p[0].summary.slice(0, 11)], ["https://www.npr.org/2026/11/05/nx-s1-6031987/stock-markets-ai-midterm-elections", "2026-11-06T00:16:53Z", "headline", "Shares sank"]);
assert.ok(p[0].tags.includes("ai"));
assert.deepEqual([p[1].published_at, p[1].time_basis, p[1].source_id], [null, "day", "https://www.npr.org/u-1"]);
const fed = `<rss><channel><item><title>Federal Reserve issues FOMC statement</title><link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm]]></link><guid><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm]]></guid><category>Monetary Policy</category><pubDate><![CDATA[Wed, 09 Dec 2026 19:00:00 GMT]]></pubDate></item></channel></rss>`;
assert.deepEqual(R.parseFeed(fed, "fed").map((x) => [x.published_at, x.url]), [["2026-12-09T19:00:00Z", "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm"]]);
const conv = `<feed><entry><id>tag:theconversation.com,2011:article/295716</id><published>2026-11-04T22:48:26Z</published><updated>2026-11-04T22:48:26Z</updated><link rel="alternate" type="text/html" href="https://theconversation.com/florida-just-voted-295716"/><title>Florida just voted for lower property taxes</title><summary>s</summary></entry></feed>`;
assert.deepEqual(R.parseFeed(conv, "conversation_business", { kind: "article" }).map((x) => [x.source_id, x.url, x.published_at, x.kind]), [["tag:theconversation.com,2011:article/295716", "https://theconversation.com/florida-just-voted-295716", "2026-11-04T22:48:26Z", "article"]]);
const cat = `<rss><channel><item><title>Seagate update</title><link>https://ex.com/x.html</link><guid isPermaLink="false">3184001</guid><pubDate>Thu, 05 Nov 2026 13:30 GMT</pubDate><category domain="https://ex.com/rss/stock">NASDAQ:STX</category></item></channel></rss>`;
assert.deepEqual(R.parseFeed(cat, "x").map((x) => [x.source_id, x.tickers, x.published_at]), [["3184001", ["STX"], "2026-11-05T13:30:00Z"]]);
ok("feeds: RSS (NPR) and Atom (The Conversation), guid or link as the id, CDATA links and times (the Fed), a stock category as a ticker, an item with no time kept as a day item");

const secAtom = `<feed><entry><title>8-K - MICRON TECHNOLOGY INC (0000723125) (Filer)</title><link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/723125/000072312526000123/0000723125-26-000123-index.htm"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-11-05 &lt;b&gt;AccNo:&lt;/b&gt; 0000723125-26-000123 &lt;b&gt;Size:&lt;/b&gt; 1 MB&lt;br&gt;Item 7.01: Regulation FD Disclosure&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>
<updated>2026-11-05T16:05:12-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="8-K"/><id>urn:tag:sec.gov,2008:accession-number=0000723125-26-000123</id></entry>
<entry><title>6-K - Taiwan Semiconductor Manufacturing Co Ltd (0001046179) (Filer)</title><link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1046179/x-index.htm"/><summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-11-05 &lt;b&gt;AccNo:&lt;/b&gt; 0001046179-26-000077 &lt;b&gt;Size:&lt;/b&gt; 52 KB</summary><updated>2026-11-05T06:01:44-05:00</updated><id>urn:tag:sec.gov,2008:accession-number=0001046179-26-000077</id></entry>
<entry><title>not a filing line</title><summary>nothing</summary></entry></feed>`;
const ciks = R.cikMap({ 0: { cik_str: 723125, ticker: "MU", title: "MICRON TECHNOLOGY INC" }, 1: { cik_str: 1046179, ticker: "TSM", title: "TAIWAN SEMICONDUCTOR" }, 2: { cik_str: 723125, ticker: "MU-X", title: "dup" } });
assert.deepEqual([...ciks.entries()], [["723125", "MU"], ["1046179", "TSM"]], "the first ticker per CIK");
const sec = R.parseSec(secAtom, "sec_8k", ciks);
assert.equal(sec.length, 2);
assert.deepEqual([sec[0].source_id, sec[0].published_at, sec[0].time_basis, sec[0].title, sec[0].tickers, sec[0].kind, sec[0].raw.items], ["0000723125-26-000123", "2026-11-05T21:05:12Z", "filed", "8-K MICRON TECHNOLOGY INC (Item 7.01, 9.01)", ["MU"], "filing", ["7.01", "9.01"]]);
assert.deepEqual([sec[1].title, sec[1].tickers], ["6-K Taiwan Semiconductor Manufacturing Co Ltd", ["TSM"]]);
ok("SEC: the current-filings Atom: form, company, items, the acceptance time to the second (filed), the accession number as the id, the ticker from SEC's CIK list");

// The Federal Register's public inspection (the recorded current.json shape): filed_at to the minute, before publication.
const fr = { count: 2, results: [
  { agencies: [{ raw_name: "CONSUMER PRODUCT SAFETY COMMISSION", name: "Consumer Product Safety Commission", slug: "consumer-product-safety-commission" }], agency_names: ["Consumer Product Safety Commission"], document_number: "2026-22661", filed_at: "2026-11-04T11:15:00.000-05:00", filing_type: "special", html_url: "https://www.federalregister.gov/public-inspection/2026-22661/meetings-sunshine-act", publication_date: "2026-11-06", title: "Meetings; Sunshine Act  ", type: "Notice" },
  { document_number: "2026-22700", title: "No time yet", type: "Rule", html_url: "https://www.federalregister.gov/public-inspection/2026-22700/x" },
] };
assert.deepEqual(R.parseFedRegPI(fr).map((x) => [x.source_id, x.published_at, x.time_basis, x.kind, x.title, x.summary, x.raw.publication_date]), [
  ["2026-22661", "2026-11-04T16:15:00Z", "filed", "rule", "Meetings; Sunshine Act", "Notice. Consumer Product Safety Commission. special filing. publishes 2026-11-06", "2026-11-06"],
  ["2026-22700", null, "day", "rule", "No time yet", "Rule", null],
]);
// The Treasury's list page (the recorded markup: unquoted attributes).
const tre = `<div><span class=date-format><time datetime=2026-11-05T18:00:00Z class=datetime>November 5, 2026</time>
</span><span></span><h3 class=featured-stories__headline><a href=/news/press-releases/sb0683/ hreflang=en>Treasury Acts Against Global Scam Networks &amp; Their Enablers</a></h3></div><div><span class=date-format><time datetime="2026-11-04T13:30:00Z" class=datetime>November 4, 2026</time></span><h3 class="featured-stories__headline"><a href="https://home.treasury.gov/news/press-releases/sb0678/" hreflang=en>Quarterly Refunding Statement</a></h3></div>`;
assert.deepEqual(R.parseTreasury(tre).map((x) => [x.source_id, x.published_at, x.title, x.url, x.kind]), [
  ["sb0683", "2026-11-05T18:00:00Z", "Treasury Acts Against Global Scam Networks & Their Enablers", "https://home.treasury.gov/news/press-releases/sb0683/", "release"],
  ["sb0678", "2026-11-04T13:30:00Z", "Quarterly Refunding Statement", "https://home.treasury.gov/news/press-releases/sb0678/", "release"],
]);
assert.deepEqual(R.parseTreasury("<html>nothing</html>"), []);
const page = "URL: https://www.bls.gov/feed/bls_latest.rss\nFINAL_URL: https://www.bls.gov/feed/bls_latest.rss\nSTATUS: 200\nFETCHED_AT: 2026-11-06T13:31:00Z\nKIND: feed\nITEMS: 2\n\nFri, 06 Nov 2026 13:30:00 GMT | The Employment Situation - October 2026 | https://www.bls.gov/news.release/empsit.htm\nThu, 05 Nov 2026 13:30:00 GMT | BLS | Productivity | and costs | https://www.bls.gov/news.release/prod2.htm\n";
const pg = R.parsePagesFeed(page, "bls");
assert.deepEqual([pg.status, pg.fetched_at, pg.items.length], ["200", "2026-11-06T13:31:00Z", 2]);
assert.deepEqual(pg.items.map((x) => [x.title, x.published_at, x.url]), [["The Employment Situation - October 2026", "2026-11-06T13:30:00Z", "https://www.bls.gov/news.release/empsit.htm"], ["Productivity | and costs", "2026-11-05T13:30:00Z", "https://www.bls.gov/news.release/prod2.htm"]]);
assert.deepEqual(R.parsePagesFeed("URL: x\nSTATUS: 403\nKIND: page\n\nAccess denied", "bls").items, []);
ok("the Federal Register's public inspection (filed, to the minute; no time is a day item), the Treasury's list page (the slug as the id) and a feed saved by the pages workflow (outlet field optional)");

// ---------- the dedupe plan: one story per event, the first timestamp wins, every url kept ----------
const mk = (source, source_id, title, at, url = null, tickers = []) => R.item({ source, source_id, title, published_at: at, url, tickers });
const NOW = new Date("2026-11-05T14:00:00Z");
const batch = [
  mk("npr_business", "npr-1", "Micron pauses work on Taiwan plant", "2026-11-05T08:55:12Z", "https://www.npr.org/2026/11/05/micron"),
  mk("conversation_business", "tag:theconversation.com,2011:article/1", "MICRON PAUSES WORK ON TAIWAN PLANT", "2026-11-05T09:10:00Z", "https://theconversation.com/micron-1", ["MU"]),
  mk("sec_8k", "0000723125-26-000123", "Micron pauses work on Taiwan plant.", "2026-11-05T08:55:00Z", "https://www.sec.gov/x-index.htm", ["MU", "TSM"]),
  mk("fed", "f-1", "Federal Reserve issues FOMC statement", "2026-11-05T15:00:00Z", "https://www.federalreserve.gov/a.htm"),
  mk("npr_business", "npr-1", "dup in the batch", "2026-11-05T08:55:12Z"),
];
let plan = R.planDedupe(batch, {}, NOW);
assert.equal(plan.inserts.length, 2, "two stories");
const mic = plan.inserts[0];
assert.deepEqual([mic.source, mic.source_id, mic.published_at], ["sec_8k", "0000723125-26-000123", "2026-11-05T08:55:00Z"], "the earliest time wins, and its source names the story");
assert.deepEqual(mic.sightings.map((x) => x.source), ["npr_business", "conversation_business", "sec_8k"], "every sighting kept");
assert.deepEqual(mic.tickers.sort(), ["MU", "TSM"]);
assert.ok(mic.sightings.every((x) => x.first_seen_at === "2026-11-05T14:00:00Z"));
// Against what is stored: a sighting of a stored story attaches; an earlier one takes the time; a seen one is skipped.
const stored = [{ id: 7, published_at: "2026-11-05T09:00:00Z", dedupe_key: R.dedupeKey("Micron pauses work on Taiwan plant"), url_keys: ["npr.org/2026/11/05/micron"] }];
plan = R.planDedupe([batch[0], batch[2], mk("conversation_business", "c-9", "A different article", "2026-11-05T09:00:00Z", "https://www.npr.org/2026/11/05/micron?from=rss")], { seen: new Set(["npr_business|npr-1"]), candidates: stored }, NOW);
assert.deepEqual([plan.inserts.length, plan.attach.map((a) => [a.raw_id, a.item.source]), plan.earlier.map((e) => [e.raw_id, e.item.published_at])], [0, [[7, "sec_8k"], [7, "conversation_business"]], [[7, "2026-11-05T08:55:00Z"]]], "the url matches a stored story too");
// One source's own repeats stay apart (two agencies' "Meetings; Sunshine Act"); a short title never matches across
// sources on its title alone.
plan = R.planDedupe([mk("fedreg", "2026-22661", "Meetings; Sunshine Act", "2026-11-04T16:15:00Z"), mk("fedreg", "2026-22670", "Meetings; Sunshine Act", "2026-11-04T16:30:00Z")], {}, NOW);
assert.equal(plan.inserts.length, 2, "the same source's same title: two items");
plan = R.planDedupe([mk("npr_business", "n-30", "Markets close", "2026-11-05T20:50:00Z"), mk("fed", "https://x.com/close", "Markets close", "2026-11-05T20:52:00Z")], {}, NOW);
assert.equal(plan.inserts.length, 2, "a short title alone is no match");
plan = R.planDedupe([mk("fed", "f-2", "Micron pauses work on Taiwan plant", "2026-11-05T10:00:00Z")], { candidates: [{ ...stored[0], sources: ["fed"] }] }, NOW);
assert.equal(plan.inserts.length, 1, "a stored story the same source already carried isn't matched by title");
// A title repeated days apart is a new story.
plan = R.planDedupe([mk("npr_business", "npr-9", "Micron pauses work on Taiwan plant", "2026-11-08T09:00:00Z")], { candidates: stored }, NOW);
assert.equal(plan.inserts.length, 1, "outside 36 hours: a new story");
// One story carried twice in a batch keeps both titles' tags.
plan = R.planDedupe([mk("conversation_business", "c-1", "Oil jumps as strikes hit tankers near Hormuz", "2026-11-05T10:00:00Z"), mk("npr_business", "n-1", "Oil jumps as strikes hit tankers near Hormuz", "2026-11-05T10:05:00Z", null, ["XOM"])], {}, NOW);
assert.deepEqual([plan.inserts.length, plan.inserts[0].tags.includes("oil"), plan.inserts[0].tickers], [1, true, ["XOM"]]);
ok("dedupe: one story per event across sources (title or url), the earliest published time wins and names the source, every sighting kept, a stored story's sighting attached and an earlier one taking its time, a seen item skipped, a title days later a new story");

// ---------- the sources ----------
const keys = S.SOURCES.map((s) => s.key);
assert.deepEqual([...keys].sort(), ["bls", "conversation_business", "fed", "fedreg", "npr_business", "sec_6k", "sec_8k", "treasury"]);
for (const s of S.SOURCES) {
  assert.ok(s.terms, `${s.key}: its terms noted`);
  for (const r of s.requests({ env: { NEWSFEED_CONTACT: "Name name@example.com" }, now: NOW })) {
    assert.match(r.url, /^https:\/\//);
    assert.ok(!/token=|apikey=|key=/i.test(r.url), `${s.key}: no key in a url`);
    if (s.needs) assert.equal(r.headers["user-agent"], "Name name@example.com", `${s.key}: the contact line, from the environment only`);
    else assert.equal(r.headers["user-agent"], S.UA, `${s.key}: the generic client name`);
  }
}
assert.ok(!/@/.test(S.UA), "the generic client name carries no email");
ok("sources: the allowed list only, https, no keys in urls, the contact line only from NEWSFEED_CONTACT, a generic client name elsewhere");

// ---------- scheduling ----------
const T = Date.parse("2026-11-10T13:29:58Z"); // Tue Nov 10, 8:29:58am New York (CPI)
const rel = [{ source: "bls", et: "08:30", days: [1, 2, 3, 4, 5] }];
assert.deepEqual(C.openWindows(rel, T), ["bls"], "3 seconds before the release");
assert.deepEqual(C.openWindows(rel, T - 5000), [], "not yet");
assert.deepEqual(C.openWindows(rel, Date.parse("2026-11-10T13:32:01Z")), [], "over 2 minutes after");
assert.deepEqual(C.openWindows(rel, Date.parse("2026-11-08T13:30:00Z")), [], "a Sunday");
assert.deepEqual(C.openWindows([{ source: "fed", et: "14:00", dates: ["2026-11-10"] }], Date.parse("2026-11-10T19:00:30Z")), ["fed"], "a dated window");
const env = { NEWSFEED_CONTACT: "x y@z" };
let d = C.dueSources(S.SOURCES, {}, T, {}, []);
assert.deepEqual(d.skip.map((s) => s.key).sort(), ["bls", "sec_6k", "sec_8k"], "no contact line: SEC and BLS skipped, and say so");
d = C.dueSources(S.SOURCES, { npr_business: { last_attempt_at: new Date(T - 2 * 60000).toISOString() }, bls: { last_attempt_at: new Date(T - 1500).toISOString() } }, T, env, ["bls"]);
assert.ok(!d.read.some(({ s }) => s.key === "npr_business"), "inside its cadence: not read");
assert.ok(d.read.some(({ s, fast }) => s.key === "bls" && fast), "inside a release window: read every second");
d = C.dueSources(S.SOURCES, { fed: { backoff_until: new Date(T + 60000).toISOString() } }, T, env, []);
assert.ok(d.skip.some((s) => s.key === "fed" && /backing off/.test(s.note)));
assert.deepEqual([C.nextBackoff(0, null), C.nextBackoff(2, null), C.nextBackoff(40, null), C.nextBackoff(0, "300")], [2, 4, 60, 5]);
const blsReqs = S.SOURCE.bls.requests({ env });
assert.equal(C.requestsFor(S.SOURCE.bls, { env }, false).length, blsReqs.length, "on its cadence: every BLS feed");
assert.deepEqual([0, 1, 7].map((t) => C.requestsFor(S.SOURCE.bls, { env }, true, ["08:30"], t)[0].release.feed), ["empsit", "cpi", "empsit"], "in the 8:30 window: one feed a second, in turn, the 8:30 releases only");
assert.deepEqual(C.requestsFor(S.SOURCE.bls, { env }, true, ["10:00"], 3).map((r) => r.release.feed), ["jolts"], "in the 10:00 window: JOLTS");
ok("scheduling: release windows from 3 seconds before to 2 minutes after, weekdays or dated; cadences; back-off after HTTP 429");

// ---------- one batch: stamps, merging, backfill, outlet titles kept out ----------
const st = { sources: {}, seen: {}, stories: [], etags: {} };
const npr0 = S.SOURCE.npr_business, conv0 = S.SOURCE.conversation_business, sec0 = S.SOURCE.sec_8k;
const arrive = Date.parse("2026-11-05T14:00:01.234Z");
let ls = C.applyBatch(st, npr0, [mk("npr_business", "npr-1", "Micron pauses work on Taiwan plant", "2026-11-05T13:55:00Z", "https://www.npr.org/m")], arrive, { backfill: true });
assert.deepEqual([ls.length, ls[0].type, ls[0].first_seen_at, ls[0].lag_s, ls[0].backfill, ls[0].title, ls[0].url], [1, "item", "2026-11-05T14:00:01.234Z", 301, true, null, "https://www.npr.org/m"], "stamped to the millisecond on arrival; an outlet title never saved");
ls = C.applyBatch(st, sec0, [mk("sec_8k", "0000723125-26-000123", "Micron pauses work on Taiwan plant.", "2026-11-05T13:50:00Z", "https://www.sec.gov/x", ["MU"])], arrive + 60000);
assert.deepEqual([ls.length, ls[0].type, ls[0].story, ls[0].trail_s, ls[0].earlier], [1, "sighting", st.stories[0].id, 60, true], "the same story from another source: one story, its trail and that it came earlier");
ls = C.applyBatch(st, npr0, [mk("npr_business", "npr-1", "Micron pauses work on Taiwan plant", "2026-11-05T13:55:00Z")], arrive + 120000);
assert.equal(ls.length, 0, "a seen item adds nothing");
ls = C.applyBatch(st, sec0, [mk("sec_8k", "0000320193-26-000001", "8-K APPLE INC (Item 2.02)", "2026-11-05T21:30:28Z", "https://www.sec.gov/a", ["AAPL"])], Date.parse("2026-11-05T21:30:40.412Z"));
assert.deepEqual([ls[0].lag_s, ls[0].title, ls[0].tickers, ls[0].backfill], [12, "8-K APPLE INC (Item 2.02)", ["AAPL"], false], "a primary title is kept");
ok("a batch: first_seen_at to the millisecond on arrival, seconds late, one story across sources with each copy's trail, a source's first read marked backfill, outlet titles kept out of every file");

// ---------- the collector end to end, against a fake fetch ----------
const nprXml = `<rss><channel><item><title>Hiring jumps: The economy added 165,000 jobs last month</title><pubDate>Fri, 06 Nov 2026 08:49:21 -0500</pubDate><link>https://www.npr.org/2026/11/06/jobs</link><guid>https://www.npr.org/2026/11/06/jobs</guid></item></channel></rss>`;
const realFetch = globalThis.fetch;
let calls = [];
globalThis.fetch = async (url, o) => {
  calls.push({ url: String(url), ua: o.headers["user-agent"] });
  if (String(url).includes("npr.org")) return new Response(nprXml, { status: 200, headers: { etag: '"a1"' } });
  if (String(url).includes("federalreserve.gov")) return new Response("busy", { status: 429, headers: { "retry-after": "120" } });
  if (String(url).includes("treasury.gov")) return new Response(tre, { status: 200 });
  if (String(url).includes("federalregister.gov")) return new Response(JSON.stringify(fr), { status: 200 });
  return new Response("<feed></feed>", { status: 200 });
};
const dir = mkdtempSync(join(tmpdir(), "nf-"));
try {
  const r1 = await C.run({ stateDir: dir, env: {} });
  assert.equal(r1.summary.sec_8k.skipped, "NEWSFEED_CONTACT not set: SEC and BLS ask every automated reader for a name and contact");
  assert.match(r1.summary.fed.error, /HTTP 429, backing off 2 min/);
  assert.equal(r1.summary.npr_business.new, 1);
  assert.ok(calls.every((c) => !/@/.test(c.ua)), "no email in any request");
  const items = readFileSync(join(dir, "items.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(items.every((i) => i.backfill), "the first read of each source is backfill");
  assert.ok(!readFileSync(join(dir, "items.jsonl"), "utf8").includes("Hiring jumps"), "the outlet title is in no file");
  assert.ok(!readFileSync(join(dir, "state.json"), "utf8").includes("Hiring jumps"));
  calls = [];
  const r2 = await C.run({ stateDir: dir, env: {} });
  assert.ok(!calls.some((c) => c.url.includes("federalreserve.gov")), "backing off: not read again");
  assert.ok(!calls.some((c) => c.url.includes("npr.org")), "inside its cadence: not read again");
  const card = K.score({ items, reads: readFileSync(join(dir, "reads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), runs: readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) });
  const fedRow = card.sources.find((s) => s.key === "fed");
  assert.deepEqual([fedRow.reads, fedRow.reads_failed, card.broken.includes("fed")], [1, 1, true], "a failing source is named broken");
  assert.equal(card.sources.find((s) => s.key === "sec_8k").skipped, "never read (needs NEWSFEED_CONTACT, or not run yet)");
  assert.equal(card.window.runs, 2);
} finally { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); }
ok("the collector end to end: skips SEC and BLS without the contact line, backs off on 429, cadences hold between runs, outlet titles in no file, the scorecard names the broken source");

// ---------- the scorecard ----------
assert.equal(K.quantile([5, 1, 3], 0.5), 3);
assert.equal(K.longestGap(["2026-11-05T10:10:00Z", "2026-11-05T10:20:00Z"], Date.parse("2026-11-05T10:00:00Z"), Date.parse("2026-11-05T11:00:00Z")), 40);
const mv = K.checkMoves([{ at: "2026-11-06T14:00:00Z", symbol: "MU" }, { at: "2026-11-06T16:00:00Z", symbol: "AAPL" }], [
  { first_seen_at: "2026-11-06T13:45:00Z", tickers: ["MU"], tags: [] },
  { first_seen_at: "2026-11-06T16:20:00Z", tickers: ["AAPL"], tags: [] },
]);
assert.deepEqual(mv.map((m) => [m.headline, m.minutes_after]), [["before", null], ["after", 20]]);
assert.equal(K.checkMoves([{ at: "2026-11-06T14:00:00Z", symbol: "XOM" }], [{ first_seen_at: "2026-11-06T13:45:00Z", tickers: ["MU"] }])[0].headline, "none");
ok("the scorecard: quantiles, the longest gap, moves checked for a headline before, after (minutes) or none");

console.log(`${n} checks passed`);
