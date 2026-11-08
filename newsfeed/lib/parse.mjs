// The news feed's parsers, normalizing and dedupe plan. Copied from Market Waves (api/_lib/newsraw.js and the tag
// rules in api/_lib/feeds/news.js, Nov 7 2026) so the dry run stands on its own: no database, no Market Waves imports.
// The raw news layer (P37.1-P37.3, D76; James Nov 6 2026: "I can't get reliable news"; "Don't trust the news, trust
// the market: the market judges whether something matters; the news explains what it is"). Every item from every
// source whose terms allow it (api/_lib/newssources.js, docs/NEWS_SOURCES.md), stored raw in market_waves.news_raw:
// source, the source's own id, the time it was published (to the second, with what that time is), the time the server
// first saw it, title, summary, url, the tickers it names and the tape's keyword tags of its title (for matching).
// Deduped across sources: one row per story; the first timestamp wins (the earliest published time any source gave,
// and that source becomes the row's source); every source's sighting and url is kept in market_waves.news_urls.
// Kept forever. Pure functions here: parsing each source's format, normalizing, the dedupe plan; the feed:
// api/_lib/feeds/newsraw.js.
import { createHash } from "node:crypto";

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ---------- tags ----------
// Plain keyword tags, lowercase, in this order. A headline can carry several or none.
const RULES = [
  ["fed", /\b(fed|fomc|federal reserve|powell|fed funds)\b/i],
  ["rates", /\b(interest rates?|rate (cut|cuts|hike|hikes|hold|decision|path)|policy rate|rates|yields?|treasur(y|ies)|t-bills?|(bill|note|bond) auction|gilts?|bunds?|jgbs?|basis points?|bps|repos?)\b/i],
  ["jobs", /\b(jobs?|payrolls?|nfp|non-?farm|jobless|unemployment|employment|labou?r market|jolts|adp|layoffs?|job cuts|wages?|(average|hourly|weekly|cash) earnings)\b/i],
  ["inflation", /\b(inflation|inflationary|disinflation|deflation|cpi|ppi|pce|hicp|price index|prices index)\b/i],
  ["tariffs", /\b(tariffs?|trade war|trade deal|trade agreement|trade talks|duties|levies|export controls?|section (232|301))\b/i],
  ["election", /\b(elections?|electoral|midterms?|ballots?|exit polls?|voters?|voting|recount|concedes?|swing states?|polls? (show|close|closed|open)|president-elect)\b/i],
  ["war", /\b(war|wars|warfare|military|missiles?|airstrikes?|air strikes?|attacks?|attacked|troops|invasion|invaded?|ceasefire|cease-fire|truce|drones?|bombs?|bombing|hostilities|civil defen[cs]e|armed forces|idf|hezbollah|houthis?|hamas|nato)\b/i],
  ["oil", /\b(oil|crude|brent|wti|opec|barrels?|bbl|gasoline|diesel|refiner(y|ies)|aramco|osp|petroleum)\b/i],
];
const NOT_WAR = /\b(trade|price|currency|tariff|bidding|talent) wars?\b/gi;
// Company results; wage data ("average hourly earnings", Japan's "cash earnings") is jobs, not earnings.
const EARN = /\b(eps|earnings|net income|quarterly (profit|results|sales|revenue|loss)|q[1-4] (results|profit|sales|loss|revenues?|earnings))\b/i;
const EARN_WITH_TICKER = /\b(revenues?|guidance|sales|profit)\b/i; // counts only beside a cashtag
const NOT_EARN = /\b(average|hourly|weekly|cash|real|labou?r) earnings\b/gi;
const AI = /\b(ai|artificial intelligence|openai|anthropic|chatgpt|gpt|llms?|data cent(er|re)s?|nvidia|genai)\b/i;
const CHINA = /\b(china|chinese|beijing|pboc|yuan|renminbi|rmb|cny|cnh|xi|shanghai|shenzhen|hong kong|hang seng)\b/i;
const CASHTAG = /\$([A-Z]{1,5}(?:\.[A-Z])?)(?![A-Za-z0-9])/g;

