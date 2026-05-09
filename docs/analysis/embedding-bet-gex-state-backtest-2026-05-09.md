# Embedding-Bet Backtest — GEX-State Cosine vs Forward-Outcome (third axis)

**Run:** 2026-05-09 evening · **Mode:** Analysis (Tenet 26) · **Substrate:** ct_gex_timeseries ATM-band per-strike rows (4/24 → 5/9 watchlist) · **A/B/C vs prose + flow:** SAME 704-row commentary set, SAME SPY-1h forward outcome metric

## TL;DR

**GEX-state as a 50-dim composite is FLAT standalone — and SUBTRACTIVE in the three-axis stack.**

- Tier 1 standalone: **Pearson r = +0.010** (p ≈ 1e-3 — "significant" only because n=97k, effect size is zero) on n=97,473 cross-session pairs. Spearman ρ = +0.005 (p=0.11, not significant). **Slightly inverted** decile curve (D10/D1 = 1.06).
- Decile shape is the **third instance** of the saturation diagnostic (`embedding-validation-saturation-at-high-cosine`) — but a NEW shape: **flat across the entire distribution**, not monotonic-plateau (prose) or wobble-then-monotone (flow). The instrument extracts essentially zero signal from forward outcomes on this metric.
- Tier 2 trader-level: top-10 high-GEX-cosine pairs are dominated by **identical-zero-vector contamination** — sessions where every ticker resolves to the same `(0,0,0,dealer_signed,pin_concentration)` 5-d vector across watchlist gaps cluster at cosine ≈ 0.9957. Different failure mode than the flow test's busy-session-open contamination, same root cause: the vectorization captures structural similarity that's NOT predictive of forward state.
- **Tier 3 (load-bearing):** HHH = 15.4% better than LLL (matches prose-alone and flow-stacking magnitudes — diminishing returns at the third axis). **HHH is 2.7% WORSE than HHL** — adding the GEX axis on top of prose+flow makes the stack VALIDATE LESS, not more. HHH vs HLH/LHH: prose drives ~10% of the lift, flow drives ~5%, GEX is incremental noise.
- **Captain's instrument-mismatch hypothesis: REFINED.** The path past prose+flow is not "more axes." A coarse third axis can hurt. Instrumentation-quality matters per-axis; the stack is not noise-tolerant.

## Phase A — Substrate Verification

### S1. ct_gex_timeseries coverage

Schema verified live (S1 substrate-target check 4): `ticker, snapshot_at, strike, call_gex, put_gex, net_gex, underlying_price, is_atm_band` — matches `gexInferenceContext.ts` GexRow shape.

| Ticker | Total rows (4/24→5/9) | Distinct snapshots | Time range |
|---|---:|---:|---|
| NVDA | 78,530 | 292 | 2026-04-24T12:15 → 2026-05-08T21:45 |
| AAPL | 46,244 | 392 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| MSFT | 62,393 | 383 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| GOOGL | 62,472 | 377 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| AMZN | 31,565 | 349 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| META | 96,133 | 323 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| TSLA | 57,636 | 269 | 2026-04-24T12:15 → 2026-05-08T21:45 |
| QQQ | 186,292 | 400 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| SPY | 188,377 | 401 | 2026-04-24T12:00 → 2026-05-08T21:45 |
| IWM | 77,377 | 399 | 2026-04-24T12:00 → 2026-05-08T21:45 |

**Cadence:** ~15-min intervals during RTH and extended hours. ATM-band filtering produces ~30-50 strike rows per (ticker, snapshot_at) tuple. Coverage is dense across the watchlist; the 269-401 snapshot range tracks RTH session count over the 11 trading days.

### S2. Vectorization (per brief — 5-dim per ticker × 10 = 50-dim composite)

Mirrored `gexInferenceContext.ts` math directly in the script (no edge-function dependency, per brief):

