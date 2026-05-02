# Specialist Direct Flag (`specialist_flag`)

- **Status:** live (per `ct_detectors`)
- **Source file:** `supabase/functions/ct-watcher/index.ts:583` (insert into `ct_flags` stamping `detector_id='specialist_flag'`) + per-ticker specialist runner `supabase/functions/_shared/specialistRunner.ts` + per-ticker prompt at `docs/specialist-prompts/v2/<TICKER>.txt`
- **DTE class:** all
- **Live config row:** `SELECT * FROM ct_detectors WHERE id = 'specialist_flag'` — `config={}`, thesis "Specialist analysis is its own detection layer. Each specialist's flags accumulate per-detector track record."
- **Discrepancy note:** specialist source flags fill `source='specialist'` but `detector_id` is typically NULL on those rows. The `specialist_flag` detector_id row exists for portfolio accounting (so the lifecycle scoreboard sees specialists as a tracked entity), but specialists are graded via `source='specialist'` separately from the `detector_id` lookup. ~90 specialist flags lifetime, but **0 fires register under the `specialist_flag` detector_id key** in scoreboard queries that JOIN/filter on `detector_id`. Two parallel write paths exist: (a) the watcher's specialist-flag insert at `ct-watcher/index.ts:583` which DOES stamp `detector_id='specialist_flag'`; (b) the specialist runner's path which writes via `source='specialist'` and leaves `detector_id` NULL. The scoreboard discrepancy lives in path (b).

## What it sees
The full per-ticker specialist Claude prompt context: pulse, tape, regime, flow heatmap, prior reads (specialist recall organ — last 5 flagged + last 5 unflagged-conv-≥50), event recency, news causality. One specialist per watchlist ticker (10 total: NVDA, AAPL, MSFT, GOOGL, AMZN, META, TSLA, QQQ, SPY, IWM). Each fires every ~6 minutes during RTH.

## Math
No quantitative thresholds — LLM judgment per ticker prompt. Specialist outputs `direction_lean` (bullish/bearish/neutral/mixed), `conviction` (0–100 hard-clamped at `specialistRunner.ts:463`), and optionally a flag with strike/expiry/direction/thesis/invalidation/horizon_hours. Conviction `Math.max(0, Math.min(100, Math.round(conv)))`.

## Regime fit
All regimes; specialist self-gates via its prompt. Per-ticker prompts at `docs/specialist-prompts/v2/<TICKER>.txt` tune regime sensitivity individually (NVDA semi-cycle vs. SPY index-level vs. IWM small-cap dispersion).

## False-positive shapes
- Bullish few-shot bias (active punch-list `project_co_trader_specialist_bias_weekend.md`, deferred to post-2026-05-15 per C1 measurement-window discipline).
- Sonnet long-JSON drift on multi-flag responses.
- Conviction inflation under high-volume tape.
- Direction-inference miscoding on aggressive-ask puts feeding the specialist's prior-reads block (see `feedback_direction_inference_repeatedhits_put_inverted.md`).

## Demote criteria
Lifecycle scoreboard for specialist flags requires the grader to populate `detector_id` on specialist flags OR a separate scoreboard pathway joining via `source='specialist'`. Per Q1 thresholds: composite hr_v3 — but specialist grading needs the underlying-axis grader to mature (n=12 currently). **Hold live until grading sample matures**; do not demote on synthetic zero-fire counts.

## Calibration history
Commits `318ccc7` (specialist-flag detector portfolio accounting), `e07b7b6` (warden detector floor invariant). Per-specialist prompt archeology lives in `docs/specialist-prompts/v2/<TICKER>.txt` — 10 ticker-specific prompts with tuning history. C1 hit-rate measurement window (specialist recall property, commit `afbcfd7`) running 2026-05-01 → 2026-05-15. Calibration thickens passively as the backlog drains; full bias-rewrite parked behind that window.
