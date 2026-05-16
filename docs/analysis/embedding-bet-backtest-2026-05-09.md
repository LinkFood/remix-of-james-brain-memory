# Embedding-Bet Backtest — Tape Commentary Cosine vs Forward-Outcome

**Run:** 2026-05-09 evening · **Mode:** Analysis (Tenet 26) · **Substrate:** ct_tape_commentary post-PR #86 + manual drain (1,178 embedded rows; 4/24 → 5/9)

## TL;DR

**Validates on prose axis — statistically significant, small effect size.**

- Top cosine decile shows ~18% smaller mean forward-1h-SPY-return delta than bottom decile (after filtering same-session adjacency).
- Pearson r = −0.078 (p < 1e-200), Spearman ρ = −0.060 (p < 1e-160). Highly significant on n=206K pairs; effect size is real but modest.
- Monotonic trend: as cosine increases, mean |Δret| decreases through D1→D8, then plateaus at D9-D10.
- Trader-level Tier 2: surfaced cross-session pairs visually feel similar (same tide / dominant ticker / VIX cluster) AND mostly produce similar 1h outcomes (~0.06-0.12% deltas), with occasional larger divergence.
- **Captain's instrument-mismatch hypothesis is consistent with the data:** prose embedding captures real but partial signal. Most of the variance in forward outcomes is NOT predicted by commentary similarity — leaving room for flow-sequence, GEX-state, and strike-concentration vectors as additional axes.

## Phase A — Substrate Verification

### S1. Tape commentary embedding population

| Metric | Value |
|---|---|
| Embedded rows | 1,178 |
| Embedding dim | 512 (verified Voyage 3-lite) |
| Time range | 2026-04-24 03:39 UTC → 2026-05-09 04:56 UTC (~15 days) |
| `match_*_by_similarity` RPC | live |

### S2. Forward-outcome substrate

- **Metric chosen:** SPY 1h forward return at commentary timestamp T → close at T+60min.
- **Source:** `ct_price_bars` `ticker=SPY timeframe=1m` (10,356 bars covering 4/24 → 5/8 RTH).
- **Tolerance:** ±5min on both endpoints (handles minute-bar gaps in extended hours).
- **Coverage:** 704 of 1,178 commentaries have valid forward-1h price data. The 474 dropped are mostly off-RTH/weekend reads where T+60min lacks a SPY bar (Saturday quiet, late after-hours, etc.).

### S3. Pair-similarity feasibility

- 704 valid rows × 703 / 2 = **247,456 pairs** (raw); **206,650 pairs after >24h time filter**.
- Pairwise cosine via numpy `(N,512)@(N,512).T` matrix — manageable in seconds.
- Forward-outcome similarity defined as `|return_i − return_j|`. Negative correlation between cosine and `|Δret|` = embedding predicts forward similarity → bet validates.

## Tier 1 — Decile-Binned Correlation

### Raw (all pairs, n=247K) — DO NOT INTERPRET DIRECTLY

The raw analysis is contaminated by adjacent-minute reads (cron fires every 10 min and tape commentary often shifts only slightly between adjacent fires; cosine ≈ 1.0 with identical forward-return = trivially low |Δret|). Top-decile result is artificially strong.

### Time-filtered (>24h apart, n=206,650) — primary result

| Decile | Cosine range | N pairs | mean \|Δret\| | median \|Δret\| |
|---|---|---:|---:|---:|
| D1 | [0.5278, 0.6925] | 20,665 | 0.002125 | 0.001717 |
| D2 | [0.6925, 0.7289] | 20,664 | 0.002067 | 0.001609 |
| D3 | [0.7289, 0.7511] | 20,666 | 0.001937 | 0.001479 |
| D4 | [0.7511, 0.7672] | 20,665 | 0.001828 | 0.001400 |
| D5 | [0.7672, 0.7810] | 20,665 | 0.001805 | 0.001377 |
| D6 | [0.7810, 0.7936] | 20,665 | 0.001795 | 0.001386 |
| D7 | [0.7936, 0.8059] | 20,665 | 0.001764 | 0.001360 |
| **D8** | **[0.8059, 0.8194]** | **20,665** | **0.001737** | **0.001366** |
| D9 | [0.8194, 0.8361] | 20,665 | 0.001746 | 0.001382 |
| D10 | [0.8361, 0.9217] | 20,665 | 0.001747 | 0.001400 |

