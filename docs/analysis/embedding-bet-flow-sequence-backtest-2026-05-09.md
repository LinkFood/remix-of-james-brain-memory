# Embedding-Bet Backtest — Flow-Sequence Cosine vs Forward-Outcome

**Run:** 2026-05-09 evening · **Mode:** Analysis (Tenet 26) · **Substrate:** ct_flow_alerts (30,671 rows over 4/24 → 5/9 watchlist) · **A/B vs prose test:** same 644-row subset (after empty-window drop), same SPY-1h forward outcome

## TL;DR

**Standalone: weaker than prose. Stacked with prose: best result of either axis alone.**

- Tier 1 standalone: **Pearson r = −0.060** (p < 1e-135), **Spearman ρ = −0.069** (p < 1e-183) on n=172,696 cross-session pairs. **Smaller Pearson than prose** (prose was −0.078); Spearman roughly comparable.
- Decile curve **wobbles D1–D5** then trends monotone D5→D9, plateaus D9–D10. Top-vs-bottom ratio D10/D1 = **0.85** (vs prose 0.82). Less clean monotonic shape than prose.
- **Tier 2 trader-level read FAILS as standalone:** top-10 high-flow-cos pairs have **2.59× WORSE** mean forward-outcome delta than baseline (0.468% vs 0.181%). Magnitude-bias contamination — high cosine concentrates on "busy session opens" (dense 0DTE + ATM + sweeps) rather than "same algo playbook."
- **Cross-axis stacking validates the multi-axis hypothesis empirically:** pairs where BOTH prose-cos AND flow-cos exceed median show **15.2% smaller forward-outcome delta** than pairs where both are low (HH=0.001666 vs LL=0.001964). Flow adds incremental signal *over prose*: HH < HL (prose-alone-high) by ~9%, and HH < LH (flow-alone-high) by ~6%.
- **Captain's instrument-mismatch hypothesis: confirmed in a stronger form.** Flow-sequence does NOT capture the algo-footprint axis as a standalone instrument — bag-of-features at 30-min lookback is too coarse. But it carries *complementary* signal that compounds with prose. The multi-axis analog book is empirically real; pure flow-cosine alone is not the next instrument.

## Phase A — Substrate Verification

### S1. ct_flow_alerts cadence + density

| Metric | Value |
|---|---|
| Rows in 4/24 → 5/9 watchlist | **30,671** |
| RTH peak density (e.g. 5/8 13:30–15:30 UTC) | ~470 alerts/hour |
| Per-ticker top-3 (NVDA / SPY / QQQ) | 3,449 / 4,220 / 3,843 |
| `executed_at` populated | **0/200 sample → use `raw.created_at`** (cf. memory `ct_flow_alerts_executed_at_null`) |
| `is_otm` populated | **0/200 sample → derive from strike vs `raw.underlying_price`** |
| `raw.alert_rule` distribution (n=200, 5/8) | RepeatedHits 109 / RepeatedHitsAscending 54 / RepeatedHitsDescending 37 — **all RepeatedHits family** |
| Direction inference for RepeatedHits* | per memory `uw_repeatedhits_direction`: trust `side=call` → bullish, `side=put` → bearish (premium-side inverts on cheap OTM/0DTE call accumulation) |

**Substrate retargets vs brief assumption** (write-time check 1 + 4):
- Brief named `is_ask, is_repeat, alert_type` as candidate fields. Actual: `is_ask` and `is_bid` columns exist but are NULL on the recent sample; `alert_type` mirrors `side`. Direction signal lives in `raw.total_ask_side_prem` / `raw.total_bid_side_prem`, but the RepeatedHits-inversion gotcha makes premium-side unreliable for the 99% RepeatedHits flow. Used `side` directly.
- Time field: brief said pick a timestamp column; chose `raw.created_at` (UW print time) over `ingested_at` (DB insert time) per the time-window memory.

### S2. Vectorization shape (engine-room judgment per brief)

Picked **bag-of-features over a 30-min lookback window pre-commentary, market-wide aggregate over the 10-ticker watchlist** — simplest tractable per brief.

24-dimensional fixed-dim vector:

| Bucket | Features | Count |
|---|---|---:|
| Direction | `call_count`, `put_count`, `call_premium_log`, `put_premium_log` | 4 |
| Aggression | `sweep_count`, `sweep_premium_log`, `multileg_count`, `opening_trade_count` | 4 |
| Moneyness (ATM ±2% of underlying) | `atm_call_count`, `atm_put_count`, `otm_call_count`, `otm_put_count` | 4 |
| Expiry | `dte_0_count` (≤24h), `dte_short` (≤7d), `dte_mid` (≤30d), `dte_long` | 4 |
| Conviction | `mean_voi`, `max_premium_log`, `total_premium_log`, `mean_trade_count` | 4 |
| Concentration | `top1_ticker_share`, `top3_ticker_share`, `total_alerts`, `ticker_diversity` | 4 |

