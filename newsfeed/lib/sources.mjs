// The dry run's sources: the same list Market Waves reads (api/_lib/newssources.js, Nov 7 2026), every one checked
// for terms that allow automated reading (Market Waves docs/NEWS_SOURCES.md). Outlet titles (NPR, The Conversation)
// are used for dedupe only and never written to the saved state or the scorecard, because this repo is public.
// The news sources the raw layer reads (P37.1-P37.3, D76: James cut FinancialJuice and every feed whose terms bar
// automated reading; terms checked Nov 6 2026 and quoted in docs/NEWS_SOURCES.md). Only sources whose own terms allow
// automated reading and storage for personal use: the Federal Reserve, Treasury, the Federal Register, SEC EDGAR
// current filings and BLS (both with the contact line from NEWS_SEC_UA), NPR Business and The Conversation. No paid
// data (D66), no key-gated source. GDELT is cut (the dated line under D76: it never worked from our host).
// Each source: key (its name in news_raw and news_sources), label, group, route (vercel: the server reads it; actions:
// the GitHub pages workflow reads it for the server, for a source the server can't reach), every (minutes between
// reads), ms (its read cap, when longer than the feed's 8 seconds), needs (an env var it can't run without; skipped
// with skipNote while unset), requests(ctx) -> [{ url, headers, label }], parse(body, ctx) -> items
// (api/_lib/newsraw.js item shape), terms (what its terms allow).
// ctx: { env, now, ciks: SEC's CIK-to-ticker Map }.
import { parseFedRegPI, parseFeed, parseSec, parseTreasury } from "./parse.mjs";

// New York clock, copied from Market Waves api/_lib/clock.js.
const NY = "America/New_York";

// Pure: New York wall clock for an instant.
// One formatter for the whole process: building an Intl.DateTimeFormat costs far more than using one, and the desk
// calls this for every 5-minute bar (Nov 1: 15 of the desk's 19 seconds on a cold load went to building formatters).
const NY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  weekday: "long", timeZoneName: "short",
});
export function nyClock(d) {
  const f = NY_FMT.formatToParts(d);
  const g = (t) => f.find((x) => x.type === t)?.value;
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { date, h: Number(g("hour")), m: Number(g("minute")), weekday: g("weekday"), tz: g("timeZoneName") };
}

