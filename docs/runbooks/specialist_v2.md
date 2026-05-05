# Specialist Scoreboard v2 — Runbook

Tables: `ct_specialist_grade_axes`, `ct_specialist_scoreboard_v2`, `ct_specialist_prompt_lifecycle`, `ct_specialist_conviction_calibration`
Producer: postgres RPC `ct_specialist_score_v2()` + edge function `ct-specialist-prompt-lifecycle-v2`
Cron: `ct-specialist-score-v2-nightly` (`0 3 * * *`) — calls lifecycle fn which invokes RPC then applies K=4 gate
Brain organ: `_shared/specialistRecallContext.ts` (extended) + `_shared/specialistRecallV2.ts` (helper)

## Warden invariants

### `specialist_scoreboard_v2_freshness`
**Threshold:** ≤26h staleness on `MAX(last_updated)`. 24h cron + 2h grace.

When alarm fires:
1. Check `MAX(last_updated) FROM ct_specialist_scoreboard_v2`.
2. Check `cron.job` for `ct-specialist-score-v2-nightly` — confirm scheduled and active.
3. Manual fire:
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd 2>/dev/null | grep service_role | awk '{print $NF}')
   curl -X POST "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/trigger_ct_specialist_score_v2" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}'
   ```
4. Or fire the lifecycle edge function (which runs RPC + lifecycle gate together):
   ```bash
   curl -X POST "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/invoke_edge_function" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "Content-Type: application/json" \
     -d '{"function_name":"ct-specialist-prompt-lifecycle-v2","body":{}}'
   ```

### `specialist_grade_axes_growing`
**Threshold:** ≥5 rows / 24h on RTH days. Weekend skip.

Calibrated 2026-05-05 from 10 → 5. The dispatcher allows 10 specialists × ~4 wakes/RTH (15-min cooldown) and PASS is the documented default in every prompt. Realistic production is 4-10 flags/day → 5-15 grade_axes/day. Original threshold of 10 was at the top of normal output and produced a permanent yellow-light (77 consecutive fails since 2026-05-02). 5 is the floor that still catches a complete pipeline freeze.

If failing during RTH:
1. Confirm specialists are firing — `ct_brain_telemetry` should have `consumer_name` like `ct-specialist-*` rows in last hour:
   ```bash
   curl -s "$SUPA/rest/v1/ct_brain_telemetry?consumer_name=ilike.*specialist*&select=consumer_name,created_at&order=created_at.desc&limit=5"
   ```
2. If specialists running but `events_considered: 0`: dispatcher is filtering everything out. Check `ct_scored_flow` for prints with `score >= specialist.dispatcher.score_trigger` (default 70) in last 5 min. On a quiet tape (max score < 70) this is normal and PASSes are correct behavior — not a bug.
3. If specialists have events but writing 0 flags: read recent specialist outputs in `ct_alerts` for `pass_reason` field. Most days the prompts' bias gates correctly suppress weak setups.
4. Run RPC directly: `SELECT * FROM ct_specialist_score_v2(p_since_days => 7);`
5. Underlying-axis grading depends on `ct_price_bars` — confirm `MAX(ts)` is fresh (column is `ts`, not `bucket_ts`).

### `specialist_lifecycle_silent_streak_check`
**Threshold:** 0 stuck rows. Catches "K=4 reached, but flip never happened" silent no-op.

Query:
```sql
SELECT specialist_ticker, prompt_version, status, proposed_status, consecutive_stable_runs, last_run_at
FROM ct_specialist_prompt_lifecycle
WHERE proposed_status IS NOT NULL
  AND status != proposed_status
  AND last_run_at < now() - interval '7 days'
  AND consecutive_stable_runs >= 4;
```

If any row appears: the lifecycle gate is broken. The cron is updating `consecutive_stable_runs` past K=4 but not actually flipping `status`. Root cause is most likely a missing UPDATE in the lifecycle edge function. Mirrors v1 silent-failure class at the lifecycle layer.

## Tunable thresholds

All in `ct_config`:

| Key | Default | Purpose |
|---|---|---|
| `specialist.lifecycle.stability_runs` | 4 | K — consecutive same-proposal nights before flip permitted |
| `specialist.lifecycle.shadow_to_trial_hit_rate` | 0.45 | Min hit_rate_blended to propose trial |
| `specialist.lifecycle.trial_to_live_hit_rate` | 0.55 | Min hit_rate_blended to propose live |
| `specialist.lifecycle.decay_hit_rate` | 0.40 | Below = propose decay |
| `specialist.conviction.per_specialist_min_n` | 30 | Min N per bucket to populate per-specialist row |
| `specialist.scoring.underlying_outcome_threshold_pct` | 0.5 | Move % for underlying win/loss vs partial |
| `specialist.scoring.premium_outcome_threshold_pct` | 50.0 | Premium peak % for premium win |

Adjust via:
```sql
UPDATE ct_config SET value = '0.50'::jsonb WHERE key = 'specialist.lifecycle.shadow_to_trial_hit_rate';
```

Effective on next nightly fire — no code change.

## What to do when a specialist proposes `decay`

**Don't panic-flip.** K=4 gate means 4 consecutive nights of the same proposal before the system accepts the change. That's intentional — single-night noise (e.g., a bad RTH session) shouldn't flip a specialist out of `live` status.

Investigation:
1. Check `ct_specialist_grade_axes` for the specialist over the last 7d. Is the decay across all axes or just one?
   ```sql
   SELECT regime_at_fire, blended_verdict, count(*)
   FROM ct_specialist_grade_axes a
   JOIN ct_flags f ON f.id = a.flag_id
   WHERE f.specialist_ticker = 'NVDA' AND a.graded_at > now() - interval '7 days'
   GROUP BY 1, 2;
   ```
2. Check the prompt — is it stale relative to current market structure? See `ct_specialist_prompts.notes` for the version's design rationale.
3. Check `drift_slope_7d` — is decay accelerating or stabilizing?

If decay is real and persists past K=4: status flips automatically. Slack post on flip. Take that as the cue to deploy a v3 prompt.

## Manual re-grading

If grading rules change (`grade_version` bumped to 2 in a follow-up migration):

```sql
-- Wipe old grades for re-run
DELETE FROM ct_specialist_grade_axes WHERE grade_version = 1;
-- Re-grade window
SELECT * FROM ct_specialist_score_v2(p_since_days := 30);
```

## Conviction calibration interpretation

`__ALL__` row = cross-specialist baseline. Always populated.

Per-specialist row = only populated when N ≥ 30 in that bucket (`specialist.conviction.per_specialist_min_n`). UI labels which is which. Below threshold, the per-specialist hit rate is too noisy to trust — fall back to cross-specialist.

If a specialist has high conviction (80-100 bucket) hitting at 30% but the cross-specialist baseline at the same bucket is 70%: that specialist's confidence is poorly calibrated. Tune via the prompt — gate harder before high-conviction calls.