- `gamma_flip_offset` = (gamma_flip_strike − spot) / spot — signed; linear-interp between bracketing strikes
- `call_wall_offset` = (call_wall_strike − spot) / spot — strike above spot with max call_gex
- `put_floor_offset` = (put_floor_strike − spot) / spot — strike below spot with most-negative put_gex
- `dealer_net_direction_signed` = +1/0/−1 based on Σnet_gex with 1.0 noise floor
- `pin_attractor_concentration` = top-3 |net_gex| / Σ|net_gex| in band

Per-commentary: for each watchlist ticker, find closest GEX snapshot within ±5min of commentary T. Zero-fill if no snapshot in window. Concatenate 10 × 5-dim → 50-dim. Z-score per dim, unit-normalize for cosine.

### S3. Population alignment (substrate gap surfaced)

**Coverage gap is the load-bearing Phase A finding:**

| Ticker coverage per commentary | Count |
|---|---:|
| All 10 tickers covered | 220 |
| 6 tickers (median) | typical |
| 0 tickers covered | 220 |

220 commentaries (31% of the 704-row set) had **zero** ticker GEX snapshots within ±5min — these were after-hours or weekend reads where GEX ingest was paused. Dropped from analysis. Final standalone N = **484 commentaries**, 97,473 cross-session pairs (vs prose 206K, flow 172K — substantively smaller).

For Tier 3 (triple-aligned with prose + flow): N = **438 commentaries**, 79,575 cross-session pairs after the additional 30-min flow-window filter.

## Tier 1 — Decile-Binned Correlation (>24h apart)

| Decile | Cosine range | N pairs | mean \|Δret\| | median \|Δret\| |
|---|---|---:|---:|---:|
| D1 | [−0.6957, −0.3956] | 9,748 | 0.001731 | 0.001347 |
| D2 | [−0.3956, −0.3062] | 9,728 | 0.001986 | 0.001554 |
| D3 | [−0.3062, −0.2370] | 9,763 | 0.001965 | 0.001580 |
| D4 | [−0.2370, −0.1590] | 9,750 | 0.001878 | 0.001453 |
| D5 | [−0.1590, −0.0837] | 9,745 | 0.001821 | 0.001420 |
| D6 | [−0.0837, −0.0022] | 9,749 | 0.001860 | 0.001498 |
| D7 | [−0.0022, +0.0857] | 9,747 | 0.001851 | 0.001392 |
| D8 | [+0.0857, +0.1990] | 9,748 | 0.002008 | 0.001517 |
| D9 | [+0.1990, +0.3594] | 9,744 | 0.001885 | 0.001476 |
| D10 | [+0.3594, +0.9957] | 9,751 | 0.001837 | 0.001454 |

- **Pearson r:** +0.010 (p = 1.4e-3 — significant only by sample size; effect size ≈ 0)
- **Spearman ρ:** +0.005 (p = 0.11 — NOT significant)
- **D10 / D1 ratio:** 1.06 (slightly inverted, immaterial)

### Decile shape diagnosis (third instance of `embedding-validation-saturation-at-high-cosine`)

This is a **flat curve** — a third structural shape distinct from prose's monotonic-plateau and flow's wobble-then-monotone. Mean |Δret| oscillates between 0.00173 and 0.00201 across all 10 deciles with no monotone direction. The instrument captures essentially **no** standalone forward-outcome signal across the entire cosine distribution.

The pattern is consistent across deciles, so this isn't a left-tail noise problem (flow) or a right-tail saturation problem (prose) — it's a **whole-distribution null result**. The 50-dim composite over ATM-band offsets does not separate forward-outcome-similar pairs from forward-outcome-divergent pairs at any cosine bucket.

## Tier 2 — Top-10 Cross-Session High-Cosine Pairs

