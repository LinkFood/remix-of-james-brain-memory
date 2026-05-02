# 2026-05-02 — Phase A Audit: Tier 2 #10 Per-Detector Docs

**Decision date:** 2026-05-02 ~01:30 UTC (Saturday early morning ET)
**Audit type:** Phase A only — read-only, no doc files written
**Phase B:** Mon-Tue-Wed (~9.25 hr writing time, splittable)
**Pre-Phase-B blockers:** 2 confirmations from James (~10 min)

## Detector inventory (14 detectors, all source files located)

| id | name | status | source_file | dte_class |
|---|---|---|---|---|
| `scorer_v1` | Scorer (volatility-magnitude) | shadow | `supabase/functions/ct-detector-scorer/index.ts` | all |
| `signature_v1` | Signature class match | live | `supabase/functions/ct-signature-watcher/index.ts` | all |
| `cluster_default` | Cluster (5min/3prints/2%/80%) | live | `ct-signature-watcher/index.ts` (config-driven via ct_detectors row) | all |
| `cluster_slow_stacker` | Slow Stacker (15min/5prints/3%/75%) | trial | same as cluster_default | all |
| `specialist_flag` | Specialist direct flag | live | `ct-watcher/index.ts:583` + `docs/specialist-prompts/v2/*.txt` | all |
| `whale_v1` | Whale detector | shadow | `ct-detector-whale/index.ts` | all |
| `unusual_oi_v1` | Unusual OI | shadow | `ct-detector-unusual-oi/index.ts` | all |
| `pair_qqq_iwm_v1` | QQQ-IWM pair divergence | shadow | `ct-detector-pair-qqq-iwm/index.ts` | all |
| `smart_money_repeat_v1` | Same-contract repeat cluster | shadow | `ct-detector-smart-money-repeat/index.ts` | non_0dte |
| `weekly_atm_voi_v1` | Weekly ATM with V/OI ≥ 1 | shadow | `ct-detector-weekly-atm-voi/index.ts` | non_0dte |
| `small_cap_inverted_put_v1` | TSLA/IWM aggressive bid-put → bearish | shadow | `ct-detector-small-cap-inverted-put/index.ts` | all |
| `zerodte_put_voi_extreme_v1` | 0DTE put V/OI extreme | shadow | `ct-detector-zerodte-put-voi/index.ts` | 0dte |
| `zerodte_opening_call_v1` | 0DTE opening hour ask-call | shadow | `ct-detector-zerodte-opening-call/index.ts` | 0dte |
| `flow_stack_v1` | Flow Stack — heatmap concentration | shadow | `ct-detector-flow-stack-v1/index.ts` | all |

## Source-file map gaps

- **`specialist_flag`** wraps at `ct-watcher/index.ts:583` but flag content originates in `docs/specialist-prompts/v2/*.txt`. Doc page should point to both.
- **`cluster_default` + `cluster_slow_stacker`** are not standalone functions — they are **rows in `ct_detectors`** consumed by the cluster loop in `ct-signature-watcher/index.ts` (~lines 390 + 709–720). The loop reads `config.window_min`, `strike_band_pct`, `min_unanimity_pct`, `min_prints` from each row. Doc must call this out so future detectors of class `cluster_*` are added by INSERT, not by writing a new function.

No other gaps.

## Doc page template (per-detector)

Each `docs/detectors/<id>.md` page contains:

```markdown
## <Detector Name> (<id>)
- Status: shadow | trial | live | decay | retired
- Source file: <path>
- DTE class: <dte_class or "any">

### What it sees
<one paragraph: what input signals it consumes — flow alerts,
price bars, OI, gamma, snapshots>

### Math
<key thresholds + formulas, pulled from config + code. Include
specific config keys (ct_config.*) so future tuners know where to
turn the dials.>

### Regime fit
<when does this detector work — trending markets, chop, vol spikes,
stable. If unknown, mark "TBD — needs calibration history.">

### False-positive shapes
<known whip-saw modes — earnings drift, dealer hedging, mid-prints,
RepeatedHits without aggressor>

### Demote criteria
<what would move this from live → trial or trial → decay. Hit rate
floor? Sample size?>

### Calibration history
<commits or memory references where this detector's thresholds got
tuned. Format: "commit <hash> 2026-04-XX — bumped X from Y to Z
because <reason>". If no history, "TBD".>
```