export const TAG_NAMES = ["fed", "rates", "jobs", "inflation", "tariffs", "election", "war", "oil", "earnings", "ai", "china"];

// Pure: a headline's tags. An earnings headline also carries each ticker its cashtags name ($NVDA -> nvda).
export function newsTags(title) {
  const t = clean(title);
  if (!t) return [];
  const tags = [];
  for (const [name, re] of RULES) {
    const text = name === "war" ? t.replace(NOT_WAR, " ") : t;
    if (re.test(text)) tags.push(name);
  }
  const tickers = [...t.matchAll(CASHTAG)].map((m) => m[1].toLowerCase());
  const plain = t.replace(NOT_EARN, " ");
  if (EARN.test(plain) || (tickers.length && EARN_WITH_TICKER.test(plain))) tags.push("earnings", ...tickers);
  if (AI.test(t)) tags.push("ai");
  if (CHINA.test(t)) tags.push("china");
  return [...new Set(tags)];
}


export const MATCH_HOURS = 36; // a title seen again within this many hours of the stored story is the same story
export const MIN_TITLE_MATCH = 24; // a normalized title shorter than this never matches on its title alone
export const MAX_TITLE = 1000;
export const MAX_SUMMARY = 4000;
export const MAX_TICKERS = 25;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "..." };
export function decode(s) {
  return String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ").trim();
}
// Entities first, then tags: a summary that carries escaped HTML (&lt;p&gt;) comes out as text.
const text = (s) => decode(decode(s));

// Pure: an instant to the second, or null.
export function isoS(x) {
  if (x == null || x === "") return null;
  const t = x instanceof Date ? x.getTime() : typeof x === "number" ? x : Date.parse(x);
  return Number.isFinite(t) ? new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z") : null;
}

// Pure: a title as the dedupe key sees it: lowercase, a source's prefix dropped, punctuation and spacing gone.
export function normTitle(t) {
  return String(t ?? "").toLowerCase()
    .replace(/^(breaking|update\s*\d*|press release|exclusive|correction|corrected)\s*[:\-|]\s*/i, "")
    .replace(/&amp;/g, "&").replace(/['’`]/g, "").replace(/[^a-z0-9$%&.]+/g, " ").replace(/\.(?!\d)/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
export const dedupeKey = (title) => createHash("sha1").update(normTitle(title)).digest("hex").slice(0, 24);

// Pure: a link as the dedupe key sees it: https, no www, no query or fragment, no trailing slash, host lowercase.
export function urlKey(u) {
  try {
    const x = new URL(String(u));
    if (!/^https?:$/.test(x.protocol)) return null;
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.slice(0, 400);
  } catch { return null; }
}

// Pure: tickers an item names in its own text: cashtags ($MU) and exchange tags ("(NASDAQ: MU)", "NYSE:VST").
// CASHTAG: the same pattern as the tag rules above.
const EXCH = /\b(?:NASDAQ|Nasdaq|NasdaqGS|NasdaqGM|NasdaqCM|NYSE|NYSE American|NYSE Arca|NYSE MKT|AMEX|Cboe|CBOE|OTCQX|OTCQB)\s*:\s*([A-Z]{1,5}(?:\.[A-Z])?)\b/g;
export function tickersIn(...texts) {
  const out = new Set();
  for (const s of texts) {
    const t = String(s ?? "");
    for (const m of t.matchAll(CASHTAG)) out.add(m[1]);
    for (const m of t.matchAll(EXCH)) out.add(m[1]);
  }
  return [...out].slice(0, MAX_TICKERS);
}

// Pure: the tape's keyword tags of a title (feeds/news.js newsTags: fed, rates, jobs, inflation, tariffs, election, war,
// oil, earnings, ai, china), the tickers it adds left out (they are in tickers). A filing gets none: its title is its form
// and company name ("8-K Avalanche Treasury Corp" isn't about rates); its ticker and the brain's reading stand.
export const tagsOf = (title) => [...new Set(newsTags(title).filter((t) => TAG_NAMES.includes(t)))];

// Pure: one item, cleaned. Every parser below hands back items in this shape:
//   { source, source_id, published_at, time_basis, title, summary, url, tickers, tags, kind, raw }
// time_basis says what published_at is: published (the source's own publish time), filed (SEC's acceptance time; the
// Federal Register's public-inspection time), day (a date with no time; published_at is null then).
export function item(o) {
  const title = text(o.title).slice(0, MAX_TITLE);
  if (!title || !o.source || !o.source_id) return null;
  const summary = o.summary == null ? null : text(o.summary).slice(0, MAX_SUMMARY) || null;
  const url = o.url && /^https?:\/\//.test(String(o.url).trim()) ? String(o.url).trim() : null;
  const tickers = [...new Set([...(o.tickers || []).map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(x)), ...tickersIn(title, summary)])].slice(0, MAX_TICKERS);
  return {
    source: o.source, source_id: String(o.source_id).slice(0, 300), published_at: isoS(o.published_at), time_basis: o.time_basis || (o.published_at ? "published" : "day"),
    title, summary, url, tickers, tags: o.kind === "filing" ? [] : tagsOf(title), kind: o.kind || "headline", raw: o.raw ?? null,
    ...(o.first_seen_at ? { first_seen_at: isoS(o.first_seen_at) } : {}),
  };
}

// ---------- parsers ----------
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : null; };
const attr = (block, name, a) => { const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]*)"`, "i")); return m ? decode(m[1]) : null; };
const allTags = (block, name) => [...block.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))].map((m) => decode(m[1]));

