#!/usr/bin/env node
// One collector run of the news feed dry test. Reads every source whose cadence has come round, stamps each new item
// with the moment its response arrived (first_seen_at, to the millisecond), merges copies of one story across sources
// (lib/parse.mjs planDedupe: same link, or the same title from another source within 36 hours), tags tickers only
// from exact marks (SEC's own CIK list for a filing, cashtags, "(NASDAQ: MU)"), and appends what it saw to the state
// folder. No database, no keys besides the optional contact line, nothing written outside the state folder.
//
//   node newsfeed/collect.mjs [--state DIR] [--loop SECONDS] [--now ISO]
//
// --loop keeps the run going for that many seconds, re-checking cadences every second; inside a release window
// (releases.json: a source, a New York time and the weekdays it applies) the window's source is read every second from
// 3 seconds before to 2 minutes after, with conditional requests so an unchanged feed costs almost nothing.
//
// The state folder (restored and saved by the workflow's cache):
//   state.json    each source's health, the ids already seen, the last 48 hours of stories, etags
//   items.jsonl   one line per new story ("item") and per later copy of a story from another source ("sighting")
//   reads.jsonl   one line per read: when, the source, ok or not, HTTP status, milliseconds, items, new
//   runs.jsonl    one line per run: when it started and ended (the gaps between runs are the scheduler's lateness)
// Outlet titles (group "outlet") never reach any file: their dedupe key is a hash.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planDedupe, cikMap, isoS, dedupeKey, urlKey } from "./lib/parse.mjs";
import { SOURCES, CIK_URL, contactUA, nyClock, nyInstant } from "./lib/sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORY_HOURS = 48;
const SEEN_DAYS = 30;
const DEFAULT_MS = 8000;

export const msIso = (t) => new Date(t).toISOString();
export const storyId = (source, sourceId) => createHash("sha1").update(`${source}|${sourceId}`).digest("hex").slice(0, 16);
const short = (e) => String(e?.message || e).slice(0, 160);

export function loadState(dir) {
  const p = join(dir, "state.json");
  if (!existsSync(p)) return { sources: {}, seen: {}, stories: [], etags: {}, ciks: null };
  const s = JSON.parse(readFileSync(p, "utf8"));
  return { sources: s.sources || {}, seen: s.seen || {}, stories: s.stories || [], etags: s.etags || {}, ciks: s.ciks || null };
}

export function saveState(dir, st, now) {
  const cutStory = now - STORY_HOURS * 3600000, cutSeen = now - SEEN_DAYS * 86400000;
  st.stories = st.stories.filter((s) => Date.parse(s.first_seen_at) >= cutStory);
  for (const [k, t] of Object.entries(st.seen)) if (Date.parse(t) < cutSeen) delete st.seen[k];
  writeFileSync(join(dir, "state.json"), JSON.stringify(st));
}

// Pure: the release windows open at this instant. releases: [{ source, et: "08:30", days: [1..5], dates?: [...] }].
export function openWindows(releases, now) {
  return [...new Set(openWindowTimes(releases, now).map((w) => w.source))];
}

// Pure: the open windows with their New York times ([{ source, et }]).
export function openWindowTimes(releases, now) {
  const c = nyClock(new Date(now));
  const dow = new Date(`${c.date}T12:00:00Z`).getUTCDay();
  const out = [];
  for (const r of releases || []) {
    if (r.dates && !r.dates.includes(c.date)) continue;
    if (!r.dates && r.days && !r.days.includes(dow)) continue;
    const [h, m] = r.et.split(":").map(Number);
    const t = nyInstant(c.date, h, m).getTime();
    if (now >= t - 3000 && now <= t + 120000) out.push({ source: r.source, et: r.et });
  }
  return out;
}

// Pure: which sources are due. A source is due when its cadence has come round since its last attempt (a minute's
// slack for the scheduler), or when a release window for it is open (then every second); never while backing off.
export function dueSources(sources, states, now, env, fast = []) {
  const read = [], skip = [];
  for (const s of sources) {
    const st = states[s.key] || {};
    if (s.off) { skip.push({ key: s.key, note: s.off }); continue; }
    if (s.needs && !String(env[s.needs] || "").trim()) { skip.push({ key: s.key, note: s.skipNote || `${s.needs} not set` }); continue; }
    if (st.backoff_until && Date.parse(st.backoff_until) > now) { skip.push({ key: s.key, note: `backing off until ${st.backoff_until}` }); continue; }
    const last = st.last_attempt_at ? Date.parse(st.last_attempt_at) : null;
    const isFast = fast.includes(s.key);
    if (isFast ? (last == null || now - last >= 1000) : (last == null || now - last >= (s.every - 1) * 60000)) read.push({ s, fast: isFast });
  }
  return { read, skip };
}

// Pure: the next back-off after an HTTP 429: Retry-After when given, else 2 minutes doubling to 60.
export function nextBackoff(prevMin, retryAfter) {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(60, Math.max(1, Math.ceil(ra / 60)));
  return prevMin ? Math.min(60, prevMin * 2) : 2;
}

