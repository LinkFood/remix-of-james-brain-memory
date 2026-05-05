# Phase A — D2 Regime Threshold Recalibration (10-ticker watchlist)

**Date:** 2026-05-05 evening
**Posture:** READ-ONLY diagnosis. ZERO code, ZERO migrations, ZERO writes.
**Trigger:** D1 (filter swap `event_ts` → `scored_at`) was empirically WRONG_FRAME — recovers only ~10.9% of `no_events` fires. The dominant failure mode is score-distribution drift, not timing-race. D2 must address per-ticker threshold calibration vs the underlying regime.
**Pre-audit state:** `ct_config.specialist.NVDA.wakeup_threshold` 60 → 55 was just patched at `2026-05-05T23:29:35Z` as a 1A stopgap. NVDA-only. Verified one-row update; no other thresholds touched. The other 5 known-affected (MSFT/AAPL/MSFT-style) wait on D2.

---

## Methodological preamble — third instance of brief-author-premise-error

`docs/methodology-patterns.md` records two prior instances of the
**brief-author-premise-error** pattern:

1. **2026-05-02 forensic corpus build** — Phase 4 audit said "98.3% ungraded; build a grader extension." Phase A archeology found `ct_flag_grades` already had 1,407 graded rows; the corpus MV simply wasn't joining to it. Real fix was adding a LEFT JOIN, not building anything new.
2. **2026-05-05 MCP v1.1 brief** — said "parallelize organ fetches via Promise.all." Phase A measurement showed organs were already parallel (~500ms inner) but a 50-await legacy flat-fields prefix was swamping the call. Real fix was `skipLegacyFlatFields`, not parallelization.

**This audit is the third instance.** D1's brief said "swap the filter from `event_ts` to `scored_at` — score-race kills wakeups when events get scored after their window closes." Phase B execution against the D1 brief recovered only 14 of 129 (10.9%) `no_events` fires — meaning ≈89% of failures were not score-race at all. The empirical signature now points unambiguously at **score-distribution drift across the 10-ticker watchlist**, not timing.

What unifies all three instances: the brief author performed a mental
audit, settled on a causal model, and wrote a fix that addressed *that
supposed cause*. Phase A's job — every time — is to verify the brief's
implicit causal model with empirical measurement BEFORE shipping the
brief's prescribed Phase B. Skipping that verification step is how you
ship non-fixes while the real bottleneck stays open.

**Diagnostic question in force for THIS audit:** *"Does my measurement
support the brief's implicit causal model — that per-ticker threshold
tuning IS the right lever — or is the actual root cause a scoring-function
calibration shift that threshold tuning just papers over?"* §2 below
answers it directly.

---

## TL;DR — verdict

**D2_RIGHT_LEVER (with caveats and a preventive warden invariant required).**

- Score-distribution drift across the 10-ticker watchlist is REAL and VARIABLE per ticker. It is NOT a global scoring shift. Specifically: AAPL `pct_volume>OI` halved (30.8% → 13.4%), NVDA halved (32.3% → 17.3%), MSFT p75 dropped 14.5pts (67.5 → 53.0). Other tickers (TSLA, QQQ, SPY, IWM, AMZN, GOOGL, META) drifted little or in the opposite direction. **A scoring-function fix would be wrong** — it would re-distort the tickers that are already healthy.
- Per-ticker threshold tuning IS the structurally correct lever, conditional on shipping a **preventive warden invariant** alongside it. Without the invariant, the next regime drift triggers another threshold-patch cycle and the class never gets killed.
- 3 specialists (NVDA, MSFT, AAPL) need explicit re-tuning. 2 (NVDA pre-1A, MSFT) were structurally near-edge BEFORE the drift even started — pre-drift NVDA p75 was already 52.5 vs threshold 60. The April 2026 calibration was either too aggressive or based on a pre-flow-ingester-split corpus.
- D3 (scoring-function recalibration) is **NOT needed for the immediate problem** but should be queued as a separate Phase A-only audit for the long-term question: "is the ct_score_flow_event formula well-suited to a 'mostly existing-position' regime, or does it under-weight a class of signal that would discriminate in this regime?" That's a corpus-level analysis question, not a threshold question. §6 sketches it.

