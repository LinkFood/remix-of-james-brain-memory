# 2026-05-02 — Pattern feedback loop (DEFERRED — design only)

**Status:** scope locked, build deferred. Trigger condition stated below.

**Why deferred:** observations need to validate across multiple weeks before being load-bearing. Injecting premature observations into specialist prompts risks (a) overfitting to first-session noise, (b) contaminating the C1 hit-rate experiment that runs through 2026-05-15, and (c) violating Tenet 13 (preamble freeze).

## Build trigger

Build when **all** of:

1. `ct_observed_patterns` contains ≥10 rows with `status='validated'` (each validated requires re-confirmation across at least one additional analysis session, typically a different week's corpus refresh).
2. C1 verification window has closed (≥2026-05-15) — running this experiment under the freeze contaminates falsifiability.
3. Grader coverage extended to detector-fired flags so corpus settled-N is high enough that "validated" actually means something. Currently 68 settled / 5,255 = 1.3% — the bottleneck noted in `docs/calibration/2026-05-02-corpus-baseline-and-first-slices.md`.

ETA: 2-4 weeks out. Earlier than that = premature.

## Architecture

A new brain organ slotted into the synthesis layer (`_shared/claudeReadSurface.ts → buildClaudeContext`) alongside the existing nine. Read-only, audience-gated, fire-and-forget telemetry like all the others. Per Tenet 24 — every component publishes its output to a known schema where every other component can read it.

### File layout (when built)

- `supabase/functions/_shared/observedPatternsContext.ts` — the organ. Exports `buildObservedPatternsContext(input)` returning `{ matched_patterns: [...], conviction_modifier: number, telemetry: {...} }`.
- Add organ key `observed_patterns` to `_shared/claudeReadSurface.ts` orchestrator.
- Audience filter: `['cotrader','analyst']`. Excluded from `paper_claude` (paper-trading research generation must not see live patterns — they'd contaminate the experimental layer per the demoted-tenet 6 isolation rule).
- No new tables. Reads `ct_observed_patterns WHERE status='validated'`.

### Pattern matching algorithm

```ts
// Pseudocode for the organ
async function buildObservedPatternsContext(input: {
  instrument: string,
  side: 'call'|'put',
  fire_ts: Date,
  dte_days: number,
  premium: number | null,
  regime: string | null,
  // ... other dimensions sliced in pattern_signature
}) {
  // Build the candidate signature for THIS flag.
  const candidate_signature = {
    instrument: input.instrument,
    side: input.side,
    time_of_day_bucket: bucketTimeOfDay(input.fire_ts),
    dte_bucket: bucketDte(input.dte_days),
    premium_bucket: bucketPremium(input.premium),
    regime: input.regime,
  };

  // Pull validated patterns and find any whose signature is a subset of candidate.
  // The GIN index on pattern_signature enables fast jsonb @> queries.
  const matches = await pgQuery(`
    SELECT id, description, pattern_signature, n_observed,
           hit_rate_blended, hit_rate_per_axis, baseline_delta,
           recommended_action, regime_conditional
    FROM public.ct_observed_patterns
    WHERE status = 'validated'
      AND $1::jsonb @> pattern_signature  -- candidate contains pattern (pattern is subset)
    ORDER BY ABS(baseline_delta) DESC
    LIMIT 5
  `, [JSON.stringify(candidate_signature)]);

  // Compute net conviction modifier.
  // Initial proposal: linear sum of baseline_delta across matches, clamped to ±0.30.
  // (Pattern delta is in hit-rate space, prompt lift will be advisory not gating.)
  const net_modifier = clamp(
    matches.reduce((s, m) => s + Number(m.baseline_delta), 0),
    -0.30, +0.30
  );

  return {
    matched_patterns: matches,
    conviction_modifier: net_modifier,
    telemetry: { match_count: matches.length, ... }
  };
}
```

### Prompt injection

Specialist prompt gets a new ADVISORY block (not a hard rule, not a gate):

```
[OBSERVED PATTERNS — empirical priors from forensic post-op]
This setup matches N validated pattern(s) from prior sessions:

  - "Morning 10:30–11:30 ET MSFT calls (15-45d DTE, ask-aggressive)"
    n=N observed, hit rate Y% (baseline X%), Δ +Z pp
    Recommended: lean conviction +1 if other signals align

Net conviction modifier from observed patterns: +0.18.
This is advisory — your read still drives the call.
```

Mechanics:

- **Advisory, not load-bearing.** The specialist doesn't *have* to use it. The prompt makes that explicit.
- **Net modifier is bounded** (±0.30) to keep one wild outlier pattern from swamping the read.
- **Visible in the read** so we can grade post-op whether pattern-aware reads did better or worse than pattern-blind reads.

### Falsifiability — A/B tracking

Add `observed_pattern_match_ids bigint[]` and `observed_pattern_modifier numeric` columns to `ct_specialist_reads` (or store in metadata jsonb if one exists). When a read fires with the organ active:

- record which patterns matched
- record the net modifier
- record whether the specialist's final conviction moved in the modifier's direction

Then re-run the corpus analysis after 2 weeks: compare hit rates of `pattern_modifier > 0.10` reads vs `pattern_modifier < -0.10` reads vs `|pattern_modifier| < 0.05` reads. If the modifier predicts outcome direction, the loop is working. If not, deprecate the patterns that aren't tracking.

This becomes a structural learning loop: validated patterns either earn their place in prompts (they predict outcomes) or get demoted to `status='deprecated'`.

### Promotion / demotion automation (deferred, post-launch)

Once the loop is live, a weekly cron (`ct-observed-patterns-lifecycle`) can:

- Promote `observed → validated` if pattern re-confirmed in latest week's slice (n grew, |Δ| stable within ±5pp).
- Demote `validated → deprecated` if pattern's |Δ| in latest 30d drops below 0.10 (no longer load-bearing).
- This mirrors the K=4 stability gate already in `ct-specialist-prompt-lifecycle-v2`.

Until that's built, all status transitions are manual via James review.

## Tenets / risks the deferred design respects

- **Tenet 13 — preamble freeze through 2026-05-15.** Building this organ before the C1 window closes injects new context into specialist prompts during the experiment. Wait.
- **Tenet 25 — structure evolves, not code.** Adding a new pattern is `INSERT INTO ct_observed_patterns`. The organ reads the table dynamically. No code changes required to add/retire patterns. ✅
- **Tenet 24 — all systems talk.** Pattern matches surface in `ct_specialist_reads.observed_pattern_match_ids`, queryable by graders, EOD narratives, the warden, and future organs. No silo.
- **Tenet 1 — autonomous detection, human execution.** Patterns nudge conviction; James still executes. Modifier is advisory.
- **Tenet 13b — falsifiability.** A/B tracking column makes "did patterns help?" answerable empirically.
- **Risk: prompt bloat.** Five matched patterns × verbose description = significant prompt growth. Mitigation: cap descriptions at 200 chars, truncate at 5 matches.
- **Risk: stale patterns.** Demote-deprecated path is essential. Without it, decayed patterns nudge wrongly forever.
- **Risk: feedback contamination.** If pattern hit-rates are themselves measured on flags that fired with patterns active, we measure the system telling itself it's right. The A/B tracking handles this — the modifier-magnitude bucket comparison is the falsifiability mechanism.

## When this build does NOT happen

If after 4 weeks the corpus still has fewer than 10 validated patterns, the platform is telling us the system isn't generating reliable structural priors at this universe size. That's a more fundamental finding than "we couldn't build the loop yet." Don't force the build to clear the trigger condition — let the data decide whether the loop is justified.

## File index when built

- `supabase/functions/_shared/observedPatternsContext.ts` (new)
- `supabase/functions/_shared/claudeReadSurface.ts` (1-line organ wiring)
- `supabase/migrations/YYYYMMDD_observed_pattern_match_columns.sql` (track A/B on reads)
- `docs/SYNTHESIS_LAYER.md` (10th organ documented)
- `docs/runbooks/observed_patterns.md` (operational guide)
- `docs/decisions/YYYYMMDD-pattern-feedback-loop-launch.md` (this doc's successor when shipped)