// Pure: write one batch of parsed items against the state. Returns the lines to append and mutates st (seen, stories).
// backfill marks a source's first good read: what it already held was not "seen late", so it is kept out of lag.
export function applyBatch(st, src, items, arrivedAt, { backfill = false } = {}) {
  const firstSeen = msIso(arrivedAt);
  const seen = new Set(Object.keys(st.seen));
  const candidates = st.stories.map((s) => ({ id: s.id, published_at: s.published_at, dedupe_key: s.dedupe_key, url_keys: s.url_keys, sources: s.sources }));
  const stamped = items.map((it) => ({ ...it, first_seen_at: firstSeen }));
  const plan = planDedupe(stamped, { seen, candidates }, new Date(arrivedAt));
  const lines = [];
  const publicTitle = src.group !== "outlet";
  const lag = (it) => (it.published_at && it.time_basis !== "day" ? Math.round((arrivedAt - Date.parse(it.published_at)) / 1000) : null);
  for (const ins of plan.inserts) {
    const id = storyId(ins.source, ins.source_id);
    for (const sg of ins.sightings) st.seen[`${sg.source}|${sg.source_id}`] = firstSeen;
    st.stories.push({ id, published_at: ins.published_at, dedupe_key: ins.dedupe_key, url_keys: [...new Set(ins.sightings.map((x) => x.url_key).filter(Boolean))], sources: [...new Set(ins.sightings.map((x) => x.source))], first_seen_at: firstSeen });
    lines.push({ type: "item", id, source: ins.source, group: src.group, kind: ins.kind, time_basis: ins.time_basis, published_at: ins.published_at, first_seen_at: firstSeen, lag_s: lag(ins), backfill, tickers: ins.tickers, tags: ins.tags, url: ins.url, title: publicTitle ? ins.title : null, story: id, first_with_story: true });
  }
  for (const a of plan.attach) {
    st.seen[`${a.item.source}|${a.item.source_id}`] = firstSeen;
    const story = st.stories.find((s) => s.id === a.raw_id);
    if (story) {
      if (a.item.url_key && !story.url_keys.includes(a.item.url_key)) story.url_keys.push(a.item.url_key);
      if (!story.sources.includes(a.item.source)) story.sources.push(a.item.source);
    }
    const trail = story ? Math.round((arrivedAt - Date.parse(story.first_seen_at)) / 1000) : null;
    lines.push({ type: "sighting", story: a.raw_id, source: a.item.source, published_at: a.item.published_at, first_seen_at: firstSeen, lag_s: lag(a.item), trail_s: trail, earlier: plan.earlier.some((e) => e.raw_id === a.raw_id && e.item.source_id === a.item.source_id), backfill });
  }
  return lines;
}

async function fetchText(url, headers, ms, etag) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const t0 = Date.now();
  try {
    const h = { ...headers, ...(etag?.etag ? { "if-none-match": etag.etag } : {}), ...(etag?.modified ? { "if-modified-since": etag.modified } : {}) };
    const r = await fetch(url, { headers: h, signal: ctl.signal, redirect: "follow" });
    const body = r.status === 304 ? "" : await r.text();
    return { status: r.status, body, arrived: Date.now(), ms: Date.now() - t0, retryAfter: r.headers.get("retry-after"), etag: r.headers.get("etag"), modified: r.headers.get("last-modified") };
  } finally { clearTimeout(timer); }
}

async function ensureCiks(st, env, now) {
  const ua = contactUA(env);
  if (!ua) return new Map();
  if (st.ciks && now - Date.parse(st.ciks.at) < 86400000) return new Map(st.ciks.map);
  try {
    const r = await fetchText(CIK_URL, { "user-agent": ua, accept: "application/json" }, 20000);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const m = cikMap(JSON.parse(r.body));
    st.ciks = { at: msIso(now), map: [...m] };
    return m;
  } catch (e) {
    console.log(`ciks: ${short(e)} (filings keep no ticker until it loads)`);
    return st.ciks ? new Map(st.ciks.map) : new Map();
  }
}

// Pure: the requests one read makes. A source with several feeds (BLS: one per release) reads all of them on its
// cadence, but inside a release window only one per second, in turn, among the feeds due at that time, so a
// window costs that site about one request a second.
export function requestsFor(src, ctx, fast, windowEts = [], turn = 0) {
  const all = src.requests(ctx);
  if (!fast || all.length < 2) return all;
  const due = all.filter((r) => !r.release?.at || windowEts.includes(r.release.at.map((x) => String(x).padStart(2, "0")).join(":")));
  const pool = due.length ? due : all;
  return [pool[turn % pool.length]];
}