Per-dim z-score before unit-normalize, else high-magnitude features (e.g. `total_alerts` raw count) dominate cosine.

### S3. Coverage

- **Same 704 commentary timestamps** as prose test (mirror-population for clean A/B).
- 60 timestamps had **empty 30-min lookback windows** (mostly weekend / late-after-hours commentaries with no flow alerts in window) → dropped. **Final N = 644.**
- Window sizes: median 118 alerts in lookback, p25=80, p75=152, max=384.
- Pairs >24h apart: 172,696 (vs prose 206,650; smaller because of the 60-row drop).

## Tier 1 — Decile-Binned Correlation (>24h apart)

| Decile | Cosine range | N pairs | mean \|Δret\| | median \|Δret\| |
|---|---|---:|---:|---:|
| D1 | [−0.9343, −0.5824] | 17,269 | 0.001950 | 0.001655 |
| D2 | [−0.5824, −0.3893] | 17,270 | 0.001860 | 0.001462 |
| D3 | [−0.3893, −0.2413] | 17,270 | 0.001876 | 0.001479 |
| D4 | [−0.2413, −0.1178] | 17,268 | 0.001875 | 0.001444 |
| D5 | [−0.1178, −0.0101] | 17,271 | 0.001924 | 0.001420 |
| D6 | [−0.0101, 0.1020] | 17,268 | 0.001774 | 0.001361 |
| D7 | [0.1020, 0.2308] | 17,269 | 0.001784 | 0.001343 |
| D8 | [0.2308, 0.3833] | 17,271 | 0.001727 | 0.001308 |
| **D9** | **[0.3833, 0.5688]** | **17,268** | **0.001638** | **0.001268** |
| D10 | [0.5688, 0.9688] | 17,272 | 0.001655 | 0.001305 |

- **Pearson r (cosine, |Δret|): −0.060** (p ≈ 1e-135)
- **Spearman ρ: −0.069** (p ≈ 1e-183)
- **D10 / D1 ratio: 0.85** (top-decile pairs show 15% smaller forward-outcome delta than bottom decile)

### Decile shape diagnosis

- D1–D5 wobble around 0.0019 (no clean monotone). The negative-cosine half of the distribution is information-poor — flow vectors with negative cosine are mostly orthogonal-noise pairings, not informative anti-similarity.
- D5 → D9 monotone descent ✓
- **D9–D10 plateau** (cf. cascade `embedding-validation-saturation-at-high-cosine` from prose test) — same shape signature as prose, but with a less informative left tail.
- Compared to prose: prose curve was monotone D1→D8 then plateau D8–D10. Flow-sequence is monotone only over the *positive-cosine* half, with noise dominating the negative-cosine half. **The instrument extracts less standalone signal than prose, on this metric.**

## Tier 2 — Top-10 Cross-Session High-Cosine Pairs

| # | Cos | Δt | A → B (16-char ts) | Forward 1h | Top shared features |
|---|---|---|---|---|---|
| 1 | 0.9688 | 7.0d | 04-24T13:50 → 05-01T14:20 | A +0.139% / B −0.195% / **\|Δ\| 0.334%** | dte_0, atm_call, sweep |
| 2 | 0.9687 | 7.0d | 04-24T14:00 → 05-01T14:20 | A +0.259% / B −0.195% / **\|Δ\| 0.454%** | dte_0, atm_call, sweep |
| 3 | 0.9687 | 7.0d | 04-24T14:00 → 05-01T14:20 | A +0.289% / B −0.195% / **\|Δ\| 0.484%** | dte_0, atm_call, sweep |
| 4 | 0.9685 | 7.0d | 04-24T14:00 → 05-01T14:10 | A +0.259% / B −0.213% / **\|Δ\| 0.472%** | dte_0, dte_mid, atm_call |
| 5–10 | ≥0.9674 | 7.0d | (all 04-24T14:00–14:01 → 05-01T14:06–14:20) | mean \|Δ\| ≈ 0.485% | dte_0, atm_call, sweep |

### Trader-level read