// Pure: an RSS 2.0 or Atom feed into items. guid (or Atom id) is the source id; else the link; else title + time.
export function parseFeed(xml, source, { kind = "headline", basis = "published" } = {}) {
  const s = String(xml ?? "");
  const blocks = [...s.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const atom = !blocks.length ? [...s.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)].map((m) => m[1]) : [];
  const out = [];
  for (const b of blocks) {
    const link = decode(tag(b, "link")) || attr(b, "link", "href");
    const guid = decode(tag(b, "guid"));
    const at = decode(tag(b, "pubDate")) || decode(tag(b, "dc:date")) || decode(tag(b, "published")) || decode(tag(b, "updated"));
    const cats = allTags(b, "category");
    const it = item({ source, source_id: guid || link || `${decode(tag(b, "title"))}|${at}`, published_at: at || null, time_basis: at ? basis : "day", title: tag(b, "title"), summary: tag(b, "description"), url: link, tickers: cats.flatMap((c) => tickersIn(c)), kind });
    if (it) out.push(it);
  }
  for (const b of atom) {
    const link = attr(b, "link", "href") || decode(tag(b, "link"));
    const id = decode(tag(b, "id"));
    const at = decode(tag(b, "published")) || decode(tag(b, "updated"));
    const it = item({ source, source_id: id || link, published_at: at || null, time_basis: at ? basis : "day", title: tag(b, "title"), summary: tag(b, "summary") || tag(b, "content"), url: link, kind });
    if (it) out.push(it);
  }
  return out;
}

