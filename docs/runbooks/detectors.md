# Detectors Runbook

## Symptom
- `ct_flags` has 0 rows for a specific detector today (one detector silent while others firing).
- All flags from a detector show `score = 0` even past the 5-min latency window.
- Detector lifecycle stalled — never advances from `shadow` to `trial` or `live`.
- `/flags` page shows skewed distribution (e.g. one detector 100× the rest).
- Scoreboard not updating for a detector.

## What's actually happening

Detectors live as **rows** in `ct_detectors` (one per strategy, with config + lifecycle status — `shadow` / `trial` / `live`). Adding a detector is an INSERT, not a code change (Tenet 25). The portfolio cron + per-detector edge functions fire on RTH cadence and write to `ct_flags` (`source` column = detector name).

Score ≠ instant. `score-flow-continuous` (`*/2 10-22 * * 1-5`) backfills `score` and `pulse_at_fire` after detector flag insertion. There's a built-in 5-min latency window where `score = 0` is normal, NOT a bug — see `feedback_detector_alarm_score_5min_latency.md`. Filter `created_at < now() - interval '6 minutes'` for "real" zero-score flags.

Load-bearing files:
- `ct_detectors` table — manifest, lifecycle, thresholds
- `supabase/functions/ct-detector-portfolio/` — orchestrator
- `supabase/functions/ct-detector-<name>/` — per-detector logic
- `supabase/functions/score-flow-continuous/` — score backfill cron
- `supabase/functions/_shared/directionInference.ts` — call/put + ask/bid → bullish/bearish (NEVER read `is_ask`/`is_bid` directly)
- `supabase/functions/_shared/inferDirection.ts` — wrapper

## Diagnostic ladder

1. **Per-detector activity today.**
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
   curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_flags?select=source,instrument,created_at,score,lean&source=eq.<detector_name>&created_at=gte.$(date -u +%Y-%m-%dT00:00:00Z)&order=created_at.desc" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" | jq
   ```

2. **Detector lifecycle and config.**
   ```sql
   SELECT name, lifecycle, enabled, config, last_run_at, last_run_status
   FROM ct_detectors
   WHERE name = '<detector_name>';
   ```
   `enabled = false` or `lifecycle = 'retired'` → expected silence.

3. **Score-zero filter check.**
   ```sql
   SELECT count(*) FILTER (WHERE score = 0) AS unscored,
          count(*) FILTER (WHERE score > 0) AS scored,
          count(*) FILTER (WHERE created_at < now() - interval '6 minutes' AND score = 0) AS true_zeros
   FROM ct_flags
   WHERE source = '<detector_name>' AND created_at >= now() - interval '24 hours';
   ```
   If `true_zeros` is high → score backfill cron is broken. If `unscored` is high but `true_zeros` is low → it's the latency window, NOT a bug.

4. **Detector logic dry-run.** Hit `ct-detector-<name>` manually with vault-stored service role; check the function logs for "rows considered: N, flags emitted: M". If considered > 0 and emitted = 0, the threshold is too tight or the direction inference is upside-down.

5. **Backtest against canonical corpus.** Analysis-mode work — terminal-me with `ct-backtest-harness` over Mon-Fri 2026-04-20→24 (the canonical training week). Per `project_co_trader_canonical_corpus_2026_04_20_to_24.md`. Don't ship a fix without this check.

## Common causes

- **Score-race / signature watcher race.** `feedback_signature_watcher_score_race.md` — Signature watcher (every 1 min) reads alert score from `ct_scored_flow` BEFORE the scoring cron (every 2 min) writes it. Flag fires with `score = 0`, alarm dedupe blocks re-fire. Fix: inline the producer (scoring) in the consumer's (signature watcher) cron body.
- **`is_ask` / `is_bid` direct read.** `feedback_uw_is_ask_bid_never_set.md` — UW raw flow has these columns set `false` on every row (0/6320 confirmed in canonical corpus). NEVER check directly. Always use `inferDirection()` from `_shared/directionInference.ts`. Detector firing 0 times in backtest with this signature → almost certainly the cause.
- **RepeatedHits put inversion.** `feedback_direction_inference_repeatedhits_put_inverted.md` — system-wide bullish bias root cause. If your detector inherits from RepeatedHits-class, verify the put-side direction inference is symmetric ask-aggressive.
- **Corpus undersampling.** `feedback_corpus_bias_under_polled_tracks.md` — pre-2026-04-28 `ct_contract_tracks` was under-polled at 1.4% of needed throughput. ~60% had `peak = 0`. Detectors trained against `ct_signature_magnitude_stats` inherited the bias. Re-poll canonical week before any detector calibration.
- **Per-symbol identity / unique-index conflict.** `per_symbol_identity_migration_pattern.md` (agent memory) — if a detector's logic INSERTs into a table with the new per-symbol UNIQUE INDEX, ON CONFLICT must be present or insert silently fails.
- **Watchlist filter.** Per-ticker detectors must filter by `ct_config.watcher.watchlist`. New ticker added without redeploy → not flagged.
- **`ct_flags.instrument` column.** `feedback_ct_flags_uses_instrument.md` — ticker column on `ct_flags` is `instrument`, NOT `ticker` (doesn't exist) and NOT `specialist_ticker` (null on detector flags). Hot-ticker queries against `ct_flags` MUST use `instrument`.

## Fix steps

For score-race / signature watcher race: inline the producer in the consumer's cron body. Read the current `ct-signature-watcher` cron schedule SQL; merge the score-write step ahead of the read step.

For direction inference issue:
1. Verify the offending detector is using `inferDirection()`, not direct `is_ask`/`is_bid` reads.
2. After the fix, run `ct-prediction-backfill` 4-5 times to retag historical contract_tracks + print_tracks (per `feedback_run_prediction_backfill_after_inference_change.md`).
3. Redeploy 5 functions that import `directionInference.ts`. Find them with `grep -l directionInference supabase/functions/*/index.ts`.
4. Re-run canonical-week backtest to confirm balance restored.

For lifecycle / config: edit the row in `ct_detectors`. No deploy needed. Verify next cron fire shows the change.

## Related

- Tables: `ct_detectors`, `ct_flags`, `ct_scored_flow`, `ct_signature_magnitude_stats`, `ct_contract_tracks`
- Functions: `ct-detector-portfolio`, `ct-detector-<name>` (×N), `score-flow-continuous`, `ct-prediction-backfill`
- Shared: `_shared/directionInference.ts`, `_shared/inferDirection.ts`
- Memory: `feedback_signature_watcher_score_race.md`, `feedback_uw_is_ask_bid_never_set.md`, `feedback_direction_inference_repeatedhits_put_inverted.md`, `feedback_corpus_bias_under_polled_tracks.md`, `feedback_run_prediction_backfill_after_inference_change.md`, `feedback_detector_alarm_score_5min_latency.md`, `feedback_ct_flags_uses_instrument.md`, `project_co_trader_canonical_corpus_2026_04_20_to_24.md`, `project_co_trader_detector_portfolio_shipped_2026_04_26.md`
- Related runbooks: `uw_pollers.md`, `data_freshness.md`