**The top-10 is contaminated by magnitude bias, not signal.** Every pair has the same shape:
- Same calendar offset (Friday 04-24 ↔ Friday 05-01, 7d apart)
- Same intraday slot (~14:00–14:20 UTC = ~10:00–10:20 ET, post-open volume spike)
- Same dominant features: 0DTE call concentration + ATM-call clusters + sweep activity

This is the **"busy session-open" cluster** — flow density at market-open is structurally similar across sessions regardless of which way the tape ends up going. The two days show *opposite* market tides (A=bearish/19 VIX, B=bullish/16.6 VIX), and the **forward outcomes diverge accordingly**.

**Captain's gut-check question — "does this feel like the same algo playbook?":** No. It feels like "two different mornings where the post-open desk was working." Bag-of-features doesn't distinguish a high-volume bullish open from a high-volume bearish open well enough on these 24 dims, because aggregate counts of `atm_call` + `0dte` + `sweep` look identical when the flow is *mechanically active* even if the *directional intent* differs.

**Top-10 vs baseline:** mean |Δret| 0.468% vs 0.181% baseline = **2.59× WORSE** than average pair. Top-50: 0.306% (1.69× worse). Top-100: 0.255% (1.41× worse). The Tier 1 negative correlation is being pulled by the bulk of mid-cosine pairs, not the high tail — exactly inverse of where the prose test's signal lived.

## Cross-Axis Stacking — prose-cos × flow-cos

Same 644-commentary subset, both axes computed, paired across the same 24h-filtered pair set.

Median splits:
- prose-cos median = 0.7908, p75 = 0.8178
- flow-cos median = −0.0101, p75 = 0.3035

| Quadrant | N | mean \|Δret\| | median \|Δret\| |
|---|---:|---:|---:|
| **HH** (prose ≥ med AND flow ≥ med) | 44,050 | **0.001666** | 0.001306 |
| LH (prose < med, flow ≥ med) | 42,298 | 0.001767 | 0.001327 |
| HL (prose ≥ med, flow < med) | 42,298 | 0.001827 | 0.001460 |
| LL (prose < med, flow < med) | 44,050 | 0.001964 | 0.001515 |
| HH75 (both ≥ p75) | 11,782 | 0.001646 | 0.001325 |

### Read

- **HH outperforms LL by 15.2%** (mean |Δret| ratio 0.85). Same magnitude as the prose-only top-vs-bottom ratio — but it stacks the *bottom* against the *top of both axes simultaneously*.
- **HH < HL by ~9%** → flow contributes incremental signal *on top of prose*. Pairs that prose says are similar AND flow says are similar diverge less than pairs where only prose says similar.
- **HH < LH by ~6%** → prose contributes more incremental signal than flow, but flow adds non-trivially.
- HH75 (both at p75) = 0.001646, barely different from HH-via-median. Diminishing returns past the median split — **no need to set the bar at p75 to capture the stack benefit.**
- **Multi-axis ceiling validated empirically.** Two coarse vectors stacked beat either alone. The path forward is: more axes (GEX, strike-concentration), each individually weak, stacked stronger.

## Honest Reading

**Validates: partial, with a structural twist.**

The brief framed two outcomes worth distinguishing:
1. *"Flow captures algo-footprint signal that prose misses."* → **NOT validated as a standalone axis.** Bag-of-features over 30-min lookback is too coarse to capture algo-footprints. Top-of-distribution flow-cos pairs are dominated by session-rhythm artifacts (open-volume bursts), not algo-playbook similarity. A higher-resolution sequence-aware model (LSTM/transformer over time-ordered ticks) might extract this — out of analysis-mode scope today.
2. *"Multi-axis stacking compounds signal."* → **VALIDATED.** HH < LL by 15.2%, HH < HL by 9%, HH < LH by 6%. Flow carries complementary signal even though it's the weaker axis standalone.

The instrument-mismatch hypothesis from the prose test was: prose can't capture every axis, so build more axes. This run **strengthens** that finding by showing a coarse second axis already compounds. The expected ceiling lift from a *better-tuned* second axis (and a third) is consistent with the prose test's plateau interpretation.

What flow-sequence-as-bag-of-features captures cleanly:
- Aggregate flow regime (heavy / light / lopsided)
- Expiry concentration profile (0DTE-heavy vs term-spread)
- Session-rhythm artifacts (which is **noise**, not signal — see Tier 2 contamination)

What flow-sequence-as-bag-of-features does NOT capture:
- Time-ordered algo footprints (ramping fills, execution-style fingerprints)
- Strike-concentration *shape* (single-strike vs spread distribution)
- Direction confidence in the presence of mixed flow (a session with 60/40 calls/puts looks similar to 80/20 in this 24-dim vector once z-scored)