**Right Phase B shape (§5):** per-ticker threshold UPDATEs for NVDA / MSFT / AAPL + preventive warden invariant + 2-3 day per-specialist verification window + telemetry on per-specialist fire rate delta. Does NOT bundle scoring-function changes.

---

## §1 — Per-ticker score distribution + threshold position

Source: `ct_scored_flow` (the table `loadCandidateEvents` reads from, per `_shared/specialistRunner.ts:626-633`). Filter: `event_ts >= now() - 5 days`, ticker IN the 10-watchlist.

Trailing 5-day distribution + current threshold + (`thr − p75`) drift metric:

| Ticker | n_5d | p25 | p50 | p75 | p90 | p95 | curr_thr | **thr − p75** | health |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **NVDA** | 546 | 30.0 | 42.0 | 52.0 | 57.0 | 62.0 | **55** | **+3.0** | drift trouble (post-1A) |
| **MSFT** | 147 | 32.5 | 42.5 | 57.5 | 62.5 | 67.5 | **60** | **+2.5** | drift trouble |
| QQQ | 970 | 40.0 | 55.0 | 60.0 | 65.0 | 70.0 | 65 | +5.0 | edge — watch |
| **AAPL** | 320 | 36.5 | 50.0 | 60.0 | 67.5 | 70.0 | **60** | **0.0** | edge — drift trouble |
| **SPY** | 1109 | 45.0 | 55.0 | 65.0 | 70.0 | 75.0 | 65 | 0.0 | edge — but huge n |
| META | 162 | 42.5 | 52.5 | 64.0 | 70.0 | 72.5 | 60 | -4.0 | healthy |
| AMZN | 229 | 45.0 | 57.5 | 65.0 | 72.0 | 76.2 | 60 | -5.0 | healthy |
| GOOGL | 172 | 47.0 | 57.5 | 65.0 | 72.5 | 75.0 | 60 | -5.0 | healthy |
| TSLA | 783 | 45.0 | 55.0 | 65.0 | 70.0 | 75.0 | 55 | -10.0 | very healthy |
| IWM | 237 | 45.0 | 60.0 | 67.5 | 72.5 | 80.0 | 55 | -12.5 | very healthy |

Interpretation key: `thr − p75 < 0` means more than the top 25% of events
clear the gate — ample fire rate. `thr − p75 ≈ 0` means precisely the top
25% clear. `thr − p75 > 0` means fewer than the top 25% clear, and the
specialist depends on tail spikes.

### Cross-reference with D1's no_events rates (5 known-affected)

D1's per-specialist no_events rates over 4 trading days mapped to the
position above:

| Ticker | D1 no_events rate | thr − p75 | Read |
|---|---|---:|---|
| NVDA | very high (silent 4.5d) | +3.0 | confirmed; 1A in flight |
| MSFT | very high (1 read in 4d) | +2.5 | confirmed; needs D2 |
| AAPL | elevated | 0.0 | edge; AAPL's pct_init halved (30.8→13.4); needs D2 |
| GOOGL | elevated (D1 brief) | -5.0 | RESOLVED before D2 — distribution recovered |
| AMZN | elevated (D1 brief) | -5.0 | RESOLVED before D2 — distribution recovered |
| META | elevated (D1 brief) | -4.0 | RESOLVED before D2 — distribution recovered |

Two surprises here:

- **GOOGL/AMZN/META are now HEALTHY** vs D1's framing of them as affected.
  Either the regime softened on those names in the last 24-48h, or D1's
  no_events framing was inflated by other failures (parse fails, the
  silent-failure class that v1.1 just instrumented). `evs_considered`
  values in §1's wakeup_log show GOOGL hitting 3, AMZN hitting 2, META
  hitting 1 — they ARE seeing events. They just are not at the same
  drought level as NVDA/MSFT/AAPL.
- **AAPL has slid into edge territory.** It was not flagged as a primary
  D1 worry but `pct_init` halving 30.8→13.4 + p75 dropping 60→57.5 makes
  it a clean D2 candidate.

