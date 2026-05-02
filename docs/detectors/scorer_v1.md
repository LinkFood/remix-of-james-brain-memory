# Scorer (`scorer_v1`)

- **Status:** shadow (per ct_detectors)
- **Source file:** `supabase/functions/ct-detector-scorer/index.ts`
- **DTE class:** all
- **Live config row:** SELECT * FROM ct_detectors WHERE id = 'scorer_v1'

## What it sees

Per-print volatility-magnitude detector. Reads `ct_flags` rows where `source='detector_alarm'` AND `score_breakdown IS NULL` (the true unscored predicate — `score=0` alone is a valid scored value and using it as the picker re-scores rows forever). Walks the backlog DESC by `created_at` (per `feedback_create_query_sort_desc.md`) in batches of 200. Cluster-aware via `scoreCluster()` — distinct `detector_id` count for the same `option_symbol` within ±10min produces the cross-detector confirmation signal. Emits `score`, `score_breakdown`, and `pulse_*` columns back onto the flag.

## Math

`min_score=80` per `ct_detectors.config`. Composite 0–100 conviction from 5 weighted components:

- **40 sig_class** — `ct_signature_magnitude_stats` median peak % (70% of axis, 200% peak = full credit) and `n_tracks` (30% of axis, n≥30 = full credit). Label key: `<TICKER>:<side>:<dte_bucket>:<predicted_source>`.
- **25 cluster** — distinct detectors on same `option_symbol` within ±10min. 1=0pts, 2=12.5pts, 3+=25pts.
- **15 voi** — Volume/OI ratio on matched `ct_flow_alerts` row, clipped at 10x.
- **10 premium** — ladder: ≥$200k full, ≥$100k half + linear, ≥$50k linear ramp, <$50k zero.
- **10 pulse_fit** — direction-aligned trending = full, anti-aligned = 0, chop/unknown = 5.

Source alert matched by `ticker+side+strike+expiry` within ±5min of `flag.created_at`, most-recent first. Detector is the SCORE column producer rather than a flag-writer; framework can route as alarm source if `score >= ct_config.slack_threshold`.

## Regime fit

Direction-agnostic at the magnitude axis — flags expected MOVERS regardless of bull/bear. The `pulse_fit` component does inject regime context (full credit when direction aligns with `trending_up`/`trending_down`), so net behavior is regime-aware even though the volatility-magnitude core is not. Tested most heavily during high-IV regimes. Trending-vs-chop calibration TBD.

## False-positive shapes

- **Single-name earnings IV** — high vol around earnings looks like signal but is just expected dispersion; sig_class component will only credit if the historical signature actually paid.
- **Mid-print pollution** — bid/ask aggressor missing or mid-prints leak into the `ct_flow_alerts` match window without true directional commitment.
- **RepeatedHits without aggressor flag** — per `feedback_uw_is_ask_bid_never_set.md` and `feedback_direction_inference_repeatedhits_put_inverted.md`, never trust `is_ask`/`is_bid`; direction must come from `inferDirection()` upstream. Bad direction → wrong `predicted_source` label → sig_class component scores against the wrong signature class.
- **Cluster ghost** — same `option_symbol` arriving twice from one detector in a 10-min window does NOT inflate the cluster axis (we use `Set<detector_id>`), but a misconfigured detector double-firing under two ids would.

## Demote criteria

Per Q1 thresholds (`docs/decisions/2026-05-02-detector-lifecycle-thresholds.md`): shadow→trial = n≥50 ∧ hr_v3≥0.30. Currently 0 lifetime fires. Hold shadow until detector accumulates a graded sample. Promotion is a `ct_detectors.status` UPDATE — no code change (Tenet 25).

## Calibration history

TBD — accumulating data, current fires N=0 over last 30d, revisit when N≥30.

Commits touching the scorer (per `git log --all --oneline -- supabase/functions/ct-detector-scorer/`):

- `d2c0b28` — feat(ct-detector-scorer): score the 7 shadow detectors so Slack can fire.
