# Tuesday 2026-04-28 — Punch List

Tracking what surfaced today during live ops + what's outstanding for after close. Today shipped 10 fixes live; this captures what we found that we're NOT fixing right now.

---

## P0 — Calibration / signal quality

### 1. DTE-bucketed win threshold (grader)
**Symptom:** Today's high-conviction flags showed +7-11% peaks but the grader's `alarmWinPct=50` (fixed) marks them as `partial` because none hit +50%. The Won tab is artificially empty for non-0DTE setups even when the system found real movement.

**Today's evidence:** 9 unique contracts at score ≥70, peaks 1-11%, none hit +50%. 3 went negative. The signal looks reasonable; the success criteria are too tight for mid-DTE.

**Fix path:**
- Make `alarmWinPct` DTE-bucketed in `ct_flag_grader/index.ts` `computeAlarmOutcome`:
  - 0DTE: 50% peak (current)
  - 1-7 DTE: 30% peak
  - 8-30 DTE: 15% peak
  - 30+ DTE: 10% peak
- Mirror in `ct_config` so it's tunable
- Re-grade past 7 days using the new buckets
- Today's MSFT 425C (10-DTE, +11%) flips from `partial` → `win`

**Why deferred:** Need at least one full week of data under bucketed thresholds to validate vs the corpus before changing how we measure success. Sunday calibration item.

---

### 2. Per-option-symbol track dedup (print-grader)
**Symptom:** Each print of a contract creates a new ct_contract_tracks row. WORKING pool has 6,990 tracks for ~4,400 unique option_symbols (1.6x dup ratio). Top dups: QQQ260618P00600000 has 18 tracks.

**Cost:** Every duplicate track competes for poller throughput → the freshest print starves the older same-contract tracks. Grader's MAX-peak RPC papers over this but doesn't fix it.

**Fix path:** print-grader UPSERTs on (option_symbol) instead of INSERTs per print. Single track per symbol, sweep_count + last_quoted_at advance with each new print. Drops WORKING pool to ~4,400 → poller cycles through 1.6x faster at same maxPerRun.

**Why deferred:** Touches every track-create path. Needs careful migration to dedup existing rows. Saturday's heavy work.

---

### 3. Per-alert score-race fix coverage audit
**Today's three score-race variants caught:**
1. Morning: pg_cron sequencing (cron-level race) — fixed by inlining ct_score_existing_flow in watcher cron body
2. Mid-day: edge-fn cold-start race — fixed by per-alert inline scoring in watcher
3. Afternoon: executed_at=null skipped recovery — fixed by falling back to ingested_at

Each one was structurally distinct and only visible against live flow. There may be a fourth variant we haven't seen.

**Action:** Sunday calibration — write a synthetic test that fires the watcher under cold-start, late-ingest, null-executed_at, and large-batch conditions. Confirm 0/N zero rate on each.

---

## P1 — Polish / UX

### 4. Yesterday's stale tracks at peak=0
**Symptom:** ~133 WORKING tracks have `last_tracked_at` from before today. Those still report peak_contract_pct=0 because the poller never came back. The grader's MAX-peak RPC handles this when there's a fresher track for the same symbol, but pure orphans (no fresher track) stay broken.

**Fix path:** One-shot RPC `ct_repoll_stale_tracks(p_min_age_hours)` that bypasses the cadence filter for any WORKING track older than N hours. Run it at session start each day.

---

### 5. Flow Butterfly mode 'bb' historical view
**Status:** Today's date-range fix only extended mode 'cp' (calls vs puts). The agent skipped 'bb' (cumulative bullish/bearish) because that mode is hardcoded off in the UI right now. If we ever turn it back on, historical view won't work for it.

**Fix path:** Apply same `p_until` parameter to `ct_flow_pulse_chart` RPC + thread through `useFlowPulseChart` hook. Already half-done.

---

### 6. Cluster detector firing duplicates
**Today's evidence:** MSFT 425C bullish 85 fired on three detectors simultaneously (signature_v1 + cluster_default + cluster_slow_stacker), all at the same minute, all pushed to Slack. James got 3 Slack messages for 1 actual signal.

**Fix path:** Slack pusher dedups by `(option_symbol, direction, minute)` and only pushes the highest-scoring of the cluster within a window.

---

### 7. /flags page — sticky filter for "Today" should auto-include 7d for outcome tabs
**Symptom:** Today's flags don't have grades yet (horizons haven't expired). Won/Lost/Neutral tabs return zero on Today filter. Confusing UX.

**Fix path:** When user clicks Won/Lost/Neutral while on "Today", auto-bump date filter to 7d AND show a small "(showing past 7 days for graded outcomes)" hint.

---

## P2 — Backlog / not blocking

### 8. Specialist bullish-bias rewrite verification
v2 prompts shipped this morning have hard-gated bias audit + 3:3:1 few-shot. Direction balance went 89/11 → 67/32 — measurable improvement but specialists haven't fired today (no specialist alarm in 12 hours). Need to wait for them to fire to verify v2 is producing balanced flags.

### 9. Bear-side signature class corpus growth
After the directionInference fix, corpus has 37 `aggressive_ask_put` (bearish) classes, all with hit_rate 0-4% historically because the recent regime has been bullish. As bearish moves materialize, those classes will accumulate winners and signature_v1 will start firing bearish.

### 10. Ct_signature_alarm_log → ct_flags 1:1 audit
Some flag rows may not have matching alarm_log entries (and vice versa) — would explain occasional grader misses. Worth a Sunday SQL audit.

### 11. Pulse zero-rate residual
40-50% of `ct_flow_pulse_ticks` rows still have all-zero counts. Pre-fix-cron rows account for most. Don't backfill; let the new schedule's healthy rows crowd them out over a few sessions.

### 12. MaxPerRun bump beyond 100
The poller's at 100 now (was 60). UW budget allows higher. Could bump to 120-150 if 1-sweep % stays above 10% for too long. Watch metric: 1-sweep % over 7d should trend toward 5%.

---

## Already shipped today (reference)

1. Off-RTH ingester killed (UW budget)
2. ct-detector-scorer + cron */5 13-20
3. Specialist v2 prompts (hard-gated bias audit, 3:3:1 few-shot)
4. Pulse capture race fix (LEFT JOIN + cron resequencing)
5. Signature watcher score-race v1 (cron-level inline)
6. /flags page source filter (specialist + signature_alarm + detector_alarm)
7. directionInference RepeatedHits put → ask-aggressive (root cause of bullish bias)
8. Detector functions write target_price + invalidation_price
9. Grader uses MAX(peak) per option_symbol via new RPC
10. Poller throughput */5 → */3, maxPerRun 60 → 100
11. /flags spot lookup falls back to instrument when specialist_ticker null
12. /flags axis-aware progress chip (contract vs underlying spot)
13. Signature watcher score-race v2 (per-alert inline recovery)
14. Signature watcher score-race v3 (executed_at→ingested_at fallback)
15. Flow Butterfly historical date-range view (cp mode)

---

## Notes on calibration philosophy

The morning's 10 structural fixes weren't pre-planned — each surfaced when live data exposed a bug that was invisible in test data. The pattern: ship, watch, see what breaks, fix, repeat.

For tomorrow: same loop. Don't wait for a "calibration sprint" — fix what we see when we see it.