// Pure: the instant for a New York wall-clock time on a date (right on both sides of a daylight-saving change).
export function nyInstant(day, h, m) {
  const hh = String(h).padStart(2, "0"), mm = String(m).padStart(2, "0");
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${day}T${hh}:${mm}:00${off}`);
    const c = nyClock(d);
    if (c.date === day && c.h === h && c.m === m) return d;
  }
  return new Date(`${day}T${hh}:${mm}:00-05:00`);
}


export const CIK_URL = "https://www.sec.gov/files/company_tickers.json";
export const UA = "agent-newsfeed-test/0.1 (personal dry run; RSS reader)";
const RSS = { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" };
const JSONH = { "user-agent": UA, accept: "application/json" };

const rss = (key, label, url, o = {}) => ({
  key, label, group: o.group || "outlet", route: o.route || "vercel", every: o.every || 5, kind: o.kind || "headline",
  ...(o.needs ? { needs: o.needs, skipNote: o.skipNote } : {}),
  requests: (ctx) => [{ url, headers: o.headers ? o.headers(ctx) : RSS, label: key }],
  parse: (body) => parseFeed(body, key, { kind: o.kind || "headline" }),
  terms: o.terms,
});

// SEC (and BLS, which asks the same) want every automated reader to say who it is: a name and a contact email in the
// User-Agent. The contact line is read from the NEWSFEED_CONTACT secret only, never written here or logged.
export const CONTACT = "NEWSFEED_CONTACT";
const CONTACT_SKIP = "NEWSFEED_CONTACT not set: SEC and BLS ask every automated reader for a name and contact";
export const contactUA = (env) => String(env?.[CONTACT] || "").trim();
const sec = (form) => {
  const key = `sec_${form.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  return {
    // SEC's current-filings list can take over 8 seconds (live, Nov 6: the 8-K list timed out at 8): 20 seconds.
    key, label: `SEC EDGAR current ${form} filings`, group: "sec", route: "vercel", every: 5, ms: 20000, kind: "filing", needs: CONTACT, skipNote: CONTACT_SKIP,
    requests: (ctx) => [{ url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&start=0&count=100&output=atom`, headers: { "user-agent": contactUA(ctx.env), accept: "application/atom+xml, application/xml" }, label: `SEC ${form}` }],
    parse: (body, ctx) => parseSec(body, key, ctx.ciks || new Map()),
    terms: "conditions: a declared User-Agent with a contact, at most 10 requests a second",
  };
};

// BLS: one source (its key stays "bls", the key the raw layer's readers ask for), reading BLS's own feed for each
// market-moving release in turn, every 15 minutes with the contact line; each entry is that release's own headline
// ("Payroll employment rises by 165,000 in October; unemployment rate changes little at 4.1%"). The generic
// bls_latest.rss is dropped: its one item ("Major Economic Indicators Latest Numbers") keeps the same link and title for
// good, so after its first read the dedupe skipped every release (the Nov 6 jobs report never landed). Feed names from
// www.bls.gov/feed/, each answering HTTP 200 with the contact line on Nov 6 2026. at: the release's New York time as
// printed on it ("embargoed until 8:30 a.m. (ET)"; JOLTS "For release 10:00 a.m. (ET)").
export const BLS_FEEDS = [
  { feed: "empsit", name: "Employment Situation", at: [8, 30] },
  { feed: "cpi", name: "Consumer Price Index", at: [8, 30] },
  { feed: "ppi", name: "Producer Price Index", at: [8, 30] },
  { feed: "jolts", name: "Job Openings and Labor Turnover Survey", at: [10, 0] },
  { feed: "eci", name: "Employment Cost Index", at: [8, 30] },
  { feed: "prod2", name: "Productivity and Costs", at: [8, 30] },
  { feed: "ximpim", name: "U.S. Import and Export Price Indexes", at: [8, 30] },
  { feed: "realer", name: "Real Earnings", at: [8, 30] },
];
// Each feed keeps its release's last 12 entries; the raw layer builds forward, so an entry released more than 3 days
// before the read is left out (the news log holds the older releases).
export const BLS_DAYS = 3;
const isoSec = (t) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");

// Pure: one BLS feed's items (parseFeed's) on their release's own time. BLS stamps an entry when it stages it, before
// the embargo lifts (Nov 6: 7:50am for the 8:30am releases, 9:20am for JOLTS at 10am), so an entry stamped before its
// release time that New York day takes the release time (its stamp kept in raw); one stamped later keeps its stamp. Never
// later than the read that has it: an entry on file before its release time (a release moved) takes the read's own
// time, as seen. An entry with no time, or released more than BLS_DAYS before the read, is left out.
export function blsItems(items, release, now = new Date()) {
  const [h, m] = release.at;
  const t0 = now.getTime();
  const out = [];
  for (const it of items || []) {
    const t = Date.parse(it?.published_at);
    if (!Number.isFinite(t)) continue;
    let at = Math.max(t, nyInstant(nyClock(new Date(t)).date, h, m).getTime()), basis = it.time_basis;
    if (at > t0) { at = t0; basis = "seen"; }
    if (t0 - at > BLS_DAYS * 86400000) continue;
    out.push({ ...it, published_at: isoSec(at), time_basis: basis, raw: { release: release.name, stamped: it.published_at } });
  }
  return out;
}

// Each read capped at 5 seconds (BLS answered in under a quarter second on Nov 6; a timeout stops the source's run, so
// a site that stops answering on a release morning holds the feed no longer than one cap).
const bls = {
  key: "bls", label: "BLS news releases", group: "gov", route: "vercel", every: 15, ms: 5000, kind: "release", needs: CONTACT, skipNote: CONTACT_SKIP,
  requests: (ctx) => BLS_FEEDS.map((f) => ({ url: `https://www.bls.gov/feed/${f.feed}.rss`, headers: { ...RSS, "user-agent": contactUA(ctx.env) }, label: `bls ${f.feed}`, release: f })),
  parse: (body, ctx) => {
    if (!ctx?.req?.release) throw new Error("a BLS feed read without its release");
    return blsItems(parseFeed(body, "bls", { kind: "release" }), ctx.req.release, ctx.now ? new Date(ctx.now) : new Date());
  },
  terms: "conditions: a contact in the User-Agent, a low rate, cite BLS",
};

// Off for now (James, Nov 8: "we are more or less looking for daily news"): SEC filings and BLS releases stay in the
// list so they can come back with one line, but the collector doesn't read them and the page shows them as off.
export const OFF_NOTE = "off for now: daily news first, not filings or data releases";
const OFF = new Set(["sec_8k", "sec_6k", "bls"]);

const ALL = [
  // Primary: filings, the Fed, BLS, Treasury, the Federal Register.
  sec("8-K"),
  sec("6-K"),
  rss("fed", "Federal Reserve press releases", "https://www.federalreserve.gov/feeds/press_all.xml", { group: "gov", kind: "release", terms: "allowed: public domain, cite the Board" }),
  bls,
  {
    key: "treasury", label: "US Treasury press releases", group: "gov", route: "vercel", every: 15, kind: "release",
    requests: () => [{ url: "https://home.treasury.gov/news/press-releases", headers: { "user-agent": UA, accept: "text/html" }, label: "treasury" }],
    parse: (body) => parseTreasury(body, "treasury"),
    terms: "allowed: robots.txt Allow: / (its GovDelivery RSS is disallowed, so the list page is read)",
  },
  {
    key: "fedreg", label: "Federal Register public inspection", group: "gov", route: "vercel", every: 30, kind: "rule",
    requests: () => [{ url: "https://www.federalregister.gov/api/v1/public-inspection-documents/current.json", headers: JSONH, label: "fedreg" }],
    parse: (body) => parseFedRegPI(JSON.parse(body), "fedreg"),
    terms: "allowed: no key; 1 CFR 2.6",
  },
  // The two outlets whose terms allow it: NPR Business (personal use, credit NPR with the link) and The Conversation
  // (Creative Commons BY-ND).
  rss("npr_business", "NPR Business", "https://feeds.npr.org/1006/rss.xml", { terms: "conditions: personal noncommercial use, credit NPR and link, headline and summary only" }),
  rss("conversation_business", "The Conversation US: business and economy", "https://theconversation.com/us/business/articles.atom", { every: 30, kind: "article", terms: "allowed: Creative Commons BY-ND" }),
];

export const SOURCES = ALL.map((s) => (OFF.has(s.key) ? { ...s, off: OFF_NOTE } : s));

export const SOURCE = Object.fromEntries(SOURCES.map((s) => [s.key, s]));