- **Pearson r (cosine, |Δret|): −0.078** (p ≈ 0)
- **Spearman ρ: −0.060** (p ≈ 0)
- **Top-vs-bottom-decile ratio:** D10 mean / D1 mean = **0.82** → top decile shows 18% smaller forward-return delta than bottom decile.

### Interpretation

**Monotonic curve through D1→D8** (each step lower than the prior). **Plateau at D8-D10** — the embedding stops differentiating at the top end. This shape is the actual story:
- The bet validates *across the bulk of the cosine distribution* — moving from low-similarity to mid-high-similarity pairs reduces forward-outcome divergence.
- At the very top (cosine > 0.81), additional similarity gains don't translate to additional outcome predictability. The signal saturates.
- Possible read: at high cosine, prose similarity is already capturing setup-shape clustering well enough that the residual variance is dominated by *other* factors (algo-specific positioning, regime change between sessions, news shocks) that prose doesn't capture.

## Tier 2 — Cross-Session High-Cosine Pairs (>24h apart, top-10)

The trader-level analog book test. Each pair is a real historical setup the captain could have read live.

| # | Cos | Δt | Pair Description | Forward 1h |
|---|---|---|---|---|
| 1 | 0.9217 | 3.0d | TSLA dominant bullish, VIX 17.4 → TSLA dominant bullish, VIX 17.3 | A +0.060% / B −0.001% / **\|Δ\| 0.060%** |
| 2 | 0.9174 | 3.0d | TSLA dominant bullish, VIX 17.4 → TSLA dominant bullish, VIX 16.9 | A +0.028% / B +0.018% / **\|Δ\| 0.010%** ✓ |
| 3 | 0.9170 | 1.9d | NVDA 13.7x call:put bullish → TSLA 6.2x call:put bullish | A +0.110% / B +0.016% / \|Δ\| 0.094% |
| 4 | 0.9148 | 1.9d | NVDA 13.7x bullish → TSLA 6.1x bullish (later in session) | A +0.110% / B −0.007% / \|Δ\| 0.117% |
| 5 | 0.9132 | 1.9d | NVDA 13.7x bullish → TSLA 6.2x bullish | A +0.111% / B +0.016% / \|Δ\| 0.094% |
| 6 | 0.9120 | 1.9d | NVDA 13.4x bullish → TSLA 6.1x bullish (later) | A +0.047% / B −0.007% / \|Δ\| 0.054% |
| 7 | 0.9118 | 1.9d | NVDA 13.4x bullish → TSLA 6.2x bullish | A +0.047% / B +0.016% / \|Δ\| 0.031% ✓ |
| 8 | 0.9108 | 3.0d | Bull-mode 2.43x call:put → TSLA bull bias 10am | A +0.068% / B +0.018% / \|Δ\| 0.050% ✓ |
| 9 | 0.9106 | 5.0d | Final-10min flow lock → final-20min NVDA dominant | A −0.298% / B −0.022% / **\|Δ\| 0.277%** ✗ |
| 10 | 0.9104 | 1.9d | NVDA 13.7x bullish → TSLA 6.1x bullish | A +0.111% / B −0.007% / \|Δ\| 0.117% |

### Trader-level read

- **Pairs 1, 2, 7, 8** — analogs that "feel right" trader-wise AND outcomes track within 0.06% delta. The bet validates on these.
- **Pairs 3-6, 10** — NVDA-dominant ↔ TSLA-dominant bullish flows; embedding clusters them as similar (both = "high call:put on a single name dominating watchlist flow"). Outcomes mostly track but with 0.05-0.12% deltas. **The embedding finds the right shape; the *specific ticker* matters for the residual.**
- **Pair 9** — 0.277% outcome delta on 0.91 cosine. The largest divergence in the top-10. Both prose describe "final minutes flow lock" with NVDA dominant; one resolved with SPY −0.30% (forced selling into close), the other with SPY −0.02% (flat finish). Same setup, different exits. **Pure prose can't distinguish these.** Captain's instrument-mismatch hypothesis fits.

## Honest Reading

**The bet validates as captured by prose embedding** — but the validation is partial, and the failure modes point at exactly the alternative axes captain articulated.