## Existing structure references

- `docs/specialist-prompts/v2/*.txt` — flat dir of 10 prompts. Plain `.txt`, no front-matter. Suitable structural twin for detectors.
- No existing `docs/detectors/` directory.
- **Proposed layout:** `docs/detectors/<id>.md` (mirrors `specialist-prompts/v2/<TICKER>.txt`). Optional `docs/detectors/README.md` index page mapping the inventory table.

## Phase B effort breakdown (~9.25 hr total)

| detector | est | reason |
|---|---|---|
| signature_v1 | 60 min | most calibration history, tier ladder, multiple commits to mine |
| specialist_flag | 60 min | 10 specialist prompts to summarize per-ticker |
| smart_money_repeat_v1 | 45 min | corpus archeology (2026-04-20→24 baseline numbers) |
| weekly_atm_voi_v1 | 45 min | per-day lift discriminator math |
| zerodte_opening_call_v1 | 45 min | corpus baseline + hour-window mismatch |
| zerodte_put_voi_extreme_v1 | 45 min | thesis/config mismatch resolution |
| flow_stack_v1 | 45 min | newest detector, math + statistical baseline writeup |
| cluster_default | 30 min | well-understood |
| cluster_slow_stacker | 30 min | thesis already in row |
| scorer_v1 | 30 min | clean function |
| whale_v1 | 30 min | trivial math |
| unusual_oi_v1 | 30 min | trivial math |
| pair_qqq_iwm_v1 | 30 min | trivial math |
| small_cap_inverted_put_v1 | 30 min | direction-inversion note |

Splittable Mon (~4 hr clusters + scorer + whale + unusual_oi + pair) / Tue (~2.75 hr signature + specialist + flow_stack) / Wed (~2.5 hr 4 corpus-history detectors).

## Calibration archeology required

Detectors where math/history isn't fully in code/config:

1. **`signature_v1`** — tier thresholds and signature-class peak medians live in DB-side state + multiple commits. Will need a query against `ct_signature_classes` to capture current medians at write time.
2. **`smart_money_repeat_v1`** — 39% hit-rate baseline lives in memory (`project_co_trader_canonical_corpus_2026_04_20_to_24.md`), not code.
3. **`weekly_atm_voi_v1`** — per-day lift table (2.2x–32x) lives in thesis text, not code.
4. **`zerodte_opening_call_v1`** — corpus 54% hit-rate + 129 fires/5d in thesis text only.
5. **`zerodte_put_voi_extreme_v1`** — **thesis says V/OI≥20, config says 5.0**. **Phase B blocker:** confirm intended threshold with James before writing the math section.
6. **`small_cap_inverted_put_v1`** — `is_bid` reliance contradicts global rule `feedback_uw_is_ask_bid_never_set.md`. Phase B should flag this as a known bug, not document it as canonical.
7. **`specialist_flag`** — no quantitative math; doc must summarize each of 10 specialist prompts (NVDA/QQQ/SPY/AMZN/AAPL/GOOGL/META/MSFT/TSLA/IWM).

## Pre-Phase-B blockers (10 min total from James)

1. **Confirm directory layout** — `docs/detectors/<id>.md` with index README? Or flat `<name>.md`? Default to the former.
2. **Resolve `zerodte_put_voi_extreme_v1` threshold mismatch** — config `min_voi_ratio=5.0` vs thesis "V/OI ≥ 20". One-line answer from James, then doc reflects truth.

Everything else is extractable from code + config + memory + git log without further input.

## Phase B is ready to start Mon: **YES with two pre-flight items above.**

Suggested cadence:
- **Mon** (4 hr): clusters + scorer + whale + unusual_oi + pair
- **Tue** (2.75 hr): signature + specialist + flow_stack
- **Wed** (2.5 hr): smart_money_repeat + weekly_atm_voi + zerodte_*

Splittable across multiple sessions per day; no single doc page exceeds 60 min.