// Pure: SEC EDGAR's "current events" Atom (browse-edgar?action=getcurrent&type=8-K&output=atom). An entry's title is
// "8-K - MICRON TECHNOLOGY INC (0000723125) (Filer)"; its summary holds "Filed: 2026-11-05 AccNo: 0000723125-26-000123
// Size: 1 MB" and the items ("Item 2.02: Results of Operations..."); updated is the acceptance time to the second.
// ciks: a Map of CIK (no leading zeros) to ticker. The accession number is the source id.
export function parseSec(xml, source = "sec", ciks = new Map()) {
  const out = [];
  for (const m of String(xml ?? "").matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
    const b = m[1];
    const title = decode(tag(b, "title"));
    const summary = text(tag(b, "summary"));
    const link = attr(b, "link", "href");
    const acc = (summary.match(/AccNo:\s*([0-9-]{18,22})/) || decode(tag(b, "id")).match(/accession-number=([0-9-]{18,22})/) || [])[1];
    const t = title.match(/^([0-9A-Z/-]+)\s+-\s+(.+?)\s+\((\d{4,10})\)\s+\((Filer|Subject|Reporting)\)/);
    if (!acc || !t) continue;
    const [, form, company, cikRaw, role] = t;
    const cik = String(Number(cikRaw));
    const items = [...summary.matchAll(/Item\s+(\d+\.\d+)/g)].map((x) => x[1]);
    const ticker = ciks.get(cik);
    const it = item({
      source, source_id: `${acc}${role === "Filer" ? "" : `:${cik}`}`, published_at: decode(tag(b, "updated")) || null, time_basis: "filed",
      title: `${form} ${company}${items.length ? ` (Item ${[...new Set(items)].join(", ")})` : ""}`,
      summary: summary.replace(/\s+/g, " ").slice(0, 600), url: link, tickers: ticker ? [ticker] : [], kind: "filing",
      raw: { form, company, cik, role, accession: acc, items: [...new Set(items)] },
    });
    if (it) out.push(it);
  }
  return out;
}

// Pure: SEC's company_tickers.json ({"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}) as a
// Map of CIK to ticker (the first ticker listed for a CIK).
export function cikMap(doc) {
  const m = new Map();
  for (const v of Object.values(doc || {})) if (v?.cik_str != null && v?.ticker && !m.has(String(v.cik_str))) m.set(String(v.cik_str), String(v.ticker).toUpperCase());
  return m;
}

// Pure: the Federal Register's public-inspection documents (public-inspection-documents/current.json). filed_at is
// when a document went on public inspection, to the minute, before its publication date (the documents themselves
// carry a date with no time); the document number is the source id.
export function parseFedRegPI(doc, source = "fedreg") {
  return (doc?.results || []).map((d) => item({
    source, source_id: d.document_number, published_at: d.filed_at || null, time_basis: d.filed_at ? "filed" : "day", title: d.title,
    summary: [d.type, (d.agency_names || (d.agencies || []).map((a) => a.name || a.raw_name)).filter(Boolean).join("; "), d.filing_type ? `${d.filing_type} filing` : null, d.publication_date ? `publishes ${d.publication_date}` : null].filter(Boolean).join(". "),
    url: d.html_url, kind: "rule",
    raw: { publication_date: d.publication_date ?? null, filing_type: d.filing_type ?? null, type: d.type ?? null, agencies: (d.agencies || []).map((a) => a.slug || a.name).filter(Boolean) },
  })).filter(Boolean);
}