| # | Cos | Δt | A → B (16-char ts) | Forward 1h |
|---|---|---|---|---|
| 1 | 0.9957 | 2.7d | 04-24T19:30 (bearish/18 VIX) → 04-27T12:00 (bullish/18 VIX) | A −0.024% / B −0.134% / **\|Δ\| 0.111%** |
| 2 | 0.9957 | 2.7d | 04-24T19:30 → 04-27T13:01 (bullish/18) | A −0.024% / B +0.115% / **\|Δ\| 0.139%** |
| 3 | 0.9957 | 2.7d | 04-24T19:30 → 04-27T13:01 (bullish/18) | A −0.024% / B +0.115% / **\|Δ\| 0.139%** |
| 4–10 | 0.9957 | 2.7d | All 04-24T19:30 (Google-Anthropic $40B / QQQ $675C 05/15 dominant) → 04-27T12:00–13:10 (quiet tape, zero flow) | mean \|Δ\| ≈ 0.110% |

### Trader-level read

**The top-10 ceiling at cos=0.9957 is a contamination artifact, not signal.** Every pair shares the same structural property: A is a 4/24 bearish-VIX-18 read; B is a 4/27 quiet-tape-noon-window read. The two reads have **opposite market tides**. The cosine ceiling is being driven by the 50-dim vector being structurally near-identical between sessions where:
- Mag-7 single-name GEX coverage was thin (4/27 noon = quiet/early), producing many `(0,0,0,0,0)` zero-fills
- The remaining tickers had similar dealer-net direction sign + similar low pin-concentration

Same shape as the flow-sequence test's busy-session-open contamination, but a different mechanism: instead of "active session = high counts dominate," it's "**inactive session = zero-vector dominates.**" Both expose the same diagnostic: cosine on aggregate-feature vectors, even when z-scored, can collapse to high similarity on shared *measurement-state* artifacts (densely active vs. densely empty) rather than the *positioning-state* the brief intended to capture.

**Top-10 vs baseline:** 0.001037 vs 0.001882 = 0.55× — at first glance the top-10 LOOKS to validate. But Top-50 = 0.002370 (1.26× WORSE), Top-100 = 0.003016 (1.60× WORSE). The top-10 is a tight zero-vector cluster that happens to have small forward outcomes; expanding the window past the cluster surfaces the underlying flat-or-inverted signal.

**Captain's gut-check question — "do these feel like the same dealer-positioning state?":** No. They feel like "two sessions where my watchlist GEX coverage was sparse for different reasons." The vectorization couldn't distinguish high-conviction-positive-gamma-with-clear-flip from no-coverage-zero-default.

## Tier 3 — Three-Axis HHH Stratum (LOAD-BEARING)

Triple-aligned subset (N=438 commentaries, 79,575 cross-session >24h pairs). All three axes computed on the same pair-index space.

Median splits: prose=0.7902 / flow=−0.0049 / GEX=−0.0862.

| Stratum (prose / flow / GEX) | N | mean \|Δret\| | vs LL ratio | median \|Δret\| |
|---|---:|---:|---:|---:|
| LLL | 11,570 | 0.002009 | 1.0000 | 0.001556 |
| LLH | 8,840 | 0.002039 | 1.0150 | 0.001605 |
| LHL | 10,649 | 0.001712 | 0.8523 | 0.001281 |
| LHH | 8,728 | 0.001884 | 0.9379 | 0.001366 |
| HLL | 8,934 | 0.001883 | 0.9376 | 0.001534 |
| HLH | 10,443 | 0.001780 | 0.8862 | 0.001413 |
| **HHL** | **8,633** | **0.001654** | **0.8236** | **0.001282** |
| HHH | 11,778 | 0.001699 | 0.8460 | 0.001332 |

### Cross-stratum reads