What prose embedding captures cleanly:
- Setup-shape (bullish/bearish/flat tide × VIX bucket × dominant-ticker character)
- Time-of-session framing (open / midday / final-X-min / close)
- Regime/conviction language (locked-in / pivoting / capitulating / flat)

What prose embedding does NOT capture:
- Specific algo footprints (the cross-ticker NVDA↔TSLA confusion shows this — same prose pattern, different mover)
- Strike-concentration shape (flow targeting 250C single-strike vs spread across multiple)
- Time-of-arrival microstructure (sweeps in 30s vs 5min make different futures)
- News-shock asymmetry (one session has post-print volatility; the analog session doesn't)

The **D8-D10 plateau** in Tier 1 is the same finding from a different angle — at high cosine, prose has already extracted what it can extract; the residual variance lives in non-prose substrate.

## Recommended Next Tests (per captain's instrument-mismatch path)

If captain wants to keep extending, these are the next axes to instrument:

1. **Flow-sequence embedding** (highest-leverage IMO). Vectorize time-ordered ct_flow_alerts on a ticker over N-minute windows (e.g., 30-min sliding window of `score, premium, side, strike_cluster`). Cosine = algo-footprint similarity. **Different from prose**: captures the actual print pattern, not the narrative describing it.

2. **GEX state vectors** — substrate exists as of iter #3 (PR #104). Per-ticker `(gamma_flip_strike, call_wall, put_floor, dealer_net_direction, pin_attractor_strikes)` is already a fixed-dim vector. Cosine = dealer-positioning similarity. Quick win — substrate already structured-numeric; just need to assemble + normalize.

3. **Strike-concentration spectra** — for each commentary timestamp, compute the spatial distribution of premium/sweeps across strikes per ticker. Cosine on this distribution = "where the flow concentrated." Distinguishes single-strike conviction from broad-spread positioning.

4. **Multi-axis composite** (long-term ceiling per captain): `prose_cos × flow_seq_cos × gex_cos × strike_dist_cos` weighted blend. Each axis captures different signal; the analog book is multi-dim.

## What this run did NOT test

- Forward-outcome at multiple time horizons (3h, NextClose, EOD). 1h was the cleanest 1m-bar fit; longer horizons need careful RTH-boundary handling.
- Outcome metrics other than SPY return: per-ticker forward returns, regime-change-within-N-hours, flow-pulse delta. Each could surface signal that 1h SPY return doesn't.
- Conditioning on regime: top-decile correlation might be much stronger inside specific regime classes (e.g., chop-neutral) and weaker in others (e.g., pre-event-macro). Effect-size disaggregation is a follow-up.

## Discipline notes (Tenet 26 honored)

- Analysis ran as throwaway script at `/tmp/embedding-backtest/run.py` — not promoted to autonomous infrastructure. Raw output cache at `/tmp/embedding-backtest/data.npz`.
- Same-session adjacency contamination caught at first run; filter retry surfaced the cleaner result. **First run without time filter would have over-validated** — captain's caution on test-design instrument matters at every layer, including pair-selection.
- Two cascade-catalog candidates surfaced (NOT codified — single-purpose, captain decides if these graduate to methodology entries):
  1. `analysis-pair-selection-contamination-by-temporal-adjacency` — when running pairwise analyses on time-stamped data, default-filter for minimum time-separation; otherwise adjacent-time pairs dominate the high-similarity tail.
  2. `embedding-validation-saturation-at-high-cosine` — partial-monotonic decile curves with high-end plateau are the structural signature of "embedding captures the bulk of the captureable signal in this instrument; residual variance lives elsewhere." Same shape may show up on flow-sequence/GEX/strike axes — worth pre-instrumenting decile analysis with that hypothesis.

## Captain decides

- **Bet validates on prose axis → expand semantic recall confidently.** Specialist semantic activation post-D2.2 (5/13) ships with reasonable ground truth.
- **The plateau says "next axis time."** Flow-sequence embedding is the cleanest next instrument — exists in raw form (ct_flow_alerts), just needs vectorization + the same backtest design.
- **Multi-axis analog book** is the upside ceiling — prose alone explains a slice, not the whole picture. The substrate compounds; the question is which axis to instrument next.