### Cross-reference with the 5 currently-OK (preemptive scan)

| Ticker | thr − p75 | p75 trend pre→post | Preemptive lower? |
|---|---:|---|---|
| TSLA | -10.0 | flat (65→65) | NO — comfortable |
| IWM | -12.5 | up (67.5→70) | NO — comfortable |
| QQQ | +5.0 | flat (60→60) | **WATCH** — +5 is the canary, but distribution is huge (n=970, ge_60=317) so it's fine in absolute terms |
| SPY | 0.0 | up (60→65) | NO — n=1109, ge_65=296, vast pool |
| GOOGL/AMZN/META | -4 to -5 | small drift | NO — comfortable |

**No pre-emptive lowering recommended.** QQQ deserves a watch line in the
warden invariant (`thr - p75 > 5` would alert) but its absolute fire pool
is fine.

---

## §2 — Per-ticker threshold problem vs scoring-function calibration problem

The brief's premise was that per-ticker threshold tuning is the right
lever. To verify or refute, the discriminating test is:

> **Did the score distribution shift CONSISTENTLY across all 10 tickers
> (suggests a scoring-function shift), or VARIABLY per ticker (suggests
> regime-driven on specific names)?**

### Empirical answer — VARIABLY per ticker (clear signal)

Comparison: pre-drift era (Apr 27 → May 1, 5 days) vs post-drift era (May 4+, 1.5 days):

| Ticker | p75 pre | p75 post | Δ p75 | pct_init pre | pct_init post | Δ pct_init |
|---|---:|---:|---:|---:|---:|---:|
| AAPL | 60.0 | 57.5 | -2.5 | 30.8 | 13.4 | **-17.4pp** |
| **MSFT** | 67.5 | **53.0** | **-14.5** | 21.3 | 22.5 | +1.2 |
| NVDA | 52.5 | 50.0 | -2.5 | 32.3 | **17.3** | **-15.0pp** |
| AMZN | 67.0 | 65.0 | -2.0 | 22.4 | 39.5 | **+17.1pp** |
| META | 70.0 | 67.0 | -3.0 | 26.4 | 29.7 | +3.3 |
| GOOGL | 65.0 | 65.0 | 0.0 | 38.0 | 39.0 | +1.0 |
| TSLA | 65.0 | 65.0 | 0.0 | 59.1 | 50.5 | -8.6 |
| QQQ | 60.0 | 60.0 | 0.0 | 56.6 | 57.5 | +0.9 |
| SPY | 60.0 | 65.0 | +5.0 | 66.1 | 61.2 | -4.9 |
| IWM | 67.5 | 70.0 | +2.5 | 25.2 | 33.3 | +8.1 |

If this were a scoring-function shift, every ticker's p75 would have
moved in the same direction. Instead p75 moved DOWN for AAPL/MSFT/NVDA,
flat for QQQ/GOOGL/META/AMZN/TSLA, and UP for SPY/IWM. **Consistent with
regime-driven per-name microstructure shifts**, not formula change.

### Confirming negative — scoring code untouched

`git log --since='2026-04-25' supabase/migrations/*scor*.sql supabase/migrations/*classif*.sql` — last touch on `ct_score_flow_event` is `20260424000038_scorer_context_columns.sql` on **2026-04-24** (per D1 H2 finding, re-verified). All migrations after 04-25 are in unrelated areas (heatmap RPCs, pulse v2 schemas, warden, flag-grader). Nothing alters scoring math.