| Comparison | Ratio | Interpretation |
|---|---|---|
| HHH vs LLL | 0.846 | three-axis stack 15.4% better than triple-low — matches prose-alone and 2-axis HH magnitudes; **stacking saturates at the second axis** |
| **HHH vs HHL** | **1.027** | adding GEX on top of prose+flow makes the stack **2.7% WORSE** |
| HHH vs HLH | 0.955 | adding flow on top of prose+GEX = +4.5% better |
| HHH vs LHH | 0.902 | adding prose on top of flow+GEX = +9.8% better |
| Sanity: 2-axis HH (prose+flow) on this subset | 0.831 | matches flow-test's 15.2% — **HHL stratum (= 2-axis HH on prose+flow, GEX low) at 0.824 is the BEST stratum in the table** |

The cleanest read: **HHL (prose+flow high, GEX low) outperforms HHH.** The GEX axis as currently vectorized adds noise to the high-prose+high-flow pairs. Two interpretations are consistent with the data:
1. **GEX vectorization is too coarse** — the 50-dim ATM-band-offset composite collapses real dealer-positioning differences (high coverage with clear flip vs zero-fill default) into similar cosine values, contaminating the stratum.
2. **GEX is a structurally orthogonal axis** that doesn't correlate with prose+flow's signal — adding it as an "AND high" filter excludes pairs where prose+flow agrees but GEX is low, AND those excluded pairs (HHL stratum) actually have the cleanest forward-outcome similarity.

Either way: **the load-bearing finding from the brief is refuted in this run.** Three-axis stacking on the current GEX vectorization does NOT compound. The two-axis ceiling (prose × flow) is the empirical ceiling for the analog book as currently instrumented.

## Honest Reading

The brief framed three outcomes worth distinguishing:

1. *"HHH significantly better than any HH = three-axis stacking compounds. STRONG empirical multi-axis validation."* → **NOT validated.** HHH ≈ HHL with GEX taking 2.7% off the top.
2. *"HHH ≈ HH = prose+flow already saturated; GEX adds redundant dimension. Two-axis ceiling."* → **Closest to the data.** The two-axis ceiling is real on this corpus.
3. *"HHH worse than HH = structural problem (axis correlation, sample-size confound, metric inversion). Flag."* → **Mildly the case — flagged.**

What the GEX 50-dim composite captures cleanly:
- Aggregate dealer-positioning sign across the watchlist (positive_gamma vs negative_gamma)
- Coarse offset structure (where flip / wall / floor sit relative to spot)
- Pin-attractor concentration (sharp single-strike attractors vs spread)