async function readSource(st, src, ctx, fast, out, windowEts = []) {
  const now = Date.now();
  const hs = (st.sources[src.key] ||= { ok_reads: 0, failed_reads: 0 });
  hs.last_attempt_at = msIso(now);
  let added = 0, total = 0, notModified = 0;
  try {
    const reqs = requestsFor(src, ctx, fast, windowEts, hs.turn || 0);
    if (fast) hs.turn = (hs.turn || 0) + 1;
    for (const req of reqs) {
      const ek = req.url;
      const r = await fetchText(req.url, req.headers, src.ms || DEFAULT_MS, fast ? st.etags[ek] : null);
      if (r.status === 429) {
        const mins = nextBackoff(hs.backoff_min, r.retryAfter);
        hs.backoff_min = mins;
        hs.backoff_until = msIso(Date.now() + mins * 60000);
        throw new Error(`HTTP 429, backing off ${mins} min`);
      }
      if (r.status === 304) { notModified++; continue; }
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${req.label}`);
      if (r.etag || r.modified) st.etags[ek] = { etag: r.etag, modified: r.modified };
      const items = src.parse(r.body, { ...ctx, req, now: r.arrived });
      total += items.length;
      const backfill = !hs.last_ok_at;
      const lines = applyBatch(st, src, items, r.arrived, { backfill });
      for (const l of lines) out.items.push(l);
      added += lines.filter((l) => l.type === "item").length;
      const newest = items.map((i) => i.published_at).filter(Boolean).sort().at(-1);
      if (newest && (!hs.newest_published_at || newest > hs.newest_published_at)) hs.newest_published_at = newest;
    }
    hs.ok_reads++;
    hs.last_ok_at = msIso(Date.now());
    hs.backoff_min = 0; delete hs.backoff_until; delete hs.last_error;
    out.reads.push({ type: "read", at: hs.last_attempt_at, key: src.key, ok: true, ms: Date.now() - now, items: total, new: added, fast, not_modified: notModified || undefined });
    return { ok: true, added, total };
  } catch (e) {
    hs.failed_reads++;
    hs.last_error = short(e.name === "AbortError" ? `timed out after ${src.ms || DEFAULT_MS} ms` : e);
    hs.last_error_at = msIso(Date.now());
    out.reads.push({ type: "read", at: hs.last_attempt_at, key: src.key, ok: false, ms: Date.now() - now, error: hs.last_error, fast });
    return { ok: false, error: hs.last_error };
  }
}

export async function run({ stateDir, loopSec = 0, env = process.env, sources = SOURCES, releases = [] } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const st = loadState(stateDir);
  const started = Date.now();
  const ciks = await ensureCiks(st, env, started);
  const out = { items: [], reads: [] };
  const summary = {};
  const once = async () => {
    const now = Date.now();
    const windows = openWindowTimes(releases, now);
    const fast = [...new Set(windows.map((w) => w.source))];
    const { read, skip } = dueSources(sources, st.sources, now, env, fast);
    for (const s of skip) summary[s.key] ||= { skipped: s.note };
    // At most 4 sources at a time; SEC's two lists share one host, so they never overlap (well under its 10 a second).
    const queue = [...read];
    const busy = new Set();
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const i = queue.findIndex(({ s }) => !(s.group === "sec" && busy.has("sec")));
        if (i < 0) { await new Promise((r) => setTimeout(r, 200)); continue; }
        const [{ s, fast: f }] = queue.splice(i, 1);
        if (s.group === "sec") busy.add("sec");
        const r = await readSource(st, s, { env, ciks }, f, out, windows.filter((w) => w.source === s.key).map((w) => w.et));
        if (s.group === "sec") busy.delete("sec");
        const sm = (summary[s.key] ||= { reads: 0, failed: 0, new: 0 });
        sm.reads = (sm.reads || 0) + 1; if (!r.ok) { sm.failed = (sm.failed || 0) + 1; sm.error = r.error; } else sm.new = (sm.new || 0) + r.added;
      }
    }));
  };
  await once();
  while (loopSec > 0 && Date.now() - started < loopSec * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    await once();
  }
  const ended = Date.now();
  const app = (f, lines) => { if (lines.length) appendFileSync(join(stateDir, f), lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); };
  app("items.jsonl", out.items);
  app("reads.jsonl", out.reads);
  app("runs.jsonl", [{ type: "run", started_at: msIso(started), ended_at: msIso(ended), loop_s: loopSec, reads: out.reads.length, new: out.items.filter((l) => l.type === "item").length }]);
  saveState(stateDir, st, ended);
  return { summary, items: out.items, reads: out.reads };
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const stateDir = arg("state", join(HERE, ".state"));
  const loopSec = Number(arg("loop", 0)) || 0;
  const relPath = join(HERE, "releases.json");
  const releases = existsSync(relPath) ? JSON.parse(readFileSync(relPath, "utf8")).releases : [];
  const res = await run({ stateDir, loopSec, releases });
  // Counts only in the log: this repo's Actions logs are public.
  for (const [k, v] of Object.entries(res.summary)) console.log(`${k}: ${v.skipped ? `skipped (${v.skipped})` : `${v.reads} read${v.reads === 1 ? "" : "s"}, ${v.failed || 0} failed, ${v.new} new${v.error ? `; last error: ${v.error}` : ""}`}`);
}