// Pure: the Treasury's press-release list page (home.treasury.gov/news/press-releases): each item is a <time
// datetime="...Z"> (to the minute, UTC) and then its headline link (/news/press-releases/sb0683/); the slug is the id.
export function parseTreasury(html, source = "treasury") {
  const out = [];
  const re = /<time\s+datetime=["']?([^"'\s>]+)["']?[^>]*>[\s\S]*?<h3[^>]*featured-stories__headline[^>]*>\s*<a\s+href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of String(html ?? "").matchAll(re)) {
    const href = m[2];
    const url = /^https?:\/\//.test(href) ? href : `https://home.treasury.gov${href.startsWith("/") ? "" : "/"}${href}`;
    const slug = (href.match(/press-releases\/([^/?#]+)\/?$/) || [])[1] || href;
    const it = item({ source, source_id: slug, published_at: m[1], time_basis: "published", title: m[3], url, kind: "release" });
    if (it) out.push(it);
  }
  return out;
}

// Pure: a feed saved by the pages workflow (scripts/fetch_pages.py: "KIND: feed", then one item per line as
// "<when> | <outlet> | <title> | <link>", empty fields left out). The link is the source id.
export function parsePagesFeed(txt, source) {
  const s = String(txt ?? "");
  const fetched = (s.match(/^FETCHED_AT: (\S+)/m) || [])[1] || null;
  const status = (s.match(/^STATUS: (.+)$/m) || [])[1] || null;
  if (!/^KIND: feed$/m.test(s)) return { status, fetched_at: fetched, items: [] };
  const body = s.split(/\n\n/).slice(1).join("\n\n");
  const items = [];
  for (const line of body.split("\n")) {
    const parts = line.split(" | ").map((x) => x.trim());
    if (parts.length < 2) continue;
    const link = /^https?:\/\//.test(parts.at(-1)) ? parts.pop() : null;
    const when = Number.isFinite(Date.parse(parts[0])) ? parts.shift() : null;
    const title = parts.length > 1 ? parts.slice(1).join(" | ") : parts[0];
    const it = item({ source, source_id: link || `${title}|${when}`, published_at: when, time_basis: when ? "published" : "day", title, url: link, kind: "headline", raw: { via: "pages workflow", fetched_at: fetched } });
    if (it) items.push(it);
  }
  return { status, fetched_at: fetched, items };
}

// ---------- the dedupe plan ----------

// Pure: what to write for a batch of incoming items against what is stored. seen: Set of "source|source_id" already
// in news_urls; candidates: stored stories that may match ({ id, published_at, dedupe_key, url_keys: [] }). Returns
//   inserts  new stories, each with its first sighting
//   attach   sightings of stored stories ({ raw_id, item })
//   earlier  stored stories a sighting predates ({ raw_id, item }): the first timestamp wins
// Items in the batch match each other the same way, so two sources carrying one story in one run make one story.
export function planDedupe(items, { seen = new Set(), candidates = [] } = {}, now = new Date()) {
  const firstSeen = isoS(now);
  const stories = candidates.map((c) => ({ ...c, published_at: isoS(c.published_at), url_keys: new Set(c.url_keys || []), sources: new Set(c.sources || []), stored: true }));
  const inserts = [], attach = [], earlier = [];
  const within = (a, b) => a == null || b == null || Math.abs(Date.parse(a) - Date.parse(b)) <= MATCH_HOURS * 3600000;
  const local = new Set();
  for (const it of items) {
    const k = `${it.source}|${it.source_id}`;
    if (seen.has(k) || local.has(k)) continue;
    local.add(k);
    const dk = dedupeKey(it.title), uk = urlKey(it.url);
    // A title matches only across sources and only when it says something: one source's own repeats ("Meetings;
    // Sunshine Act" from two agencies, "MOC Imbalance" each afternoon) are separate items with their own ids.
    const titleOk = normTitle(it.title).length >= MIN_TITLE_MATCH;
    const hit = stories.find((s) => (uk && s.url_keys.has(uk)) || (titleOk && s.dedupe_key === dk && !s.sources.has(it.source) && within(s.published_at, it.published_at)));
    const row = { ...it, first_seen_at: it.first_seen_at || firstSeen, dedupe_key: dk, url_key: uk };
    if (!hit) {
      const s = { dedupe_key: dk, published_at: it.published_at, url_keys: new Set(uk ? [uk] : []), sources: new Set([it.source]), stored: false, insert: { ...row, sightings: [row] } };
      stories.push(s);
      inserts.push(s.insert);
      continue;
    }
    if (uk) hit.url_keys.add(uk);
    hit.sources.add(it.source);
    if (!hit.stored) {
      hit.insert.sightings.push(row);
      if (it.published_at && (!hit.insert.published_at || it.published_at < hit.insert.published_at)) {
        Object.assign(hit.insert, { source: it.source, source_id: it.source_id, published_at: it.published_at, time_basis: it.time_basis });
        hit.published_at = it.published_at;
      }
      hit.insert.tickers = [...new Set([...hit.insert.tickers, ...it.tickers])].slice(0, MAX_TICKERS);
      hit.insert.tags = [...new Set([...(hit.insert.tags || []), ...(it.tags || [])])];
      continue;
    }
    attach.push({ raw_id: hit.id, item: row });
    if (it.published_at && (!hit.published_at || it.published_at < hit.published_at)) {
      earlier.push({ raw_id: hit.id, item: row });
      hit.published_at = it.published_at;
    }
  }
  return { inserts, attach, earlier };
}
