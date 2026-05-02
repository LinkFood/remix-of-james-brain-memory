# 2026-05-02 — P0 #3 Score-Race Coverage Audit

**Audit type:** Read-only code review across all score-readers and flag-writers.
**Question:** Did the score-race class kill (commits f5f2c4e + e88cc79, Apr 28) land everywhere? Are there any remaining unprotected score-write paths?
**Verdict:** **Zero unprotected sites. Class kill is complete.** No code change required.

## Class definition

The score-race bug pattern (per commit `f5f2c4e`):

> ct-flow-ingester writes `ct_flow_alerts` → ct-score-flow-continuous (every 2min) scores → `ct_scored_flow` → ct-signature-watcher (every 1min) reads alert + looks up score. If watcher fires before scorer, score=0 → flag.score=0 → alarm dedupe prevents re-fire when score arrives.

**Diagnostic of harm:** Apr 27 had 24/26 signature_v1 flags with score=0 (max=45). The dedupe meant they could never be corrected.

## Two-layer fix shipped Apr 28

### Layer 1 (`f5f2c4e`) — score-first cron preflight
The watcher cron now runs `ct_score_existing_flow(p_since => 15min)` **first** in the same SQL statement, then invokes the watcher. By the time watcher fires, fresh alerts always have scored_flow rows.

### Layer 2 (`e88cc79`) — inline per-alert recovery
The race re-emerged when alerts ingested between cron-preflight and watcher's alert-scan still hit `score=null`. The fix: in the alert scan loop, when `loadScoreForAlert` returns null, force a 60-sec-window `ct_score_existing_flow` around the alert's `executed_at`/`ingested_at`, then re-read.

```ts
// supabase/functions/ct-signature-watcher/index.ts:488-499
let score: number | null = await loadScoreForAlert(supabase, a.alert_id);
if (score === null) {
  const eventTs = a.executed_at ?? a.ingested_at;
  if (eventTs) {
    await (supabase.rpc as any)('ct_score_existing_flow', {
      p_since: new Date(Date.parse(eventTs) - 120_000).toISOString(),
    });
    score = await loadScoreForAlert(supabase, a.alert_id);
  }
}
```

## Coverage audit — score-readers + flag-writers

The race class only applies where a function does BOTH (a) reads `ct_scored_flow.score` AND (b) writes `ct_flags`. Cross-reference:

| Function | reads ct_scored_flow | writes ct_flags | Protection status |
|---|---|---|---|
| `ct-signature-watcher` | ✅ (alert-scan loop) | ✅ (signature/cluster fires) | **PROTECTED** — both layers (cron-preflight + inline-producer) |
| `ct-watcher` (specialist dispatcher) | indirect via specialistRunner | ✅ via specialistRunner | **N/A** — see specialistRunner row |
| `_shared/specialistRunner.ts` | ✅ (`loadCandidateEvents` lines 516-538) | ✅ (specialist flag writes) | **N/A** — fail-safe pattern, not race-vulnerable |
| `ct-specialist-dispatcher` | ✅ (lines 63-71, hot-event scan) | ❌ (only dispatches, doesn't write) | **N/A** — dispatcher only |
| `ct-detector-*` (10 detectors) | ❌ (zero `ct_scored_flow` references) | ✅ (each writes own flags) | **N/A** — independent of score table |
| `ct-eod-summary`, `ct-tape-reader`, `ct-slack-digest` | ✅ | ❌ | **N/A** — read-only consumers |

**Why specialist paths are N/A even though they read score:**

specialistRunner's `loadCandidateEvents` filters by `score >= wakeupThreshold`. If scorer hasn't run, the filter returns zero rows → specialist sees `no_events` → returns `skip_reason='no_events'` → **no flag written**. Same for `ct-specialist-dispatcher` — empty hot-event list → `reason='no_hot_events'` → no specialist invocation.

**The race here is a missed-fire, not a wrong-fire.** The original race writes a flag with bad data; specialist paths just fail to fire. Specialists ALSO have their own cron retry on the next wakeup (~6 min later), by which point the scorer has caught up. Net effect: at most one delayed wakeup per ticker. Acceptable.

**Why detectors are N/A:**

All 10 `ct-detector-*` functions read their OWN data sources (flow_alerts, OI snapshots, ticker snapshots, gamma, etc.) and write flags directly. None read `ct_scored_flow`. The score-race class doesn't reach them.

## False premises checked

- **"10 score-writers" hypothesis from earlier scoping:** misread. The grep for `ct_scored_flow` references included read-only consumers (eod-summary, tape-reader, slack-digest). The actual at-risk pattern (read score → write flag) appears in only 1 function: `ct-signature-watcher`.
- **Detector flag-writes might race:** they don't, because they don't read `ct_scored_flow.score`.
- **Specialist paths might race:** they fail-safe (missed-fire on race, not wrong-fire).

## Audit confidence

- All `supabase/functions/ct-*/index.ts` files grep'd for both `ct_scored_flow` and `ct_flags`.
- Inline-producer fix verified at line 485-500 of `ct-signature-watcher`.
- `ct_score_existing_flow` RPC exists per migration 20260423000027.
- ct-signature-watcher cron schedule preflights `ct_score_existing_flow` (per commit `f5f2c4e`).

## Net

**Class kill complete.** No fix required tonight. P0 #3 can be archived — keep this audit report as the structural evidence for next time someone asks "did the score-race fix land everywhere?"

**Future-proofing:** if a new flag-writing function is added that reads `ct_scored_flow.score`, the author MUST replicate the inline-producer pattern from `ct-signature-watcher:485-500`. Worth a short comment in `_shared/uwClient.ts` or a CLAUDE.md gotcha.

**Adjacent observation:** the inline-producer recovery in `ct-signature-watcher` adds modest latency only when score is null. Healthy guarantee. Could be extracted into a shared helper (`_shared/scoreRecovery.ts`) if a second consumer ever needs it. Not needed today.
