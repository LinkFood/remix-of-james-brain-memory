# Hallucination-Class Runbook

## Symptom
- Morning brief / EOD report frames yesterday's events as today (most common).
- Claude promises to "pull live" something or claims it will "watch for" an event that already happened.
- The brief preamble says the wrong day or wrong NOW timestamp.
- Specialist quotes a refuted hypothesis as if still live.
- A row Claude wrote claims "FOMC today" when FOMC was yesterday, or "earnings tomorrow" when they're today.
- `temporalValidator` warnings persist on output rows; `eventCoherenceValidator` warnings spike in `/health`.

## What's actually happening

Three structural pieces compose to make temporal hallucinations hard. When a hallucination ships, exactly one of them is broken or bypassed.

1. **`temporalContext.ts`** — `tagIsoTimestamp()` pre-tags every timestamp surfaced into prompts; `temporalAnchorPreamble` prepends the literal `"Today is YYYY-MM-DD, day NAME, NOW=..."` opening line to every Claude system prompt. If a consumer assembles its own prompt and skips this preamble, Claude has no anchor.

2. **`event_recency` organ** — pulls the actual outcomes (FOMC decisions, earnings beats/misses, CPI prints) into the 72h `just_happened` bucket. The orchestrator formats this as `preamble.whatJustHappened` — every Claude-facing prompt opens with the literal facts of the last 72 hours. If this organ is silent (no rows / org skipped) Claude pattern-matches on stale text from other context.

3. **`temporalValidator` + `eventCoherenceValidator`** — post-Claude validators in the chain. They scan output text for "Powell speech today" / "earnings tomorrow" claims and check against the organs that fed the prompt. Warnings persist to a JSONB catch-all column on the row Claude wrote, and surface in `/health`. The validators don't block ship — they label.

The bug class this kills: yesterday's news being framed as today's.

The 2026-04-30 incident: morning brief framed Wednesday's MSFT/GOOGL/AMZN/META earnings + Wednesday's FOMC as "TODAY" (Thursday). Two compounding causes:
- Stale AMZN open hypothesis row had text claims with "today (Apr 29)" baked in. The hypothesis was refuted, but the *text* survived the refute.
- `buildClaudeContext` strips `created_at`. The temporal anchor on the surface was correct, but the embedded row's prose had self-asserting "today" wrong.

Load-bearing files:
- `supabase/functions/_shared/temporalContext.ts`
- `supabase/functions/_shared/eventRecencyContext.ts`
- `supabase/functions/_shared/temporalValidator.ts`
- `supabase/functions/_shared/eventCoherenceValidator.ts`
- `supabase/functions/_shared/claudeReadSurface.ts` (orchestrator, surfaces `preamble.temporalAnchor` + `preamble.whatJustHappened`)
- `docs/SYNTHESIS_LAYER.md` section "The Hallucination-Class Kill"

## Diagnostic ladder

1. **Reproduce on the offending row.**
   Pull the row Claude wrote (e.g. `ct_daily_briefs`, `ct_eod_summaries`, `ct_specialist_reads`). Check:
   - Does its JSONB warnings column have `temporalValidator` / `eventCoherenceValidator` entries?
   - Does the prose make a "today" / "tomorrow" claim that's wrong?

2. **Validate the consumer used `buildClaudeContext`.**
   ```bash
   grep -l "buildClaudeContext\|claudeReadSurface" supabase/functions/<consumer>/index.ts
   ```
   If absent → consumer is a Phase 4 escapee. Migrate it to read through the brain. This is the most common root cause for new consumers.

3. **Verify preamble was prepended.**
   In the consumer's handler, `ctx.preamble.temporalAnchor` and `ctx.preamble.whatJustHappened` MUST appear at the top of the system prompt. If the consumer assembles `messages: [{ role: 'system', content: '...' }]` without these, that's the bug.