The "session-rhythm artifact" failure of Tier 2 is the new cascade-candidate from this run (see Discipline notes).

## Recommended Next Axis

Per the Tier-2 contamination + cross-axis-stacking validation, the next instrument should NOT be a finer flow-sequence model (LSTM/transformer is heavy substrate work for what may be diminishing returns past the bag-of-features ceiling). Higher-leverage paths:

1. **GEX state vectors (highest leverage).** Substrate exists post-iter #3 (PR #104, brain organ `gex_inference`). Per-ticker `(gamma_flip_strike, call_wall, put_floor, dealer_net_direction, pin_attractor_strikes)` is already a structured-numeric fixed-dim vector. Cosine = dealer-positioning similarity. **Dealer positioning is a structurally distinct axis from flow-print direction** — flow-print measures who's pushing; GEX measures the field they're pushing into. Multi-axis stack of `prose × flow × gex` is the natural next test.

2. **Strike-concentration spectra.** For each commentary T, compute the 1D distribution of premium across strikes per ticker (normalized histogram). Cosine on these distributions = "where flow concentrated." Captures single-strike-conviction vs broad-spread-positioning, which the bag-of-features can't see. Cheap to build (already have `strike` + `premium`).

3. **De-rhythmed flow-sequence v2.** If captain wants to keep the flow axis, the fix is to *subtract the time-of-session baseline* before vectorizing. Compute the median feature vector for each 30-min slot of the trading day across the corpus; subtract it from each commentary's vector. The residual captures "what was unusual about this 30-min window vs the typical 30-min-of-this-time-of-day." Removes session-rhythm contamination at the source. Quick iterate.

**Captain decides.** If the goal is breadth (more axes), GEX is highest-leverage. If the goal is depth (fix flow), de-rhymed v2.

## What this run did NOT test

- **Other forward horizons** (3h, NextClose, EOD) — kept SPY-1h for clean prose-test A/B. Cross-axis stacking effect size could be larger or smaller at different horizons.
- **Per-ticker flow vectors** vs market-wide aggregate — could capture algo-footprint better when restricted to the dominant ticker per commentary. Brief explicitly recommended market-wide; engine-room held to that judgment.
- **Other lookback windows** (15min, 60min, 2h) — 30min was a single judgment call. Sensitivity to this window length is a follow-up.
- **Conditioning by regime** — Pulse state, VIX bucket, time-of-session. Cross-axis stack effect might be much larger inside specific regime classes.
- **Sequence-aware models** — LSTM/transformer over time-ordered ticks. Out of analysis-mode scope today; would need substrate (training pipeline). Possibly never warranted if multi-axis-of-coarse-vectors path keeps compounding.

## Discipline notes (Tenet 26 honored)

- Throwaway script at `/tmp/flow-sequence-backtest/run.py`. Raw output cache at `/tmp/flow-sequence-backtest/data.npz` and `/tmp/flow-sequence-backtest/result.json`. Not promoted.
- Same time-adjacency >24h filter as prose test (cascade `analysis-pair-selection-contamination-by-temporal-adjacency`).
- **New cascade candidate surfaced by this run** (NOT codified — captain decides if it graduates):
  - `flow-bag-of-features-magnitude-bias-on-busy-session-open` — when vectorizing time-aggregated count/sum features, even with z-scoring, dense activity periods (post-open burst, late-day close) form a high-cosine cluster across sessions because they share *level of activity*, not *type of activity*. Mitigation: subtract per-time-of-session baseline before vectorizing, or weight by a time-density-controlled normalizer.
- Substrate retargets vs brief (write-time check 1 + 4 honored): `is_otm` was NULL (derived from strike+underlying); `executed_at` was NULL (used `raw.created_at`); `alert_type` mirrors `side` (used `side`); RepeatedHits direction inversion respected (trusted `side` over premium-side per memory).

## Captain decides

- **Standalone flow-sequence as the "next axis": NOT the move.** Tier 2 contamination + Tier 1 lower-than-prose Pearson make this instrument too coarse to lead.
- **Multi-axis stacking confirmed empirically: keep building axes.** GEX is the natural next, with substrate already in place. Strike-concentration is the cheap follow-up.
- **The plateau-saturation cascade (`embedding-validation-saturation-at-high-cosine`) holds across both axes tested so far** — same D9–D10 plateau shape. Likely a structural property of any single instrument applied to this market state space; the path past it is multi-axis composition, not better single-axis tuning.
