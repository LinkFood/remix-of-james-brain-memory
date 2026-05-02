# QQQ-IWM Pair Divergence (`pair_qqq_iwm_v1`)

- **Status:** shadow (per ct_detectors)
- **Source file:** `supabase/functions/ct-detector-pair-qqq-iwm/index.ts`
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'pair_qqq_iwm_v1';`

## What it sees

Pulse `premium_net` slopes for QQQ vs IWM. Reads the latest 2-3 `ct_flow_pulse_ticks` per ticker and compares the directional rate-of-change between mega-cap tech and small-caps over the rolling window. Pair-level alarm — `option_symbol` is NULL, `instrument='QQQ-IWM-PAIR'`.

## Math

Slope per minute = `(last.premium_net - first.premium_net) / minutes_between`. Fires when:

1. **Opposite signs** — QQQ slope > 0 and IWM slope < 0, or vice versa.
2. **Both above threshold** — `|qqq_slope| ≥ min_slope_threshold` AND `|iwm_slope| ≥ min_slope_threshold`.

Live config: `min_slope_threshold = 80000` (80k premium/min), `dedupe_min = 60`. Direction is `'neutral'` (volatility/rotation read, no single-instrument thesis); horizon 4h.

## Regime fit

Sector rotation events. When mega-cap tech (QQQ) and small-caps (IWM) decouple sharply, the rotation IS the signal. Best in clear trend regimes; quiet in chop where both indices drift similarly. Slower-moving signal — 60min dedupe reflects that the underlying flow shift persists once it shows up.

## False-positive shapes

- **Macro shock days** — both indices move same direction simultaneously (filtered by sign rule), but slope-of-slope artifacts on jumpy ticks can still trigger.
- **Fed days** — dispersion is mechanical (rate-sensitive small-caps reprice differently than tech), not informative about positioning.
- **Thin liquidity** — pre-bell, half-days, holiday weeks. Slope estimates over 2-3 ticks are noisy when premium volume is low.

## Demote criteria

Per Q1 thresholds: shadow→trial = `n ≥ 50 ∧ hr_v3 ≥ 0.30`. Currently n=9 lifetime — well below 50 floor. Hold shadow until sample size builds.

## Calibration history

TBD — accumulating data, current fires N=9 over last 30d, revisit when N≥30. Commits: `523eaf2` initial ship (2026-04-25, three pure-data detectors batch). No subsequent tuning.