What the GEX 50-dim composite does NOT capture:
- Per-ticker positioning *quality* (high-coverage clear-flip read vs zero-fill default — both look similar at the offset level when zero-fills dominate)
- Time-evolution of GEX state (a snapshot at T captures one moment; positioning that's *moving* vs *settled* looks identical)
- Strike-magnitude (the 5-d offsets are dimensionless ratios; absolute |net_gex| at the call wall isn't represented)
- Cross-ticker structural relationships (QQQ-SPY divergence in dealer state; the concatenation treats each ticker's 5-d vector as independent)

The flat-curve diagnostic is consistent with these gaps. Bag-of-offsets at a single moment per ticker is a coarse instrument; the cosine axis it produces doesn't separate forward-outcome-similar pairs.

## Recommended Next Probe

**Fourth-axis-now is NOT the move.** Three-axis-stacking compounding hypothesis doesn't survive Tier 3. Adding a fourth coarse axis on top of an already-saturated stack with a noise-injecting third axis is unlikely to compound.

The cleaner paths forward:

1. **GEX vectorization v2 — magnitude-aware, time-evolution-aware.** Replace the dimensionless offset composite with a richer per-ticker representation: include `(dealer_net_total_z, call_wall_magnitude_z, put_floor_magnitude_z, flip_distance_pct, recent_GEX_delta)` (delta = current − 1h-prior snapshot). Captures positioning *force* and *direction* of change. Same backtest design, see if curve shape converts from flat to monotone.

2. **Strike-concentration spectra (deferred from prior tests).** Cheapest unbuilt axis. For each commentary T, per-ticker normalized histogram of premium across strikes. Cosine = "where flow concentrated." Distinguishes single-strike-conviction from broad-spread. Substrate exists in `ct_flow_alerts` already.

3. **Per-ticker analog book vs market-wide.** Instead of 50-dim watchlist composite, restrict pairwise analysis to single-ticker GEX cosine when that ticker is the dominant tape commentary subject. Reduces zero-fill contamination at the source.

4. **Honest fallback: ship the two-axis (prose × flow) analog book as the operational instrument.** The 15-17% HH-vs-LL lift is replicable across both Phase A subsets and is the clean empirical ceiling. Don't over-engineer past where the data supports.

**Captain decides.** If the goal is more axes, GEX-v2 is the next tuning. If the goal is shipping signal, two-axis is the analog book that's already validated.

## What this run did NOT test

- **GEX vectorization variants** — tested only the gexInferenceContext-mirrored offset composite. Magnitude-aware variants are the natural next iteration; sensitivity to vectorization shape is the open question.
- **Per-ticker GEX cosine** vs the market-wide concatenation — could surface signal that the 50-dim composite drowns. Brief recommended market-wide; engine-room held to that.
- **Other forward horizons** (3h, NextClose, EOD) — kept SPY-1h for clean A/B/C comparison. Three-axis stack effect could differ at different horizons.
- **Conditioning by regime** — Pulse, VIX bucket, time-of-session. Could uncover regime-specific stack-compounding that's washed out in pooled analysis.
- **Larger pair populations** — 220 of 704 commentaries dropped due to GEX coverage gaps; backfilling weekend/after-hours GEX (substrate work, not analysis-mode) would expand the corpus.

## Discipline notes (Tenet 26 honored)

- Throwaway script at `/tmp/gex-state-backtest/run.py`. Raw output cache at `/tmp/gex-state-backtest/data.npz` and `/tmp/gex-state-backtest/result.json`. Not promoted.
- Same time-adjacency >24h filter as prose + flow tests (cascade `analysis-pair-selection-contamination-by-temporal-adjacency`). Held without modification — third empirical instance applying it.
- Substrate retargets vs brief (write-time check 1 + 4 honored): brief asserted ct_gex_timeseries schema from iter #3 PR #104; verified live before vectorization; matches. Coverage gap (220/704 zero-coverage commentaries) was NOT predicted by brief; surfaced and handled in Phase A.
- **Curve-shape diagnostic third instance — third NEW shape:** prose=monotonic-plateau, flow=wobble-then-monotone, GEX=flat. The diagnostic generalizes (cascade `embedding-validation-saturation-at-high-cosine` codified in PR #109): validating the methodology means the framework correctly classifies all three runs without code changes. Flat-curve sub-class may be worth promoting to its own catalog entry if it recurs on a fourth axis.
- **New cascade-candidate from this run** (NOT codified — captain decides):
  - `multi-axis-stack-third-axis-can-subtract` — when stacking N coarse-instrumentation axes, beyond N=2 the curve may go FLAT or INVERSE per axis. Empirical: HHH vs HHL = +2.7% worse (GEX subtracts from prose+flow). Mitigation: gate axis-N admission on standalone-Pearson-significance threshold (e.g., \|r\| > 0.05) before adding to the stack. Companion-pattern to `flow-bag-of-features-magnitude-bias` from the prior run.

## Captain decides

- **Three-axis-stacking-compounds-on-current-instruments: NOT validated.** Two-axis (prose × flow) is the empirical ceiling on this corpus.
- **GEX-as-50-dim-offset-composite: NOT the next operational instrument as-vectorized.** Either ship a v2 (magnitude-aware) and re-run, or accept GEX as a structurally-distinct axis whose value is in the brain organ's per-ticker readout, not in pairwise-cosine analog matching.
- **The flat curve is informative even as a null result** — confirms the bet's shape is instrument-quality-sensitive, not "any axis stacks." Going forward: each candidate axis gets its own standalone Tier 1 before being admitted to the stack.