4. **Inspect `event_recency` organ output for the consumer's audience.**
   ```sql
   SELECT helper_name, error, created_at
   FROM ct_brain_telemetry
   WHERE consumer_name = '<consumer>'
     AND helper_name = 'event_recency'
     AND created_at >= now() - interval '24 hours'
   ORDER BY created_at DESC LIMIT 10;
   ```
   `error LIKE 'warning:%'` is benign; `error LIKE 'skipped:%'` or `error IS NOT NULL` (real error) → organ is failing.

5. **Check for stale prose-with-text-claims in source rows.**
   The 2026-04-30 root cause. Hypothesis rows survive a refute; their *text* still says "today". Audit: when a row is refuted/superseded, the consumer of that row should treat it as historical context, not live. If the prompt embeds the row's prose verbatim, "today" leaks.

## Common causes

- **Consumer not using `buildClaudeContext`** (Phase 4 escapee). Migrate it. The orchestrator IS the temporal kill chain.
- **Ad-hoc context assembly that bypasses preamble.** Even using `buildClaudeContext`, if the consumer concatenates its own prompt prefix BEFORE `preamble.temporalAnchor`, it weakens the anchor. Always: anchor → whatJustHappened → consumer's specific instructions.
- **Validator chain not run.** Post-generation validators are part of the contract. If the consumer skips them, the warning never surfaces and the bug stays invisible until James notices.
- **Stale row text survives a refute.** `project_co_trader_morning_brief_temporal_bug_2026_04_30.md` is the canonical incident. Fix: when surfacing a refuted/old hypothesis row as context, rewrite or annotate the prose; don't embed verbatim.
- **Quant card silent regression** wiped event blocks. See `feedback_quant_card_silent_regression.md` — if the quant card lost the event block, `event_recency` has nothing to anchor against for that ticker.
- **`ct-session-analog` 404** meant `analogs` organ returned `meta.warning='no_current_embedding'` from launch through 2026-04-30 evening. Recall layer was offline; consumers fell back on weaker context. First real row 2026-05-01.

## Fix steps

For "today framed wrong" bug:
1. Read `project_co_trader_morning_brief_temporal_bug_2026_04_30.md` first. Saturday rebuild plan documented there: A) deterministic fact pack B) Haiku validator pass C) Opus 4.7 swap D) propagate to EOD/tape/specialists. Tenet 13 + 15 — kill the class, not the instance.
2. Identify the consumer. Verify preamble usage (step 2-3 above).
3. If preamble is missing, add it. If preamble is present but a stale row's prose leaks "today", patch the row-surfacing code to either (a) rewrite the prose or (b) add a temporal annotation Claude must respect.
4. Add a fact-pack pass: deterministic timestamps for the events the prompt covers, consumed as structured (not prose) data. Haiku validator pass before Sonnet generation catches catastrophic temporal mismatches.
5. Re-run the consumer's next cycle. Verify the output, then the validator warning column.

For new consumers: follow `docs/SYNTHESIS_LAYER.md` "How to Add a New Consumer (3 steps)" — step 1 is `buildClaudeContext`, step 2 is preamble usage, step 3 is the validator chain. Don't ship without all three.

## Related

- Files: `_shared/temporalContext.ts`, `_shared/eventRecencyContext.ts`, `_shared/temporalValidator.ts`, `_shared/eventCoherenceValidator.ts`, `_shared/claudeReadSurface.ts`
- Tables: `ct_events`, `ct_earnings_moves`, `ct_central_bank_state`, `ct_breaking_news`, `ct_brain_telemetry`
- Docs: `docs/SYNTHESIS_LAYER.md` (section "The Hallucination-Class Kill")
- Memory: `project_co_trader_morning_brief_temporal_bug_2026_04_30.md` (canonical incident), `temporal_anchor_pattern.md` (agent memory), `feedback_quant_card_silent_regression.md`
- Related runbooks: `specialists.md`, `data_freshness.md`
