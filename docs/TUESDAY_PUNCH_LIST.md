# Tuesday 2026-04-28 — Punch List

Tracking what surfaced today during live ops + what's outstanding for after close. Today shipped 10 fixes live; this captures what we found that we're NOT fixing right now.

**Updated 2026-04-28 ~23:15 UTC after evening polish session.** 6 of 12 items shipped + verified live (#5, #6, #7 from P1, #11b from P2, plus EOD `regime_tag/snapshot_hit_rate` and ct-cron-health-check step-interval suppression — both new items not on original list). 2 read-only diagnostics run on remaining items — see "Tonight's diagnostic findings" below.

---

## P0 — Calibration / signal quality

### 0. Re-poll canonical week + diff signature corpus  ⏰ run when UW budget has headroom

**The problem:** Every detector predicate was built off the canonical Mon-Fri 4/20→4/24 corpus. That corpus reads from `ct_contract_tracks.peak_contract_pct`. ~60% of tracks have peak=0 because the poller couldn't keep up before today's throughput bump. The winners pool is structurally under-inclusive — we tuned detectors against ~70% of actual winners, missing the long tail of fast-spike winners whose track only got one poll.

**Implication:** Detectors aren't wrong (every flag is a real pattern), but they're under-inclusive (missing patterns the corpus didn't see). Sunday calibration was built on biased data.

**The fix is a one-shot re-poll of the canonical week:**

1. Wait until UW daily budget has headroom (tonight if we close ≤70%, otherwise Sat/Sun when nothing competes for budget)
2. Force-fire `ct-contract-poller` in `offhours` mode against tracks `print_time >= 2026-04-20 AND print_time < 2026-04-25`
3. Bypass cadence filter (these are cold tracks, every poll captures real movement)
4. Estimated cost: ~5k UW calls (5,000 tracks × 1-2 polls each)
5. Will take ~2 hours via */3 cron at maxPerRun=100, OR ~30 min force-fired manually

**Diff procedure:**
1. Snapshot `ct_signature_magnitude_stats` BEFORE re-poll → save as `pre_repoll_corpus.json`
2. Run re-poll
3. Snapshot AFTER → save as `post_repoll_corpus.json`
4. Diff: new signature_classes appearing? hit_rates shifting? n_tracks growing? Class with biggest delta = the one most affected by polling bias.

**Sunday calibration agenda after re-poll:**
- Re-run detector portfolio backtest against corrected corpus
- Identify classes that promoted/demoted
- Adjust detector thresholds for the new winner distribution
- Some detectors may stay identical; others may shift

**Trigger conditions to run NOW (tonight):**
- UW close ≤70% AND
- Off-hours window (post-21:00 UTC) AND
- No active backfill pipe running

**Trigger condition Sat/Sun:**
- Whenever — UW budget is unconstrained on weekends

**Why this is P0 and not Sunday-default:** detector portfolio depends on this. Every day we don't run it, new flags fire on a biased corpus. Once shipped, it's permanent — corpus stays clean going forward because the poller now keeps up.

---

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

### 5. Flow Butterfly mode 'bb' historical view ✅ SHIPPED 2026-04-28 evening (commit `7755a30`)
**Status:** Today's date-range fix only extended mode 'cp' (calls vs puts). The agent skipped 'bb' (cumulative bullish/bearish) because that mode is hardcoded off in the UI right now. If we ever turn it back on, historical view won't work for it.

**Fix path:** Apply same `p_until` parameter to `ct_flow_pulse_chart` RPC + thread through `useFlowPulseChart` hook. Already half-done.

**Resolution:** Hook signature now accepts `dateRange` symmetrically for both cp and bb modes. RPC `ct_flow_pulse_chart` does NOT accept `p_until` — that's an out-of-scope migration. The bb call site has the param threaded but commented with a TODO. Re-enable path: ALTER `ct_flow_pulse_chart` to accept 4th TIMESTAMPTZ param, uncomment one line in `useFlowPulse.ts`. Code-level symmetry achieved; bb stays hidden in UI.

---

### 6. Cluster detector firing duplicates ✅ SHIPPED 2026-04-28 evening (commit `e5c5f11`)
**Today's evidence:** MSFT 425C bullish 85 fired on three detectors simultaneously (signature_v1 + cluster_default + cluster_slow_stacker), all at the same minute, all pushed to Slack. James got 3 Slack messages for 1 actual signal.

**Fix path:** Slack pusher dedups by `(option_symbol, direction, minute)` and only pushes the highest-scoring of the cluster within a window.

**Resolution:** ct-slack-push-flag groups pending flags by `(option_symbol, direction, minute_bucket)`, sorts by score DESC + created_at ASC, pushes leader only. Non-leaders get `ct_slack_log` rows with `pushed=false, skip_reason='cluster_dedup_lower_score'` and `slacked_at` stamped to keep them out of next sweep. Composite key falls back to `(instrument, side, strike, expiry, direction, minute)` when option_symbol is null. Audit query: `SELECT * FROM ct_slack_log WHERE skip_reason = 'cluster_dedup_lower_score'` — accumulates as live clusters fire.

---

### 7. /flags page — sticky filter for "Today" should auto-include 7d for outcome tabs ✅ SHIPPED 2026-04-28 evening (commit `3e592ff`)
**Symptom:** Today's flags don't have grades yet (horizons haven't expired). Won/Lost/Neutral tabs return zero on Today filter. Confusing UX.

**Fix path:** When user clicks Won/Lost/Neutral while on "Today", auto-bump date filter to 7d AND show a small "(showing past 7 days for graded outcomes)" hint.

**Resolution:** Auto-bump fires on Won/Lost/Neutral click when date is Today. Hint renders next to date pills, clears on any manual date change. Active and All outcomes do NOT trigger auto-bump (control case). Verified live in browser end-to-end.

---

## P2 — Backlog / not blocking

### 8. Specialist bullish-bias rewrite verification
v2 prompts shipped this morning have hard-gated bias audit + 3:3:1 few-shot. Direction balance went 89/11 → 67/32 — measurable improvement but specialists haven't fired today (no specialist alarm in 12 hours). Need to wait for them to fire to verify v2 is producing balanced flags.

### 9. Bear-side signature class corpus growth
After the directionInference fix, corpus has 37 `aggressive_ask_put` (bearish) classes, all with hit_rate 0-4% historically because the recent regime has been bullish. As bearish moves materialize, those classes will accumulate winners and signature_v1 will start firing bearish.

### 10. Ct_signature_alarm_log → ct_flags 1:1 audit ⚠ DIAGNOSTIC RUN 2026-04-28 evening — gap confirmed
Some flag rows may not have matching alarm_log entries (and vice versa) — would explain occasional grader misses. Worth a Sunday SQL audit.

**Diagnostic finding (read-only, last 7d):**
- ct_flags signature_alarm rows: **733**
- ct_signature_alarm_log entries: **610**
- **Gap: 123 flags without an alarm log entry (16.8%)**

123 missing alarm log rows means 16.8% of signature_alarm flags have no provenance row in the log table. That's enough to explain the periodic "flag exists but grader can't find lineage" misses. Not fixed tonight — needs Sunday SQL audit to determine: (a) which fired path skips the log write, (b) whether the gap is a cron timing race (flag written before log row commits) or a logic gap (no log write call on that code path), (c) backfill rule for missing rows. **Fix is structural — find the path that doesn't write the log row, add the write, audit class becomes impossible.**

### 11b. ct_compute_gamma_flip last-resort fallback picks bad strikes ✅ SHIPPED 2026-04-28 evening (commit `d0973cc`)
**Symptom:** Sometimes returns far-OTM strike (NVDA showed 1.5 with spot 213, QQQ 451 with spot 658). Happens when sign-change scan finds no crossing in the meaningful-strikes window, or when spot is null (QQQ). The function falls back to "smallest |net_gex| across all strikes" which on sparse gex chains picks a thin OTM tail.

**Cause:** Two separate issues:
1. Sign-change scan filters strikes via `meaningful` CTE (drops strikes with no call_gex + put_gex activity). On thin chains, the meaningful set may be all-positive or all-negative — no crossing exists.
2. Final fallback `LIMIT 1` on `ORDER BY abs(net_gex) ASC` picks the global minimum, which is often a near-zero far-OTM strike.

**Fix path:** Tighten the fallback to "min |net_gex| WITHIN 10% of spot" (already exists as middle fallback). Drop the global-min last-resort entirely — return NULL if no flip detected near spot. Better to show "—" in the UI than 1.5.

**Resolution:** Migration `20260428223000_gamma_flip_drop_global_min_fallback.sql` removed the global-min last-resort. Function now returns NULL when no near-spot crossing exists. Verified across all 10 watchlist tickers post-fix — every gamma_flip within 5% of spot. The 1.5 / 451 fabrication class is structurally impossible going forward.

---

### 11a. QQQ underlying_price null in ct_gex_timeseries ❌ FALSE PREMISE — investigation found different cause
**Symptom:** QQQ snapshot shows spot=null, gamma_flip falls back to last-resort logic (451 vs spot ~658). All other 9 watchlist tickers have spot populated correctly.

**Cause:** Whichever ingester populates `ct_gex_timeseries.underlying_price` is failing for QQQ specifically. UW returns the data; something downstream isn't setting the column.

**Fix:** Find the ingester (`ct-gex-ingester` or similar), check if it explicitly handles QQQ vs index ETFs differently, fix the column write. One-off ingester fix, ≤30 min.

**2026-04-28 evening investigation:** Database shows QQQ has 286,149 rows with `underlying_price` populated and only 4,296 null (FEWER nulls than SPY's 5,806). Today's QQQ snapshots all have `underlying_price=658.0105` correctly. **The bug premise was wrong.** The bad gamma_flip 451 / NVDA 1.5 symptoms were the gamma_flip global-min fallback (item 11b) picking far-OTM strikes from the adjusted-options chain, NOT a null-spot bug. With 11b shipped, the symptom is gone. Closing this item — no fix needed.

---

### 11. Pulse zero-rate residual
40-50% of `ct_flow_pulse_ticks` rows still have all-zero counts. Pre-fix-cron rows account for most. Don't backfill; let the new schedule's healthy rows crowd them out over a few sessions.

### 12. MaxPerRun bump beyond 100
The poller's at 100 now (was 60). UW budget allows higher. Could bump to 120-150 if 1-sweep % stays above 10% for too long. Watch metric: 1-sweep % over 7d should trend toward 5%.

---

## New items surfaced 2026-04-28 evening

### N0. Unified grading vision — /flags + /tape + drill sheet should tell ONE story  📅 WEEKEND DISCUSSION

**Problem James caught 2026-04-28 night:** /tape HORIZONS column shows "won 4h" / "loss 2h" tags on individual flow alerts (sourced from `ct_print_grades` / `ct_print_tracks` — print-grader Pass 1 + Pass 2). Meanwhile /flags Won/Lost tabs were empty because `ct_flag_grades` is a separate table with different criteria (target_price hit by horizon expiry, gated on score ≥ 70 fire-time). Two grading systems, two visual presentations, no connection. User sees winners on /tape but nothing on /flags and asks "does that make sense?"

**Tonight's quick-fix (commit shipped 2026-04-28 night, ship-Option-C):** /flags Won/Lost/Neutral now uses `ct_flag_grades!inner` + DB-level outcome filter + bypasses fire-time score floor when on outcome filter. So at least /flags surfaces its OWN graded wins/losses honestly. But the bigger question stays open.

**Weekend question to discuss:**
- Should /flags ALSO show print-level outcomes for the contract? E.g., MSFT 425C flag fires at score 70 → flag_grade looks at MSFT spot at horizon → win/loss verdict. But the SAME contract's prints get graded by print-grader against the contract's own price move. Both views are valid. Should the drill sheet show BOTH? "Flag-level: WIN (alpha +1.4%) | Print-level: WIN (contract paid +47% in 2h)"
- Or unify: drop ct_flag_grades entirely and have /flags read its outcome from ct_print_tracks for the contract? Means the flag inherits the contract's lifetime outcome, regardless of fire-time horizon.
- Or hybrid: flag-grader still runs but UI surfaces both verdicts side-by-side, makes the difference legible.

**What this would change on the site:**
- Drill sheet shows two verdicts (alpha-axis + contract-axis) — answers different questions
- /flags Won/Lost would have tighter signal (a flag with both verdicts matching is high-confidence)
- Detector calibration becomes richer — train against contract-level outcomes (where money was made), not just alpha-vs-spy

**What it would change architecturally:**
- ct_flag_grades + ct_print_grades + ct_contract_tracks all touch the same conceptual question: "did the signal pay?"
- Today they answer different versions of that question silently
- Worth a calibration philosophy chat on Saturday before any code touches

**Why this is on the punch list (not Sunday-default):** Sunday calibration sprint is detector-threshold tuning. This is one layer up — what the system MEANS by "win." Belongs in a Saturday architectural discussion before the Sunday tuning runs.

---

### N1. EOD generator left `regime_tag` + `snapshot_hit_rate` null ✅ SHIPPED (commit `920071e`)
EOD Slack message went out Mon + Tue saying "regime untagged · n/a hit rate" because generator never wrote to those columns despite them existing on `ct_eod_summaries`. Fixed: regime_tag derived from market_premium delta, snapshot_hit_rate computed from grade breakdown. Verified live.

### N2. ct-cron-health-check step-interval false alarm ✅ SHIPPED (commit `ba3938b`)
Health monitor was paging Slack hourly all night for `ct-self-grader` (schedule `0 13-20/2 * * 1-5` — RTH-only by design, fires 13/15/17/19 UTC then quiet). Schedule parser handled continuous ranges but treated step intervals as "active until 20:00 UTC", missing that the LAST scheduled hour was 19:00. Fixed: step intervals expanded to last-actual-fire-hour. Two consecutive post-fix ticks (23:00, 23:10 UTC) silent on ct-self-grader.

### N3. QQQ adjusted-strike series in ct_gex_timeseries — NOT a bug
Diagnostic ran 2026-04-28 evening: QQQ today has 438 strikes in latest snapshot, 88 of which end in `.78` (e.g., 174.78, 179.78, 184.78). These are **legitimate adjusted-strike option series** (post-corporate-action chains). They have small but non-zero OI/gex. Pre-fix, gamma_flip global-min fallback picked them on sparse chains. Post-fix (item 11b), gamma_flip returns NULL on sparse cases. The downstream symptom is resolved. **Open question for future tuning:** should adjusted-strike chains be filtered from gex calculation, or kept for completeness? Not blocking — file as P3.

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

## Evening polish session shipped (2026-04-28 ~21:00–23:30 UTC)

16. EOD generator populates regime_tag + snapshot_hit_rate (commit `920071e`)
17. ct-cron-health-check step-interval suppression (commit `ba3938b`)
18. ct-slack-push-flag cluster dedup (commit `e5c5f11`)
19. ct_compute_gamma_flip drop global-min fallback (commit `d0973cc`)
20. /flags Won/Lost/Neutral auto-bump to 7d (commit `3e592ff`)
21. FlowPulse symmetric p_until threading for bb mode (commit `7755a30`)

---

## Notes on calibration philosophy

The morning's 10 structural fixes weren't pre-planned — each surfaced when live data exposed a bug that was invisible in test data. The pattern: ship, watch, see what breaks, fix, repeat.

For tomorrow: same loop. Don't wait for a "calibration sprint" — fix what we see when we see it.

---

## Wednesday 2026-04-29 — added during open watch

### Frontend — bell-ring refetch invalidation (caught 9:35 ET)
- Hooks with `refetchInterval: () => (isMarketHoursET() ? N : false)` freeze if the page is loaded pre-bell. React Query doesn't re-evaluate the interval at the 9:30 ET transition.
- Confirmed broken: `useNetPremiumCumulative` (Flow Butterfly).
- Suspected same pattern: `useFlowPulse`, `useMacroSparklines`, possibly other market-hours-gated hooks.
- Fix (Saturday): one `useMarketHoursTrigger` at app root that polls every 30s and calls `queryClient.invalidateQueries({ predicate: q => q.queryKey[0]?.toString().startsWith('ct_') })` on the bell transition.
- Workaround until then: hard refresh post-bell.
- See `~/.claude/projects/-Users-jameschellis/memory/feedback_market_hours_refetch_invalidation.md`.

### Cron health — staggered-minute schedule false alarm (caught 9:00 ET)
- 7 RTH-only crons fired stale alerts at 13:00 UTC because their first scheduled fire of the day is NOT at minute 0 (e.g., `1,6,11,...`). Tuesday's `ba3938b` step-interval fix doesn't catch staggered-minute schedules.
- Affected: ct-curiosity, ct-detector-{small-cap-inverted-put,weekly-atm-voi,zerodte-opening-call,zerodte-put-voi}-rth, ct-flow-pulse-capture, ct-trade-advisories.
- Auto-resolved at 13:20 UTC once first fires landed. Same false-alarm class as Tuesday's ct-self-grader.
- Fix (Saturday): extend `ct-cron-health-check` schedule parser to compute `nextFireAfter(now)` for staggered-minute lists (1,6,11,16,...) — alert only when `now > nextFireAfter + threshold`.

### 13:30 UTC ingester silent fire (one-off, may not recur)
- ct-flow-ingester-perticker-rth's 13:30 UTC fire at the open did NOT write any rows. 13:35 UTC fire was healthy.
- Could be: pg_cron skipped, UW returned empty at the open second, or function timed out before write.
- Single-day occurrence. If it happens again Thursday's open, escalate to root-cause investigation.

### VIX consumer cleanups (caught during VIX precision fix 2026-04-29)

- **`supabase/functions/ct-custom-rule-eval/index.ts:226`** selects `'date, close'` from `ct_vix_history` but the column is `level`. Returns NULL VIX in custom rule evaluation. One-line fix.
- **`build_ticker_quant_card` RPC** (4 migrations) — uses `WHERE date <= v_today ORDER BY date DESC LIMIT 1` for VIX. With intraday rows now stored, ties on `date` resolve to an arbitrary row. Should be `ORDER BY date DESC, created_at DESC`. Risk of touching 565-line RPC for one tweak — defer until next quant-card change.

### ContractDrillSheet — print_count indicator not rendering (caught live 2026-04-29 ~14:00 ET)

- DB has clean dedup: AMZN260605C00265000 has 1 ct_contract_tracks row with print_count=21 + 21 ct_contract_track_alerts ledger rows.
- /tape Stacking Patterns table column correctly shows "21 prints".
- `ContractDrillSheet.tsx:180-182` JSX renders `{track.print_count} prints · last {timestamp}` in amber when `track.print_count > 1`.
- **The amber indicator is NOT rendering** when drill sheet opened from Stacking Patterns row click. Page-text search confirmed absent.
- Likely cause: drill sheet `track` prop is undefined / loaded from wrong shape / stale React Query, so `track.print_count > 1` guard fails.
- Fix priority: medium. The actual dedup is structurally working — this is a UX-only gap that prevents James from visually confirming dedup at a glance.
