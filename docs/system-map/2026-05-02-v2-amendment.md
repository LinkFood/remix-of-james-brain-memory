# 2026-05-02 — Pulse v2 + Specialist Scoreboard v2 Amendment

**Append-only amendment to the 2026-05-02 system map.** When this doc is consolidated into the main system-map files, this file can be deleted.

## What landed

| Surface | Count change |
|---|---|
| Edge functions | 163 → 165 (+ct-regime-capture, +ct-specialist-prompt-lifecycle-v2) |
| Migrations | +6 (040000, 040100, 040200, 040300, 040400, 040600, 040700, 040800, 040900) |
| Tables | 68 → 73 (+ct_growth_crons, +ct_regime_signals, +ct_regime_classifications, +ct_regime_history, +ct_regime_config, +ct_specialist_grade_axes, +ct_specialist_scoreboard_v2, +ct_specialist_prompt_lifecycle, +ct_specialist_conviction_calibration) — actually +9, table count 77 |
| Live crons | 221 → 224 (+ct-regime-capture-rth, +ct-regime-capture-offhours, +ct-specialist-score-v2-nightly) |
| Brain organs | 10 → 11 (+regime) — specialist recall extended |
| Warden invariants | 19 → 26 (+1 silent-failure-class, +3 pulse, +3 specialist) |
| UI pages | 33 → 33 (Pulse rebuilt, Specialists extended) |
| UI hooks | 105 → 107 (+useRegimeState, +useSpecialistScoreboardV2) |

## New tables

### Pulse v2
- `ct_growth_crons` — manifest of crons that must produce rows on cadence (silent-failure invariant scope)
- `ct_regime_signals` — UPSERT per (ticker | NULL=market-wide, bucket_ts) — raw signals
- `ct_regime_classifications` — UPSERT same key — derived label + confidence + rationale
- `ct_regime_history` — INSERT-only, append per fire — embedded_state vector(512), HNSW cosine
- `ct_regime_config` — classification rules (Tenet 25 — INSERT to add label)

### Specialist v2
- `ct_specialist_grade_axes` — per-flag multi-axis grade (premium + 4h/1d/3d underlying + blended + regime_at_fire)
- `ct_specialist_scoreboard_v2` — rolling stats per (specialist × regime × window_label)
- `ct_specialist_prompt_lifecycle` — K=4 stability gate per (specialist, prompt_version)
- `ct_specialist_conviction_calibration` — per-bucket calibration with __ALL__ fallback

## New brain organ — `regime`

`_shared/regimeContext.ts`. ContextHelper<RegimeResult>. audienceFilter `['cotrader', 'analyst']` — paper_claude excluded. Surfaces market-wide + per-ticker classification + top-3 cosine analogs from history. Preamble injection deferred to 2026-05-15.

## Extended brain organ — `specialist_recall`

`_shared/specialistRecallContext.ts` extended with optional fields:
- `multi_axis_stats` (premium / 4h / 1d / 3d / blended hit rates + drift_slope_7d + read_streak/graded_streak)
- `regime_conditional` (top-5 by n_graded)
- `conviction_calibration_curve` (per-specialist with __ALL__ fallback)
- `lifecycle` (live prompt_version row)

Existing v1 contract preserved — all v2 fields optional.

## New warden invariants

| Name | Severity | Threshold | Runbook |
|---|---|---|---|
| `cron_zero_row_upsert_silent_failure_class` | warn | 0 failing growth-crons | docs/runbooks/silent_failures.md |
| `regime_state_freshness_rth` | warn | ≤90 min, weekend pass | docs/runbooks/pulse_v2.md |
| `regime_history_growing` | warn | ≥30 / 24h on RTH | docs/runbooks/pulse_v2.md |
| `regime_embedding_present` | warn | ≥95% non-NULL | docs/runbooks/pulse_v2.md |
| `specialist_scoreboard_v2_freshness` | warn | ≤26h | docs/runbooks/specialist_v2.md |
| `specialist_grade_axes_growing` | warn | ≥10 / 24h on RTH | docs/runbooks/specialist_v2.md |
| `specialist_lifecycle_silent_streak_check` | warn | 0 stuck rows | docs/runbooks/specialist_v2.md |

All 26 invariants passing post-build.

## New crons

| Cron jobname | Schedule | Function |
|---|---|---|
| `ct-regime-capture-rth` | `*/5 13-21 * * 1-5` | ct-regime-capture |
| `ct-regime-capture-offhours` | `0 10-12,21-22 * * 1-5` | ct-regime-capture |
| `ct-specialist-score-v2-nightly` | `0 3 * * *` | ct-specialist-prompt-lifecycle-v2 |

All 3 registered in `ct_growth_crons` for silent-failure invariant scope.

## New ContextHelper registration

`HelperName` union extended in `_shared/contextHelper.ts`: added `'regime'`.
`buildClaudeContext` in `_shared/claudeReadSurface.ts`: regimeHelper imported + composed via Promise.all.

## UI surfaces

- `src/pages/Pulse.tsx` — rebuilt (5 panels: market-wide regime tile + 10-ticker grid + signals table + 7-day transitions log + 30-day analog frequency table). Weekend fallback in every panel.
- `src/pages/Specialists.tsx` — extended (per-tile: v1 sparkline + v2 multi-axis hit rates + regime-conditional micro-table + conviction calibration micro-curve + streak indicators + drift sparkline + lifecycle status badge).
- `src/hooks/useRegimeState.ts` — new (4-query fan-out + derived projections).
- `src/hooks/useSpecialistScoreboardV2.ts` — new (3-query fan-out + buildConvictionView helper).

## Tonight's bonus — v1 silent failure CLOSED

Migration `20260502040900_v1_scoreboard_null_specialist_fix.sql` adds `WHERE f.specialist_ticker IS NOT NULL` to `ct_specialist_outcome_stats`. The class-level fix (silent-failure invariant) caught the canonical case; the instance fix landed in the same session. Both v1 and v2 scoreboards now produce fresh rows on cadence.

## C1 contamination logged

The 2026-05-01 → 2026-05-15 Specialist Recall hit-rate verification window is now contaminated by v2's richer per-specialist surface. Decision: accept; re-evaluate at C5 acceptance review on 2026-05-15. Pulse v2 regime context is NOT injected into runtime preamble until window closes.

## Auto-regen recommendation

Per `findings.md` recommendation: build `ct-system-map-regen` weekly Sunday cron that regenerates `tables.md`, `cron-schedules.md`, `warden-invariants.md`, `brain-organs.md`, `edge-functions.md` from live DB + repo state. Tonight's update is hand-rolled; auto-regen would have caught these additions automatically.
