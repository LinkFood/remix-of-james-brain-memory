#!/usr/bin/env node
// The dry test's scorecard, from the state folder the collector writes, and the files the page reads.
//
//   node newsfeed/scorecard.mjs [--state DIR] [--out DIR] [--moves moves.json]
//
// Three questions, every count with its denominator:
//   1. Seconds late: for each source, first_seen_at minus the source's own time (published or filed), on items seen
//      after the source's first good read (what a feed already held at the start is "backfill", not late).
//   2. Sources broken: reads that failed, the longest stretch with no good read, the newest item's age.
//      The collector's own gaps (runs.jsonl: the scheduler started late or skipped) are counted apart, so a late
//      GitHub schedule is never blamed on a source.
//   3. Moves with no headline: optional. moves.json lists price moves ([{ at, symbol, note }], from Market Waves'
//      bars or alarms); each move is checked for an item first seen in the 30 minutes before it, the 30 minutes after,
//      or neither. The scorecard never fetches prices itself.
// Writes out/latest.json (the last 48 hours of items, for the page), out/health.json and out/scorecard.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "./lib/sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
}

// Pure: the longest stretch, in minutes, between consecutive times (with the window's ends), or null.
export function longestGap(times, from, to) {
  const t = [from, ...times.map((x) => Date.parse(x)).sort((a, b) => a - b), to].filter(Number.isFinite);
  let best = 0;
  for (let i = 1; i < t.length; i++) best = Math.max(best, t[i] - t[i - 1]);
  return t.length > 1 ? Math.round(best / 60000) : null;
}

// Pure: each move against the items first seen around it.
export function checkMoves(moves, items, windowMin = 30) {
  const w = windowMin * 60000;
  return (moves || []).map((m) => {
    const t = Date.parse(m.at);
    const near = items.filter((i) => !i.backfill && Number.isFinite(Date.parse(i.first_seen_at)));
    const match = (i) => !m.symbol || !(i.tickers || []).length || i.tickers.includes(m.symbol) || (m.tags || []).some((g) => (i.tags || []).includes(g));
    const before = near.filter((i) => Date.parse(i.first_seen_at) <= t && t - Date.parse(i.first_seen_at) <= w && match(i));
    const after = near.filter((i) => Date.parse(i.first_seen_at) > t && Date.parse(i.first_seen_at) - t <= w && match(i)).sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
    return { ...m, headline: before.length ? "before" : after.length ? "after" : "none", minutes_after: after.length && !before.length ? Math.round((Date.parse(after[0].first_seen_at) - t) / 60000) : null, before: before.length, after: after.length };
  });
}

export function score({ items, reads, runs, state, moves = null, now = Date.now() }) {
  const from = runs.length ? Date.parse(runs[0].started_at) : now;
  const bySrc = {};
  for (const s of SOURCES) bySrc[s.key] = { key: s.key, label: s.label, group: s.group, every_min: s.every };
  const out = [];
  for (const s of Object.values(bySrc)) {
    const rs = reads.filter((r) => r.key === s.key);
    const ok = rs.filter((r) => r.ok);
    const its = items.filter((i) => i.type === "item" && i.source === s.key);
    const live = its.filter((i) => !i.backfill && Number.isFinite(i.lag_s));
    const lags = live.map((i) => i.lag_s);
    const st = state.sources?.[s.key] || {};
    const errors = {};
    for (const r of rs) if (!r.ok) errors[r.error] = (errors[r.error] || 0) + 1;
    out.push({
      ...s,
      reads: rs.length, reads_ok: ok.length, reads_failed: rs.length - ok.length,
      errors: Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([error, n]) => ({ error, n })),
      longest_without_good_read_min: rs.length ? longestGap(ok.map((r) => r.at), from, now) : null,
      items: its.length, items_backfill: its.length - live.length, items_live: live.length,
      lag_s: { n: lags.length, median: quantile(lags, 0.5), p90: quantile(lags, 0.9), max: lags.length ? Math.max(...lags) : null },
      newest_published_at: st.newest_published_at || null,
      newest_age_min: st.newest_published_at ? Math.round((now - Date.parse(st.newest_published_at)) / 60000) : null,
      last_ok_at: st.last_ok_at || null, last_error: st.last_error || null, last_error_at: st.last_error_at || null,
      skipped: rs.length ? null : "never read (needs NEWSFEED_CONTACT, or not run yet)",
    });
  }
  const runStarts = runs.map((r) => r.started_at);
  const sightings = items.filter((i) => i.type === "sighting");
  const merged = new Set(sightings.map((s) => s.story));
  const broken = out.filter((s) => s.reads && (s.reads_failed / s.reads > 0.1 || (s.last_ok_at && now - Date.parse(s.last_ok_at) > 3 * s.every_min * 60000 + 600000)));
  return {
    generated_at: new Date(now).toISOString(),
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), runs: runs.length },
    collector: { runs: runs.length, longest_gap_between_runs_min: longestGap(runStarts, from, now), gaps_over_10_min: runStarts.slice(1).filter((t, i) => Date.parse(t) - Date.parse(runStarts[i]) > 600000).length },
    sources: out,
    broken: broken.map((s) => s.key),
    stories: { total: items.filter((i) => i.type === "item").length, with_more_than_one_source: merged.size, sightings: sightings.length, trail_s_median: quantile(sightings.filter((s) => !s.backfill).map((s) => s.trail_s).filter(Number.isFinite), 0.5) },
    moves: moves ? checkMoves(moves, items.filter((i) => i.type === "item")) : null,
  };
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const dir = arg("state", join(HERE, ".state"));
  const outDir = arg("out", join(dir, "export"));
  mkdirSync(outDir, { recursive: true });
  const items = lines(join(dir, "items.jsonl")), reads = lines(join(dir, "reads.jsonl")), runs = lines(join(dir, "runs.jsonl"));
  const state = existsSync(join(dir, "state.json")) ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) : {};
  const mp = arg("moves", null);
  const now = Date.now();
  const card = score({ items, reads, runs, state, moves: mp && existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : null, now });
  const recent = items.filter((i) => i.type === "item" && now - Date.parse(i.first_seen_at) <= 48 * 3600000).sort((a, b) => (b.published_at || b.first_seen_at).localeCompare(a.published_at || a.first_seen_at)).slice(0, 1500);
  const seenBy = {};
  for (const s of items) if (s.type === "sighting") (seenBy[s.story] ||= []).push({ source: s.source, trail_s: s.trail_s });
  writeFileSync(join(outDir, "latest.json"), JSON.stringify({ generated_at: card.generated_at, last_run: runs.at(-1) || null, items: recent.map((i) => ({ ...i, also: seenBy[i.story] || [] })) }));
  writeFileSync(join(outDir, "health.json"), JSON.stringify({ generated_at: card.generated_at, last_run: runs.at(-1) || null, collector: card.collector, broken: card.broken, sources: card.sources.map(({ key, label, group, reads, reads_ok, last_ok_at, last_error, newest_published_at, newest_age_min, lag_s }) => ({ key, label, group, reads, reads_ok, last_ok_at, last_error, newest_published_at, newest_age_min, lag_s })) }));
  writeFileSync(join(outDir, "scorecard.json"), JSON.stringify(card, null, 1));
  console.log(`scorecard: ${card.window.runs} runs, ${card.stories.total} stories, broken: ${card.broken.join(", ") || "none"}`);
}
