# Specialists Runbook

## Symptom
- `ct_specialist_reads` has no row for some watchlist ticker today (e.g. AMZN missing while NVDA/TSLA present).
- All specialist flags one-sided (e.g. 9 bullish / 0 bearish in 7d) — bias regression.
- Specialist scoreboard frozen — `/specialists` page shows yesterday's ranks.
- Sonnet output truncated mid-array; specialist row has `current_read = null` despite flags landing.
- `current_read` written but no flag written, or vice versa.

## What's actually happening

10 per-ticker specialist crons (one per Mag7 + QQQ + SPY + IWM) fire on RTH cadence. Each invokes `_shared/specialistRunner.ts` which:
1. Calls `buildClaudeContext({ audience: 'cotrader', tickerFocus: <ticker>, organs: 'all' })` (Phase 4 migrated — no direct UW touches).
2. Runs the Sonnet prompt loaded from `ct_specialist_prompts` (versioned, James edits the row).
3. Parses the structured output (forced tool-use, NOT prose-mode JSON for long arrays — see `feedback_sonnet_long_json_use_tool_use.md`).
4. Writes `ct_specialist_reads` (1 row per run) and conditionally `ct_flags` (when conviction crosses threshold).

Audience: `cotrader`. Reads through brain (organs all).

Two distinct failure modes:
- **Reads but no flags / flags but no reads** — partial write, usually parser failure mid-handler. AMZN had this on 2026-04-24 (11 flags / 0 reads). Symptom-of-symptom: redeploy first, root-cause second.
- **Bias regression** — prompt set drifts toward one direction. Fixed quickly by injecting a balance rule + bearish few-shot, but proper fix is rewriting from versioned table.

Load-bearing files:
- `supabase/functions/_shared/specialistRunner.ts` — the runner
- `supabase/functions/ct-specialist-<ticker>/index.ts` — per-ticker thin wrapper (10 of these)
- `ct_specialist_prompts` table — versioned prompt rows; James updates by INSERT new version
- `ct_specialist_reads`, `ct_flags` — output

## Diagnostic ladder

1. **Per-specialist activity today.**
   ```bash
   KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
   curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_specialist_reads?select=specialist_ticker,created_at,lean,conviction&created_at=gte.$(date -u +%Y-%m-%dT00:00:00Z)&order=created_at.desc&limit=50" \
     -H "Authorization: Bearer $KEY" -H "apikey: $KEY" | jq
   ```
   Group by `specialist_ticker`; gaps tell you which specialist is silent.

2. **Cross-check flags.**
   ```sql
   SELECT specialist_ticker, count(*), min(created_at), max(created_at)
   FROM ct_flags
   WHERE source = 'specialist' AND created_at >= now() - interval '24 hours'
   GROUP BY specialist_ticker;
   ```
   If flags landed but reads didn't (or vice versa) → parser bug or partial transaction in the runner. AMZN-style precedent.

3. **Bias check.**
   ```sql
   SELECT specialist_ticker, lean, count(*)
   FROM ct_flags
   WHERE source = 'specialist' AND created_at >= now() - interval '7 days'
   GROUP BY specialist_ticker, lean;
   ```
   Severe imbalance (e.g. 9:0 bullish) on a ticker → prompt bias regression.

4. **Prompt diff.**
   ```sql
   SELECT version, created_at, length(system_prompt) FROM ct_specialist_prompts
   WHERE ticker = '<TICKER>' ORDER BY version DESC LIMIT 5;
   ```
   If a new version landed today and the bias started after, that's the smoking gun.

5. **Manual run.** Hit the specialist function directly with vault-stored service role; tail edge function logs for parser errors / token-overage truncation.

## Common causes