`git log --since='2026-04-25' supabase/functions/_shared/{specialistRunner,signatureMemory,attentionScore}.ts` — only `5ad7127` (today's v1.1 instrumentation), `f36da46` (recall extension), `afbcfd7` (recall property landing), `dc52add` (Phase 4 brain migration). No scoring math touched.

### Why the per-ticker variance — ticker microstructure is the driver

The 04-30 vs 05-05 NVDA `score_breakdown` decomposition in the prior NVDA audit identified the decisive 10-pt delta as the `volume > open_interest` factor in `opening_buy`:

```
opening_buy = +10 if ask_side_perc >= threshold (61% gate)
            + 10 if volume > open_interest          ← THIS is the swing
            + 2.5 if not multileg
            + 2.5 if not floor
```

The §1-table column `pct_init` measures exactly this factor. NVDA dropped
from 32% to 17% — so half of NVDA's flow lost 10pts in the `opening_buy`
factor between regimes. AAPL dropped from 31% to 13% — same shape. MSFT
held near-flat at ~22% but its raw scores dropped 14.5pts at p75 anyway,
suggesting the ask-side-perc gate also moved or the regime/stacking
context contribution flipped sign — but the formula is unchanged. **The
inputs shifted, the math did not.**

### Verdict — D2 IS the right lever

Evidence favors per-ticker threshold tuning. A scoring-function fix
(D3-shape) would require evidence that the formula itself misweights a
factor; the per-ticker variance refutes that. **A scoring-function
recalibration would actively HARM the tickers that are already healthy
(TSLA, IWM, AMZN, GOOGL, META).**

D3 is queued as a separate question in §6: not a fix for this drift, but
a longer-running corpus-level question about whether the formula
continues to discriminate well across regimes.

---

## §3 — Recommended threshold deltas per ticker

### Method

Goal: produce a `thr − p75` of **roughly −5pts** for each specialist —
enough headroom that ordinary regime variance doesn't strand the
specialist, but not so low that fire rate explodes and erodes Tenet 3
trust-per-alarm.

Constraint: respect each ticker's `min_value=40` floor in `ct_config`.
None of the recommendations approach the floor.

Sanity floor from Thesis tier (the implicit "Mag7 = 60, index = 65, meme
= 55" tier in the existing config): only loosen one tier at a time. NVDA
already crossed Mag7→meme (60→55) per the 1A stopgap. AAPL/MSFT need a
tier review or stay-in-Mag7-but-at-floor decision.

### Per-ticker recommendations

| Ticker | curr_thr | p75 | thr − p75 (now) | recommended | new thr − p75 | rationale |
|---|---:|---:|---:|---:|---:|---|
| **NVDA** | **55** | 52.0 | +3.0 | **50** | -2.0 | 1A took it to 55; recommend going further to 50 to give -2 to -5 buffer. p90=57, so fires would still require top-10% scores. ge_50 count over 5d = 192. ge_55 = 95. Lowering to 50 doubles event pool. (alternate: stay at 55 + accept high sensitivity) |
| **MSFT** | **60** | 57.5 | +2.5 | **55** | -2.5 | ge_55 = 49 over 5d = 10/day, plenty for the 8 RTH wakeups. ge_60 = 30 over 5d = 6/day, marginal. Move from Mag7 tier to meme tier (matches 1A logic for NVDA). |
| **AAPL** | **60** | 60.0 | 0.0 | **55** | -5.0 | AAPL's pct_init halved from 30.8 to 13.4 — same shape as NVDA. ge_55 = 138 vs ge_60 = 99 — net +40 events with 5pt loosen. The Mag7 tier is no longer the right group for AAPL in this regime; loosening to 55 brings it in line with the new NVDA floor. |
| QQQ | 65 | 60.0 | +5.0 | **leave 65** | +5.0 | n=970 over 5d, ge_65=192, ge_60=317. Plenty of fires. The +5 is canary territory but absolute fire pool is fine. Warden invariant will catch if it drifts further. |
| SPY | 65 | 65.0 | 0.0 | **leave 65** | 0.0 | n=1109 over 5d, ge_65=296. ge_70=187. Largest event pool of any ticker; despite being at-edge on p75, absolute fire rate is huge. |
| META | 60 | 64.0 | -4.0 | **leave 60** | -4.0 | ge_60=53 over 5d = ~10/day, healthy. |
| AMZN | 60 | 65.0 | -5.0 | **leave 60** | -5.0 | ge_60=97 over 5d = ~20/day, very healthy. |
| GOOGL | 60 | 65.0 | -5.0 | **leave 60** | -5.0 | ge_60=77 over 5d = ~15/day, healthy. |
| TSLA | 55 | 65.0 | -10.0 | **leave 55** | -10.0 | ge_55=430 = ~85/day, very high — could risk Tenet 3 erosion if anything; consider RAISING in a separate D-future, but not now. |
| IWM | 55 | 67.5 | -12.5 | **leave 55** | -12.5 | ge_55=141 = ~28/day, comfortable. Same Tenet-3-erosion question as TSLA. |

### Expected fire rate post-change

For the 3 changed tickers, "expected daily fires that clear new
threshold" using the trailing 5-day pool ÷ 5:

| Ticker | curr daily clears | recommended daily clears | delta |
|---|---:|---:|---:|
| NVDA | ge_55 = 19/day (post-1A) | ge_50 = 38/day | **+19/day** (×2) |
| MSFT | ge_60 = 6/day | ge_55 = 10/day | +4/day (×1.7) |
| AAPL | ge_60 = 20/day | ge_55 = 28/day | +8/day (×1.4) |

Note: these are *eligible events*, not *expected wakeup-window catches*.
With 8 RTH wakeups on a 30-min sliding window, only a fraction lands
inside an open window. Per the prior NVDA audit's per-window analysis,
the score-race + window-edge bleed roughly halves the catch rate.
Realistic expected daily reads-with-events post-change: NVDA ~6-10,
MSFT ~3-5, AAPL ~5-8. Compared to the current floor of 0-1/day for
NVDA/MSFT, this is the right step-change.

### Sanity cross-check — would NVDA at threshold 50 produce a "voodoo" fire rate?

NVDA `ct_scored_flow` last 5 days: ge_50 = 192. Over 8 RTH wakeups × 5
trading days = 40 wakeup windows. With score-race halving the catch rate
(≈ 96 catches across 40 windows), NVDA would average **2.4 events per
wakeup**. The specialist sees up to 15 (LIMIT 15 in `loadCandidateEvents`)
and decides whether to flag. A 30-min wakeup with 2-3 mid-tier events is
exactly the operating point Tenet 3 wants — enough to read regime
without firing on every print.

If the post-change fire rate climbs above ~5 flags/day on NVDA (vs
current 1/day), the trust-per-alarm metric should be re-examined and the
threshold raised back to 52-53 in a follow-up.

---

## §4 — Whether scoring-function tuning would be more structural

### The question

If we ship D2 (per-ticker threshold tuning) + warden invariant ("trailing
5-day p75 within 5pts of wakeup_threshold"), does the next regime drift
trigger another threshold-patch cycle, or is the regime-drift class
killed?

### Analysis

**The warden invariant transforms the failure mode**, not the failure.
Without the warden, regime drift produces silent specialist starvation
that takes 4 days to notice (the NVDA case). With the warden, regime
drift produces a Slack alert within a 30-min window of the p75
crossing into the danger zone.

**Threshold tuning + warden = deterministic loop:**

1. Regime drifts → p75 moves
2. Warden fires when `p75 + 5 > wakeup_threshold` for ticker X
3. Operator (or future automation) lowers threshold for X by 5
4. Loop

This is a reactive loop. Structural class kill would mean: the threshold
moves *automatically* with the rolling p75 (or some derived metric) —
the specialist self-tunes its gate to the regime. That's a meaningful
structural extension and is what a Tenet 25 reading would push toward
("evolves in STRUCTURE, not just within structure").

**But shipping that auto-tune requires:**

- Cron/RPC that recomputes per-ticker `wakeup_threshold` from rolling
  p75 + safety margin nightly
- Guardrails (don't move > 5pts/night, respect min_value, audit log)
- Trust signal — does the specialist's hit-rate hold up at the
  auto-tuned threshold? Need 14-day specialist scoreboard data BEFORE
  letting the auto-tuner change the gate.

**Right answer:** D2 (manual threshold tune for the 3 affected) +
preventive warden invariant is the correct ship-NOW structural fix.
**Auto-tune is a follow-up** that depends on (a) the warden invariant
proving reliable for a few weeks, (b) specialist scoreboard hit-rate
data backing each threshold's "trust radius," and (c) an explicit
James decision to give the specialists self-tuning authority.

The auto-tune extension is a separate brief — call it D2.5 or a lifecycle
extension under detector lifecycle thinking — and should not be bundled.

### Verdict on §4

**D2 + warden invariant IS the structural fix for this class.** It
converts a 4-day silent failure into a 30-min observable failure, and
it gives operators a deterministic playbook for handling future drift.
That meets Tenet 15 ("does this class become impossible going
forward"): the silent-starvation class becomes IMPOSSIBLE because the
warden alarm fires before specialists go silent.

A future auto-tune extension could make the *threshold-patch cycle*
itself class-killed, but that's a separate decision tree and is NOT
required for the immediate ship.

---

## §5 — Phase B implementation shape (D2 + preventive warden)

### Step 1 — three per-ticker UPDATEs

```sql
-- Lower NVDA further (1A took it to 55; D2 takes it to 50 to give -2 to -5 buffer)
UPDATE public.ct_config
   SET value = 50, updated_at = now()
 WHERE key = 'specialist.NVDA.wakeup_threshold' AND value = 55;

-- MSFT 60 → 55 (matches 1A logic for NVDA — Mag7 tier → meme tier in this regime)
UPDATE public.ct_config
   SET value = 55, updated_at = now()
 WHERE key = 'specialist.MSFT.wakeup_threshold' AND value = 60;

-- AAPL 60 → 55 (same regime-shift signature as NVDA; pct_init halved)
UPDATE public.ct_config
   SET value = 55, updated_at = now()
 WHERE key = 'specialist.AAPL.wakeup_threshold' AND value = 55;
```

Post-update: log via `feedback_co_trader_*` memory or a `docs/decisions/`
note explaining tier reassignment + the regime-drift evidence.

### Step 2 — preventive warden invariant

Conceptual SELECT (NOT shipped here; James to approve shape and threshold):

```sql
-- Invariant: any specialist's trailing-5d p75 within 5pts of its wakeup_threshold
WITH stats AS (
  SELECT ticker,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY score)::numeric AS p75
    FROM ct_scored_flow
   WHERE event_ts >= now() - interval '5 days'
     AND ticker IN ('NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM')
   GROUP BY ticker
), thr AS (
  SELECT split_part(key, '.', 2) AS ticker, value::numeric AS thr
    FROM ct_config
   WHERE key LIKE 'specialist.%.wakeup_threshold'
), drift AS (
  SELECT s.ticker, s.p75, t.thr, (t.thr - s.p75)::numeric AS gap
    FROM stats s JOIN thr t ON t.ticker = s.ticker
   WHERE (t.thr - s.p75) > -5  -- alert when gap is shrinking past safety
)
SELECT count(*)::numeric AS metric_value,
       string_agg(ticker || ':gap=' || gap::text, ', ') AS message
  FROM drift;
```

- `expected_max = 0` — any ticker in the danger zone fires the invariant.
- `severity = 'warn'` — Slack on first cross + on recovery.
- `runbook_path = 'docs/runbooks/specialist_threshold_drift.md'` (to be written; brief shape: read §3 of THIS audit, decide whether to lower or accept).

### Step 3 — telemetry for verification

For 2-3 trading days post-deploy (so 2026-05-06 + 2026-05-07 + 2026-05-08
RTH), capture per specialist:

- daily count of `ct_specialist_reads` rows (proxy for productive wakeups)
- daily count of flagged reads
- daily count of `ct_specialist_wakeup_log.skip_reason='no_events'`
- per-flag hit-rate joining `ct_flag_grades` if available within window
  (likely too short for grade settlement; use as input to the
  longer-running scoreboard instead)

A simple 3-day delta query in the morning ops checklist suffices. No
new instrumentation needed — the wakeup_log + reads tables already carry
everything.

### Step 4 — verification gates (don't auto-approve)

- **D+0 (deploy day):** verify the 3 UPDATEs took (ct_config read).
  Verify next NVDA, MSFT, AAPL wakeups produce non-zero
  `events_considered` counts in `ct_specialist_wakeup_log`.
- **D+1 RTH:** verify reads-per-day goal: NVDA ≥ 6 reads, MSFT ≥ 4,
  AAPL ≥ 6. If any specialist still has 0 reads, escalate (suggests a
  different failure mode — parse fail, cron disabled, etc).
- **D+3 RTH:** verify warden invariant fires correctly for any ticker
  whose p75 has crossed back into the danger zone. If invariant doesn't
  fire when you'd expect it to, debug threshold logic before relying on
  it.

### Step 5 — what NOT to do in Phase B

- **Do NOT change scoring math.** §2 ruled it out. Touching the formula
  would re-distort tickers that are now healthy.
- **Do NOT widen `CANDIDATE_WINDOW_MIN`.** That was Option 1B in the
  prior audit; D1 was a downstream form of the same idea (`scored_at`
  filter). Empirically only catches ~10% of failures. Not a fix.
- **Do NOT auto-tune yet.** Belongs in a separate brief once warden
  invariant has a few weeks of behavior history.
- **Do NOT move thresholds for the 7 healthy tickers** "just to be
  consistent." Tenet 16 — every number tunable, but only when there's
  evidence to move it.
- **Do NOT bundle D3 (scoring recalibration) into D2.** §6 explains why.

---

## §6 — Should D3 (scoring-function recalibration) be queued separately?

### The structural question D3 would answer

"Does `ct_score_flow_event`'s factor weighting (opening_buy 25 / t1_oi 15 / single_direction 15 / iv_context 5 / context ±15) continue to discriminate well across regimes, or does it under-weight a class of signal that would discriminate in a 'mostly existing-position' regime?"

### Why it's NOT bundled into D2

- §2's empirical signature refutes the simple version of the
  scoring-recalibration hypothesis. Per-ticker variance is too large
  for a single re-weighting to fix all tickers at once.
- D3-shape work is corpus-level analysis (compare detector hit-rates by
  factor weight under different regime slices). This is the kind of
  Sunday-calibration work referenced in Tenet 19, NOT a Tuesday RTH
  ship.
- Bundling D3 risks shipping a re-weighted formula whose effects James
  cannot disentangle from the threshold tuning (the captain calibration
  problem — "did the threshold change help or did the formula change?").
- The morning of 2026-05-06 wants an unambiguous read: did the threshold
  tune restore specialist productivity for NVDA/MSFT/AAPL? Bundling
  obscures that read.

### D3 brief shape (separate Phase A)

**Question:** "Does the current scoring formula's factor weighting
discriminate hit-rate across regimes, and if not, what re-weighting (or
factor addition) would?"

**Method (Phase A only):**

- Pull the canonical corpus (`ct_flag_analysis_corpus` + `ct_flag_grades`)
- Slice by regime (chop / trend up / trend down / chop_neutral)
- For each scoring factor, compute hit-rate of flags above vs below
  median value of that factor *within the slice*
- Surface the factors whose hit-rate discrimination is weakest in the
  "mostly existing-position" regime (likely: opening_buy will look
  weaker, t1_oi might look stronger)
- Output: a re-weighting recommendation with quantified hit-rate uplift
  per regime

**Phase B (only if Phase A finds clear signal):** propose a re-weighted
scoring formula migration; backtest via `ct-backtest-harness` (Tenet 19);
ship in a Sunday calibration window, NOT mid-week.

**Suggested timeline:** D3 Phase A is a 4-8 hour analysis-mode session.
Schedule for next Sunday (Tenet 19 calibration cadence). DO NOT bundle.

---

## §7 — Surfaced trade-offs requiring James's call before Phase B

### Trade-off 1 — NVDA 55 → 50, or stay at 55?

The 1A patch took NVDA to 55. D2 §3 recommends going further to 50 for a
clean -2 to -5 buffer. Two readings:

- **Aggressive (recommended):** 55 → 50. Doubles event pool; gets
  reads-per-day from 1 to ~6. Makes it impossible for NVDA to silently
  starve again UNLESS p75 drops below 45 (currently 52).
- **Conservative:** stay at 55. The 1A patch already 5x'd available
  events; let one trading day pass to see if specialist productivity
  recovers without going further. Risk: another flat regime day produces
  another silent stretch.

Recommendation: **aggressive.** The hit-rate downside is small (specialist
just reads more, doesn't flag more — the conviction gate inside the
Claude prompt remains). The fire-rate downside is bounded by the
specialist's daily-flags cap and cooldown (DEFAULT_COOLDOWN_MIN=15,
DEFAULT_MAX_FLAGS_PER_DAY=10).

### Trade-off 2 — MSFT/AAPL: lower or wait for more data?

Both are at the edge but NOT silently starving. MSFT has 1 read in the
last 24h; AAPL has 5. The 1A logic was "patch only when class freezing
forces it" — MSFT is borderline frozen (1 read), AAPL isn't.

- **Lower both now (recommended):** matches the regime-drift evidence
  and gives both specialists -5 buffer.
- **Wait on AAPL:** if AAPL is still producing reads, maybe the regime
  shift hasn't bitten it yet. Wait a day, re-measure.
- **Lower only MSFT:** smaller blast radius; AAPL gets warden coverage
  if drift continues.

Recommendation: **lower both now.** The evidence is empirically clean
(pct_init halved on AAPL, same as NVDA) and waiting just delays the
inevitable.

### Trade-off 3 — Should min_value (currently 40 for all) be lowered for any ticker?

No. None of the recommended thresholds approach 40. The min_value floor
exists to prevent runaway threshold collapse during persistent regime
drought; it's a safety, not a target. Don't touch.

### Trade-off 4 — Ship preventive warden invariant in D2 Phase B, or queue separately?

- **Bundle into D2 Phase B (recommended):** the warden invariant + the
  threshold UPDATEs are the SAME structural fix. Without the warden,
  this whole audit becomes a recurring patch cycle. With the warden,
  the class is killed (per §4 reasoning).
- **Queue separately:** smaller blast radius. But shipping the threshold
  UPDATEs without the warden means we're back here in a few weeks when
  the next regime shift bites a different specialist.

Recommendation: **bundle.** The warden invariant is single-file (one
INSERT into `ct_invariants` per Tenet 25), no edge function deploy
required, and is the structural lever that makes D2 a class-kill not a
patch.

### Trade-off 5 — What if Phase B verification (D+1) shows 0 reads for any specialist?

That signals a DIFFERENT failure mode (not threshold drift). Likely
suspects: parse_fail (Claude returned malformed JSON), cron disabled,
specialist process throwing inside Claude call. Don't re-tune the
threshold further; debug the specialist-runtime layer. The wakeup_log's
new `claude_output_preview` + `parse_ok` columns (commit `5ad7127`) are
the right tool.

### Trade-off 6 — Tier reassignment: are NVDA/AAPL/MSFT moving to "meme tier" permanent or regime-only?

The implicit tier (Mag7=60, index=65, meme=55) is now broken: NVDA at
50, AAPL/MSFT at 55. This is fine if treated as **regime-conditional
tier**, NOT a permanent reassignment. The warden invariant + a future
auto-tune extension would let the tier float with the regime.

Recommendation: document in the decisions note that tiers are now
empirically calibrated per-ticker, not by name-class. The "Mag7 club"
naming is informal and shouldn't constrain tuning.

---

## Closing — what good looks like by Wednesday morning

After Phase B ships:

- NVDA next 8 RTH wakeups produce ≥ 4 reads (vs current 0)
- MSFT next 8 RTH wakeups produce ≥ 3 reads (vs current 1)
- AAPL next 8 RTH wakeups produce ≥ 5 reads (vs current 5; should hold)
- The warden invariant `specialist_threshold_within_5pts_of_p75` shows
  GREEN for all 10 specialists (or fires immediately for any ticker we
  missed)
- `feedback_silent_failure_detection_pattern.md` gets a new instance
  noting "score-distribution drift is now an active probe, not a passive
  row-count check"
- `feedback_warden_threshold_calibration.md` is updated to note the new
  invariant + recommended threshold scan cadence

The class kill statement: **"Specialist silent starvation due to
regime-driven score distribution drift is now structurally impossible
within a 30-min observation window."**