- **AMZN-pattern partial write.** `project_co_trader_amzn_specialist_reads_gap.md` — specialist writes flags but never `current_read`. Diagnostic: redeploy `ct-specialist-<ticker>` first, then check parser path. Almost always a thrown exception between flag-write and read-write.
- **Sonnet long-JSON drift.** `feedback_sonnet_long_json_use_tool_use.md` — multi-section + 10-item array prompts past ~5K tokens emit malformed arrays in prose mode. Fix: switch the offending prompt path to forced tool-use (`tool_choice: { type: 'tool', name: '...' }`), max_tokens 6000+. Defensive: validate required-keys SUBSET (only catastrophic gaps), default optional fields to safe empties on upsert.
- **Bullish bias regression.** `project_co_trader_specialist_bias_weekend.md` — 7 prompts had bullish few-shot bias (9:0 flags in 7d). Quick patch: add a bearish example + direction-balance rule to each prompt. Proper fix: rewrite from scratch with bias-audit section, version the prompt row.
- **Quant card silent regression.** `feedback_quant_card_silent_regression.md` — a migration that "only fixes gamma_flip" silently dropped 12 of 14 JSON blocks via CREATE OR REPLACE. Specialist context goes empty without a crash. Always preserve all top-level keys when altering `build_ticker_quant_card`.
- **Audience filter broken.** Specialists are `cotrader` audience — if someone passes `paper_claude` accidentally, `james_flags` organ goes silent and the specialist sees less context.
- **Stale row with refuted hypothesis.** Hallucination class — see `hallucination_class.md`.

## Fix steps

For partial-write (AMZN pattern):
1. Redeploy: `npx supabase functions deploy ct-specialist-<ticker> --no-verify-jwt`
2. Watch next cron fire; if `ct_specialist_reads` lands cleanly, it's a transient.
3. If still partial, instrument the runner with `recordDecision` breadcrumbs around the flag-write + read-write boundary (per `pgnet_response_body_null_workaround.md`). Find the throw site.

For bias regression:
1. Quick-patch the prompt row (don't redeploy code — the prompt is a row).
2. Schedule a proper rewrite for the weekend per `project_co_trader_specialist_bias_weekend.md`.
3. After patch, run `ct-backtest-harness` over the canonical week to confirm balance restored — analysis-mode work, terminal-me, NOT a new edge function.

For Sonnet truncation:
1. Switch to forced tool-use in the runner. See `chatPromptV1.ts` and other Sonnet wrappers for the pattern.
2. Upsert validation should accept partial: required keys catch catastrophic gaps only, optional fields default to safe empties.
3. Bump max_tokens to 6000+.

## Related

- Tables: `ct_specialist_reads`, `ct_specialist_prompts`, `ct_flags`
- Functions: `ct-specialist-<ticker>` (×10), `_shared/specialistRunner.ts`
- Memory: `project_co_trader_amzn_specialist_reads_gap.md`, `feedback_sonnet_long_json_use_tool_use.md`, `project_co_trader_specialist_bias_weekend.md`, `feedback_quant_card_silent_regression.md`, `haiku45_prose_json_drift.md`
- Related runbooks: `hallucination_class.md`, `cron_health.md`

---

## Recall property (added 2026-05-01)

Each specialist now sees its own prior reads on the ticker before deciding. The recall block is built by `_shared/specialistRecallContext.ts` and injected by `specialistRunner.ts` between `systemContextHeader` and the JSON-shape prompt.

Pulled per fire:
- Last 5 flagged reads on the ticker (with grades joined from `ct_flag_grades` where available)
- Last 5 days of unflagged reads with conviction ≥ 50

Three outcome states render distinctly so the model doesn't conflate pending with no-signal:
- `→ win/loss/partial` — flagged + graded
- `→ pending` — flagged + grade not yet landed
- `—` — unflagged

If the recall block is missing or wrong, check:
1. `get_brain_health(window_hours => 1)` — does `specialist_recall` show invocations? If not, the orchestrator isn't calling it.
2. `specialist_reads_per_ticker_today_rth` Warden invariant — failing means the substrate (`ct_specialist_reads`) is starved.
3. `specialist_memory_table_dead` Warden invariant — should always pass with low value. If it fails (rows accumulating), someone re-activated the dead v1 writer path; recall should still source from `ct_specialist_reads`, not `ct_specialist_memory`.

The N-pin choices (5 + 5, 5-day window, conviction ≥ 50) are documented in `specialistRecallContext.ts` header — tune intentionally, not accidentally.
