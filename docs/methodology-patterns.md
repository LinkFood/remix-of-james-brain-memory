# Methodology patterns — Co-Trader

Index of methodology errors and audit lessons that have bitten this project. Append entries here when an audit conclusion turned out to be wrong because of *how* the audit was conducted, not because of bad data. Sub-sections by pattern; each instance dated and linked to source decisions/runbooks.

---

## audit-frame-mismatch — "this surface is broken" was actually "this join is missing"

When an audit produces a conclusion of the form *"system X is broken / under-graded / missing data,"* verify against ALL related upstream tables BEFORE accepting the conclusion. Auditing surface-level signals (a materialized view's row count, a UI page's chip number, a slice cell's settled_n) only tells you what made it through to that surface — it does NOT tell you whether the data exists upstream and was simply never joined or never queried.

**Why this matters:** the audit conclusion drives what gets built next. If the conclusion is "X is broken, build a fix for X," but the actual problem is "X is fine, the surface just didn't include it," the build is wasted effort *and* the real issue (the join gap) stays invisible.

### Instance — 2026-05-02 forensic post-op corpus thinness

**The audit conclusion (Phase 4 of forensic corpus build):** "98.3% of flags are ungraded — slice cells stay tiny — grader doesn't cover detector-fired flags. Track 1 priority: extend grader coverage."

**The actual fact (discovered during Track 1 Phase A archeology):** `ct_flag_grades` already had **1,407 graded rows** at the time of the original audit, including coverage of all sources (specialist + signature + detector_alarm + james_star). The grader had been writing them for weeks via `ct-flag-grader` (cron `*/30 13-20 * * 1-5`). The forensic corpus MV simply never joined to that table. It joined only to `ct_specialist_grade_axes` (90 rows, specialist-only).

**Conclusion that should have come out of the original audit:** "The MV is missing a join. Add LEFT JOIN ct_flag_grades and the corpus thinness self-resolves." That fix took 3 hours instead of 1-3 days.

**Sub-pattern — surface-vs-substrate confusion.** The audit looked at the surface (`ct_flag_analysis_corpus.blended_verdict IS NULL`) and concluded the substrate (the grader) was broken. The substrate was fine; the *projection* of the substrate into the surface was incomplete. Always check: when an audit says "X is missing," ask "missing from where?" — if the answer is "missing from this view / this UI / this slice," the next question is "is it missing from the source-of-truth tables too?"

**Class diagnostic question for future audits:** *"If the data exists somewhere in the database, would my current audit query find it?"* If the answer is "only if it's in the view I'm looking at" — your audit has a coverage gap. Run a parallel `count(*) from <upstream_table>` before concluding the system is broken.

**Linked artifacts:**
- Phase 4 audit conclusion: `docs/calibration/2026-05-02-corpus-baseline-and-first-slices.md` ("Bottleneck: grader only covers source='specialist'; 5,165 detector-fired flags ungraded.")
- Phase A archeology: `docs/decisions/2026-05-02-grader-coverage-extension-paths.md` ("Killer find — ct_flag_grades has 1,407 rows.")
- Path B execution: `supabase/migrations/20260502070000_corpus_unified_verdict.sql`
- Resolution: settled corpus rows 68 → 1,322 in 3 hours. 1 of 7 prior captured patterns survived; 6 were small-sample artifacts; 4 new robust patterns surfaced (puts -21pp on n=431 etc.).

---

## ET-vs-UTC-bucketing — caller-cadence vs budget-vs-cap mixed silently

See `docs/LINKJAC_COTRADER_PLAYBOOK.md` LB8 closure (2026-05-02) and `feedback_utc_vs_et_caller_cadence` memory entry. Convention: caller-cadence questions group by UTC clock-day; budget-vs-cap by ET session_date; never silently mix.

This sits here as a sibling pattern — both errors share the "auditor framed the question against a metric whose underlying bucketing wasn't what they assumed it was."

### Instance — 2026-05-02 LB8 16.3% claim refuted

`ct_uw_usage.session_date` is ET-bucketed. Caller-cadence audits naive-grouping on it misattribute UTC↔ET boundary spillover. `ct-historical-quote-backfill` was tagged "16.3% mid-week share" via that bucketing; under correct UTC-clock-day grouping the number was **0% mid-week, 4.31% Friday-share, 100% UTC↔ET spillover**.

Same class of error: a metric returned a number; the auditor read the number; the number was technically correct under the metric's actual bucketing but wrong for the question being asked.

---

## brief-author-premise-error — the brief specifies a fix that empirically doesn't address the cause

When a brief proposes a specific solution shape ("parallelize," "add a cache," "add a column"), the brief's author has implicitly performed a mental audit: they think they know the cause, and they've written the fix that addresses that supposed cause. **Phase A's job includes verifying the brief's premise, not just executing toward the brief's specified Phase B.** If Phase A surfaces that the brief's diagnosis was wrong, the right move is to reframe Phase B around the actual cause — even if that means shipping something the brief never mentioned.

**Why this matters:** the brief author is reasoning under uncertainty. When the audit produces empirical evidence that contradicts the brief's premise, executing the brief verbatim ships a non-fix while the real bottleneck stays open.

**Diagnostic question to ask in every Phase A:** *"Does my measurement support the brief's implicit causal model? Or am I about to build a fix for the wrong cause?"*

### Instance — 2026-05-05 MCP v1.1 brief proposed parallelization; the cause was a legacy serial block

**The brief premise:** "Parallelize organ fetches via Promise.all so wall-clock latency tracks the slowest single organ rather than the sum of all 11." Implicit causal model: organs run serially today and parallelization will sum→max-out the latency.

**Phase A measurement (per `docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md`):**
- single-organ call: 11.5–14s wall-clock
- all-11-organs call: 11.8–12.6s wall-clock
- delta between "one organ" and "all eleven": ~zero
- inner organ work via Promise.all: ~500ms aggregate (already parallel)

The empirical signature said: *fixed-cost prefix swamping variable-cost suffix.* The actual cause was the LEGACY flat-fields block at `claudeReadSurface.ts:835-1907` running ~50 sequential `await supabase.from(...)` queries unconditionally before the parallel organ work, regardless of `audience` / `tickerFocus` / `organs` whitelist.

**Conclusion that should have come out of the brief:** Phase B's primary lever is `BrainOpts.skipLegacyFlatFields = true` for MCP calls, NOT parallelization. Parallelization would have shipped a non-fix.

**What Phase A did right:** ran a per-organ timing harness instead of trusting the brief's diagnosis. The harness numbers immediately surfaced "single ≈ all" → fixed-cost prefix → not an organ-fan-out problem.

**Class diagnostic question for future audits:** *"Did I measure the thing the brief assumes is broken, or did I plan to fix it without confirming the cause?"* If you're about to write Phase B without an empirical measurement validating the brief's causal model, slow down.

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md` (per-organ timing harness output, fixed-cost-prefix diagnosis, locked target 3000ms p95)
- Reframed Phase B build: this PR
- Sibling instance — `feedback_local_mcp_vs_in_region_latency_gap.md` correctly identified network RTT as a major contributor; Phase A here added the second component (legacy block)

---

## tooling-classifier-false-positive — a class-kill CI script misframes valid code as broken

A class-kill tool (CI grep, linter, schema-drift detector) classifies code into "OK" and "broken" by some discriminator. When the discriminator is over-broad — matches valid patterns the tool didn't anticipate — the tool produces false-positive "broken" labels. The naive response is to allowlist the false positives or "fix" the valid code. The right response is to **refine the discriminator** so the tool stops mis-classifying.

**Sibling but distinct from `brief-author-premise-error`:** that pattern is about a brief proposing the wrong fix. This pattern is about a tool flagging valid code as broken. Both are caught by audit-first ("verify the brief / verify the flag before acting"), but the class-kill is different — refine the discriminator instead of redesign the work.

**Diagnostic question:** *"When my classifier flags X as broken, is X actually broken — or did the classifier match a valid pattern it didn't anticipate?"*

### Instance — 2026-05-05 dumps "orphan table" CI grep false positive

**The flag (B4 CI grep, born from the distill-principles audit):** `scripts/check_supabase_table_refs.sh` greps every `.from('<TABLE>')` reference in `supabase/functions/`, cross-checks against the live PostgREST schema, fails the build on orphans. First run flagged `dumps` and `messages` as orphans — both allowlisted with rationale comments pending separate diagnose-then-fix audits.

**Phase A diagnosis on `dumps`:** all 3 references in `supabase/functions/` are `supabase.storage.from('dumps')` — calls against a Supabase **Storage bucket**, not a Postgres table. Bucket created 2026-01-23 via migrations `20260123031958` / `044532` / `051355`, serving uploads/signed-URLs/classify-content vision/delete-all-user-data deletion continuously since. **Zero silent failures.**

**The classifier's failure mode:** the regex `\.from\(['"][a-zA-Z_][a-zA-Z0-9_]*['"]\)` matches `.from('dumps')` regardless of what's chained before. The Supabase JS SDK exposes `.from()` on TWO different clients — the Postgres client (`supabase.from('table')`) and the Storage client (`supabase.storage.from('bucket')`). Same method name, completely different namespaces. The regex couldn't tell them apart.

**Class kill:** added `scripts/_extract_table_refs.awk` that tracks the previous line per-file. Skips the current `.from(...)` if either the same line contains `.storage.from` OR the previous line ends with `.storage` (the multi-line chained-call pattern that all 3 dumps references used). Allowlist trimmed from 2 entries to 1 (`messages` retained, since its references are NOT `.storage.from(...)` — different shape, different pending audit).

**Bonus payoff:** discriminator tightening is permanent — any future `.storage.from(<bucket>)` is correctly ignored without operator action. Allowlist stays small and focused on real false-positives (e.g., RLS-filtered tables) instead of accumulating discriminator-weakness exemptions.

**What audit-first prevented:** the naive "fix" path was either (a) leave `dumps` perma-allowlisted forever, or (b) delete the `from('dumps')` lines as dead code. Both would have either accumulated allowlist debt OR broken working storage operations. Phase A's diagnose-first surfaced the actual cause (Storage vs Postgres ambiguity) before any fix was attempted.

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-05-dumps-orphan-phase-a.md`
- Phase B fix: this PR (`scripts/_extract_table_refs.awk` + `scripts/check_supabase_table_refs.sh` regex tightening + allowlist trim)
- Sibling pattern: `brief-author-premise-error` (above) — same audit-first discipline, different shape

**Class diagnostic question for future audits:** *"My CI / linter / schema check is flagging X as broken. Before I fix X or allowlist it, can I tighten the classifier so X stops being flagged at all?"* If yes — that's the structural fix; the allowlist becomes a small list of genuine special cases instead of a graveyard of classifier-weakness exemptions.

---

## brief-author-premise-empirical-verification — pre-flag empirical claims as verify-in-Phase-A, not as premise

A brief that embeds an empirical claim ("we get N events per cycle," "the cadence is X minutes," "tickers cluster as a class," "the response time is Y ms") performs an implicit measurement at the time of writing. That measurement may have been correct then, may have been wrong then, may have drifted since. **Phase A's first job is to verify those empirical claims against current state — not to treat them as premises.** When a Phase A skips this step, the audit's downstream conclusions inherit the wrongness silently.

**Sub-pattern of `brief-author-premise-error`** — that pattern covers the brief proposing a wrong fix; this one specifically covers the brief embedding wrong empirical claims that the audit then carries forward as ground truth.

**Diagnostic question for every Phase A:** *"Which empirical claims does this brief make? Have I verified each one against current state, or am I assuming the brief was right?"* If unverified — verify before any analysis that depends on the claim.

**Brief-construction discipline (proposed):** every brief embedding empirical claims should explicitly tag them — e.g., *"Premises (verify in Phase A): cadence ≈ N min, event count ≈ M/cycle, threshold currently X."* Phase A confirms each before treating as load-bearing.

### Instance — 2026-05-06 D2 brief embedded "10 wakeups/hour at 6-min cadence" — actual is 1/hour

**The brief premise:** "Specialist wakeup is every 6 min during RTH = ~10 wakeups/hour per ticker. Brief expects ~10 attempts/hour at 6-min cadence."

**Phase A measurement (per `docs/audit/2026-05-06-d2-escalation-A1-cadence-framing.md`):** Pulled `cron.job` directly via `get_cron_status` RPC. Each per-ticker specialist has its own cron at a unique staggered minute past the hour:

```
ct-specialist-spy       0  13-20 * * 1-5    (HH:00)
ct-specialist-qqq       6  13-20 * * 1-5    (HH:06)
ct-specialist-iwm      12  13-20 * * 1-5    (HH:12)
ct-specialist-aapl     18  13-20 * * 1-5    (HH:18)
ct-specialist-msft     24  13-20 * * 1-5    (HH:24)
ct-specialist-googl    30  13-20 * * 1-5    (HH:30)
ct-specialist-amzn     36  13-20 * * 1-5    (HH:36)
ct-specialist-meta     42  13-20 * * 1-5    (HH:42)
ct-specialist-nvda     48  13-20 * * 1-5    (HH:48)
ct-specialist-tsla     54  13-20 * * 1-5    (HH:54)
ct-specialist-dispatcher  */5  13-20 * * 1-5  (every 5 min — DISPATCHER, not per-ticker fire)
```

**Empirical max wakeups/ticker/RTH-hour = 1.** Hard ceiling. The brief likely conflated dispatcher cadence (5 min) with specialist cadence (60 min).

**Conclusion that should have come out of the brief:** "Specialist wakeup is every hour per ticker. Single-RTH-hour acceptance criterion is necessarily 1-sample-per-ticker — too noisy for distribution-shape conclusions. Multi-day baseline required for meaningful sample size." That reframing led directly to the multi-day acceptance discipline (next sub-section).

**Class diagnostic question for future Phase As:** *"Does the brief embed an empirical claim about how often / how much / how many? Did I verify the claim before reasoning from it?"*

### Instance — 2026-05-06 morning MCP v1.1 brief embedded "8k token target" — actual ≈ 32k

**The brief premise:** "Composed organ payload should fit ~8k tokens for terminal-Claude consumption."

**Phase A measurement (per `docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md`):** Real-data composition produces ~32k tokens. Composition: `news_causality` 6k + `detector` 5k + `event_recency` 4k + `tape` 2k + others trivial.

**Honest deviation acknowledgment:** the v1.1 ship documented this 8k vs 32k gap explicitly in the README rather than truncating to fit the brief's number. Brief premise was wrong; reality won.

**Sibling pattern observation:** this session has produced TWO such instances (cadence + token target). When a brief embeds an empirical claim, the rate of those claims being subtly wrong has been ~50% this session. The discipline isn't "trust the brief author less" — it's "make the verification step explicit and standard."

**Linked artifacts:**
- Cadence Phase A: `docs/audit/2026-05-06-d2-escalation-A1-cadence-framing.md`
- MCP v1.1 token Phase A: `docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md`
- Companion sub-pattern (next): multi-day acceptance criterion

---

## single-sample-acceptance-window — single-day verification on low-cadence systems is structural noise

When the system being verified produces ≤10 data points per day per measurement axis, single-day acceptance criteria are **structurally noisy.** A single sample falls anywhere in the underlying distribution; the right verification axis is multi-day cumulative, not within-window count.

**This is the operational counterpart of `brief-author-premise-empirical-verification`.** That pattern says: verify the brief's empirical premises before reasoning from them. This one says: when the system's measurement cadence is sparse, verify acceptance over a window that allows the sample distribution to settle.

**Decision rule (proposed):** if `expected_samples_per_acceptance_window < 10`, the acceptance window is too short. Extend to 3-5 trading days minimum, or restate acceptance in terms of distribution shape over a multi-day window (e.g., "p75 of conviction ≥ recalibrated_threshold over 7d").

**Diagnostic question for future ship-acceptance briefs:** *"How many independent samples does my acceptance window produce? If ≤10, am I verifying noise or signal?"*

### Instance — 2026-05-06 D2 single-day acceptance produced 1-sample-per-ticker artifacts

**The acceptance criterion:** "Each of NVDA/MSFT/AAPL must have ≥1 fire within first hour of RTH at recalibrated thresholds 50/55/55."

**The empirical reality:** specialist cron fires once per hour per ticker. First RTH hour = 1 wakeup per ticker. Each wakeup either fires (1 if conviction ≥ threshold) or doesn't (0). **Acceptance criterion was effectively a Bernoulli trial per ticker — a single coin flip determining D2 acceptance.**

**Today's results:**
- AAPL: 1 wakeup, conviction 76, fired. ✓
- NVDA: 1 wakeup, conviction 42 < threshold 50, didn't fire. ✗ "ESCALATE"
- MSFT: 1 wakeup, events_considered=0, didn't even score. ✗ "ESCALATE"

**Multi-day re-read** (per A2):
- NVDA 7-day p75=62 > threshold 50. **D2 recalibration was structurally adequate** — today was a single-sample low-mode artifact.
- MSFT requires Phase A.5 (different cause) — multi-day evidence would have already surfaced this.

**Conclusion:** D2 single-hour acceptance was technically correct under the brief's prescribed criterion, but produced an "ESCALATE" verdict that **multi-day re-reading would have nuanced or reversed** for NVDA. The escalation cost ~2-3 hours of Phase A.5 work that wouldn't have been needed under a 3-5-day acceptance window.

**Future D-shape acceptance discipline:** restate as "fires per ticker per N RTH days at recalibrated threshold ≥ baseline" or "p75 of conviction at recalibrated threshold > threshold over 7d." Single-hour verification is reserved for systems with high cadence (≥10 samples per acceptance window per axis) — specialist scoring is not such a system.

**Linked artifacts:**
- D2 verification queries: `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-d2-verification-queries.md`
- A1 cadence Phase A: `docs/audit/2026-05-06-d2-escalation-A1-cadence-framing.md`
- A2 NVDA 7-day distribution: `docs/audit/2026-05-06-d2-escalation-A2-nvda-conviction-distribution.md`

**Class diagnostic question:** *"How many samples per ticker per acceptance window do I get? If 1, what's the multi-day equivalent acceptance criterion that captures the distribution rather than a single coin flip?"*

---

## symptom-level-grouping-hides-cause-level-differences — multiple tickers/components flagged together can have distinct underlying causes

When an audit produces a finding that groups multiple entities (tickers, services, components) by a shared symptom — "these N things are all silent / failing / under-performing" — the implicit assumption is that they share a cause. Often they don't. Each entity's cause should be verified independently before treating the group as a single class.

**Sub-pattern of `brief-author-premise-error`** — symptom-level grouping is itself a kind of premise that the brief carries forward as if it were a cause-level grouping.

**Diagnostic question:** *"This finding groups N entities together. Have I verified each entity's cause independently, or am I assuming they share a cause because they share a symptom?"*

### Instance — 2026-05-06 morning heatmap "5/8 missing" framed as one cause, was actually two compounding filters + sign-flip

**The framing:** "/tape heatmap skips front-week buckets. 5/8 missing, smallest DTE shown is 5/15." Implicit causal model: one filter is dropping the 5/8 bucket.

**Phase A measurement (per `docs/audit/2026-05-06-flow-heatmap-front-week-buckets-phase-a.md`):**
- 5/8 IS in top-3 for 5 of 10 watchlist tickers (NVDA/MSFT/META/TSLA/QQQ).
- 5/8 NOT in top-3 for 5 of 10 (AAPL/GOOGL/AMZN/SPY/IWM).
- The "missing" pattern was true for half the watchlist.
- Cause was **two compounding filters**: `p_include_0dte: false` (suppresses 0DTE flow) AND `DEFAULT_CAP=3` (only top-3 stacks).
- Plus AAPL's 5/8 bucket FLIPPED SIGN with 0DTE included (-$733k bearish → +$922k bullish without).

**One symptom (5/8 missing). Multiple causes (filter + cap + sign-flip risk on AAPL specifically).**

### Instance — 2026-05-06 afternoon "4-ticker silent class" framed as one cause, was actually three classes

**The framing:** "GOOGL/AMZN/META/MSFT silent specialists — different cause than threshold-bound NVDA/AAPL." Implicit: these 4 share a single upstream-event-starvation cause.

**Phase A measurement (per `docs/audit/2026-05-06-d2-escalation-A3-silent-specialist-class.md`):**

| ticker | class | cause |
|---|---|---|
| MSFT | C1 (double-failure) | event-starvation upstream + extreme threshold-fragility (gap -17) |
| GOOGL | C2 (marginal) | gap +2 above threshold |
| AMZN | C2 (marginal) | gap +2 above threshold |
| META | C2.5 (mildly fragile) | gap -2 below threshold |

**Plus per A3.K1**, MSFT's C1 framing was further refined — its upstream "starvation" is actually cron-window-vs-event-clustering misalignment, NOT MSFT-specific data starvation. So the C1 class is actually shared with all tickers (cron timing matters); MSFT is just the most-affected by the misalignment.

**Three symptoms (no events / marginal / mildly fragile) hidden inside one "silent specialist class" framing.**

**Operational pattern:** when a brief uses words like "silent class," "broken set," "underperforming group" — list each entity individually and verify the cause per-entity before treating as a class. The class label often pre-commits the audit to a single fix shape that doesn't fit each entity equally.

**Linked artifacts:**
- Heatmap Phase A: `docs/audit/2026-05-06-flow-heatmap-front-week-buckets-phase-a.md`
- A3 silent-specialist Phase A: `docs/audit/2026-05-06-d2-escalation-A3-silent-specialist-class.md`
- A3.K1 MSFT refinement: `docs/audit/2026-05-06-d2-escalation-A3K1-msft-upstream-investigation.md`

**Class diagnostic question:** *"Does my finding group multiple entities under one label? If so — is that label a SYMPTOM (what's observed) or a CAUSE (verified mechanism)? If symptom, list each entity and verify cause per-entity before any structural fix."*

---

## structured-zero-misread-as-null — `0` / `false` semantically encodes "absence detected" but read side interprets as "data missing"

Producer-side code correctly writes `0` / `false` / structured-empty values to indicate *"I checked the source and found nothing."* The read-side consumer (UI, organ, downstream service, captain reading the payload) sees those structured zeros and interprets them as *"data missing / null / broken / not yet computed."* The semantic gap is at the **read shape**, not at the producer or the data — both ends are operating correctly under their own contracts. The friction is that the read shape doesn't expose enough state to distinguish *"absence found"* from *"absence not yet measured"* from *"absence due to missing data."*

**Sibling but distinct from `silent-no-op write` class.** Silent-no-op = producer never wrote (table absent / column wrong / cron disabled). Structured-zero-misread = producer wrote correctly, the value `0` is the truth, but the read shape can't carry the nuance.

**Sibling but distinct from `field-name drift`.** That's read path expects column X, producer writes column Y, mismatch silent. Here all field names line up; the values are correct; the *interpretation* drifts.

**Diagnostic question for every read-shape design:** *"When my read returns null / zero / false, which of these does it mean: (a) no signal exists in the source [absence found], (b) source not yet computed [absence not yet measured], (c) source missing entirely [absence due to data gap], (d) producer never wrote [silent-no-op]? If the read shape can't distinguish (a)-(d), the read shape needs an explicit status field."*

**Class kill shape:** add a `status` enum to the read shape. Concrete shapes:

```typescript
// Bad — read can't tell why moved is false
{ moved: false, flow_hits_15min: 0 }

// Good — read knows why
{ status: 'analyzed_no_flow_found', moved: false, flow_hits_15min: 0 }
{ status: 'pending_analysis', moved: null, flow_hits_15min: null }
{ status: 'source_missing', moved: null, flow_hits_15min: null, error: 'news_id not in ct_news_causality' }
{ status: 'producer_never_ran', moved: null, ... }  // (the silent-no-op case captured explicitly)
```

The status field collapses (a)-(d) into named states the captain (or any consumer) can distinguish at read time. The values themselves stay the same; the disambiguation lives in the new field.

**Pair-pattern with `brief-author-premise-empirical-verification`:** when a brief reports *"X is null in the read"*, Phase A's first job is to verify the empirical claim. Today's instance was the third confirmation in one session that *"absent-looking value"* may actually be *"correctly-computed-zero meaning absent"* — a different state. The forcing function compounds: verify the framing AND verify the read-shape semantics.

### Instance — 2026-05-06 punchlist 🔴 #2 null causality framing-error close

**The trading-session punchlist claim:** *"news_causality `.causality` fields all null in cotrader MCP output. Captain cannot trust news linkage to flow when the linking field is consistently empty."*

**Phase A verification (per `docs/audit/2026-05-06-punchlist-2-null-causality-phase-a.md`):**
- 7-day population: **563 rows** in `ct_news_causality`. `Prefer: count=exact` confirmed full population.
- **Zero rows are actually null.** All 563 rows have structured values.
- **110 rows (19.5%)** carry `moved=true` with non-zero `flow_hits_15min` and `flow_premium_15min` — real causality data.
- **453 rows (80.5%)** carry `moved=false` with `flow_hits_15min=0`, `flow_premium_15min=0` — deliberate "no flow within 15min after news event" outputs.

**The 80.5% are the structured zeros.** Not null. Not write failures. The producer (`ct-news-causality` cron `*/15 13-20 RTH weekdays`, last_run 17:00:01Z status=succeeded, continuous writes for 19+ days since 2026-04-17) is healthy and writing correctly.

**Cause classification:** Cases A/B/C/D (silent-no-op-write sub-classes) — **NONE apply.**

**The trading session likely sampled recent items that all happened to be `moved=false` and read the structured zeros as "null."** Conflated absence-detected with data-missing.

**Fix shape:** none on the producer. The structural fix lives in the **read shape** — fold into 🟡#6 per-organ as_of meta-fix, adding `status: 'analyzed' | 'pending' | 'none_found'` to the `news_causality` organ output. Captain reads `status='analyzed'` + `moved=false` + `flow_hits=0` and knows: *the system checked and found no flow,* not *the system is broken.*

**Class diagnostic question for future audits:** *"Before declaring a read-layer field 'null/missing/broken,' did I empirically verify the producer wrote the value? If yes, did I check whether the value is `0`/`false`/structured-empty rather than actually null? If the value is structured-zero, the framing is interpretation-error, not write-error."*

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-06-punchlist-2-null-causality-phase-a.md`
- Sibling Phase A (same session, same shape): `docs/audit/2026-05-06-punchlist-1-spy-drift-phase-a.md`
- Pair-pattern: `brief-author-premise-empirical-verification` (above) — Phase A's first step verifies framing
- Sibling pattern: `silent-no-op-write` class (referenced in `feedback_silent_failure_detection_pattern.md` memory entry) — distinct from this pattern in mechanism

### Session-level observation (2026-05-06)

The `symptom-level-grouping-hides-cause-level-differences` pattern (codified above) and this `structured-zero-misread-as-null` pattern share a deeper root: **the read shape doesn't expose enough state for the consumer to disambiguate.** A reader sees three values for "the same close" (🔴#1 SPY drift) and assumes they should match, because the read shape doesn't declare each value's window. A reader sees `moved=false, flow_hits=0` (🔴#2 null causality) and assumes it's broken, because the read shape doesn't declare whether the producer ran.

**Both patterns are read-shape-poverty-class.** The structural class kill across both is per-organ metadata: every organ surface should declare `as_of`, `window`, `source`, `status`. With those four fields, both patterns become structurally impossible — the captain (or any consumer) reads the metadata and disambiguates without guessing.

**Forcing function:** when designing or reviewing a read shape, ask explicitly *"What does a `null` / `0` / `false` mean here? Can the consumer distinguish 'measured absent' from 'not measured' from 'measurement broken'?"* If not — add the status field before the shape ships.

---

## build-time-type-gate-not-applied-to-runtime-target — CI's TS check skips the runtime where the bug actually runs

Frontend tooling (Vite, tsc) type-checks the `src/` tree. Production runtime code that lives outside the frontend tsconfig graph (Deno edge functions, isolated scripts, build tooling, etc.) escapes the type-check entirely. A bug class that the frontend's tsc would catch (use-before-declaration, missing import, type mismatch) reaches production unchecked.

**Sibling but distinct from `silent-no-op write` and `false-cause inference`.** Those patterns are about runtime behaviors. This pattern is about a CI gate that *exists* but doesn't *cover* the surface where the bug landed. The gate is a partial gate; the runtime escapes.

**Diagnostic question for every CI workflow review:** *"Does this gate apply to every runtime target the repo deploys? If we have N deploy surfaces (frontend, edge functions, scripts), do we have N type-check coverage gates? If not — which surface ships untypechecked?"*

**Class kill shape:** add a per-runtime type-check gate. For Deno edge functions: `deno check supabase/functions/**/*.ts`. For frontend: `tsc --noEmit` against the frontend tsconfig. For Node scripts: `tsc --noEmit` against the script tsconfig. Each surface owns its check; CI fails on any.

**Allowlist pattern (when the gate uncovers pre-existing technical debt):** lock current per-file error counts as baselines. New errors in clean files fail. Regressions in allowlisted files fail. Improvements (count drops below baseline) trigger a warning to amend the allowlist. Same shape as `scripts/check_supabase_table_refs.allowlist` (B4 class kill from 2026-05-05). Allowlist-then-trim is preferable to fix-first when the existing technical debt is large enough to delay the discipline-shipping work.

### Instance — 2026-05-06 PR #25 ReferenceError reached production because Deno files were outside frontend tsconfig

**The bug:** PR #25 added `...(consumerName ? { consumerName } : {})` at `supabase/functions/_shared/claudeReadSurface.ts:1983`. The variable `consumerName` was not declared in scope (declared only at line 2011 inside an inner async telemetry block). In Deno's strict ES modules, the read at line 1983 throws `ReferenceError: consumerName is not defined`.

**Why CI didn't catch it:** the only TypeScript gate was `npx tsc --noEmit` against `tsconfig.app.json`, which scopes type-checking to `src/`. The supabase/functions/ tree was outside the compilation graph. `npm run build` (Vite) also restricted to `src/`. **The Deno runtime had zero type-check coverage in CI.**

**Production impact (per PR #27 retro):** 18 redeployed brain-consumer functions silently dark from 12:14Z to ~15:00Z (~2h45m). Captain caught the failure via the /tape page; PR #26's one-line fix landed only after the production failure surfaced.

**Empirical verification of the class kill:** locally reverting PR #26's fix and running `deno check supabase/functions/_shared/claudeReadSurface.ts` produces exactly:

```
TS2304 [ERROR]: Cannot find name 'consumerName'.
TS18004 [ERROR]: No value exists in scope for the shorthand property 'consumerName'.
```

These are exactly the error class that should have failed CI before merge. Ship-time validation of `scripts/check_deno_types.sh` confirms 30 regressions (including the root in `_shared/claudeReadSurface.ts`) are detected when the bug is reverted.

**The gate:** `scripts/check_deno_types.sh` — runs `deno check` against every TS file under `supabase/functions/` (except `jac-watch-scheduler` which has `npm:` imports requiring nodeModulesDir setup, deferred). Compares per-file error counts against `scripts/check_deno_types.allowlist` baseline. New errors in clean files OR regressions in allowlisted files fail CI.

**Pre-existing technical debt at ship:** 170 type errors across 43 files. Mostly inherited from 7 root-cause errors in `_shared/*` (each consumer that imports a broken shared module sees the propagated error). Allowlisted at current per-file counts; future PRs cannot regress. Fixing the 170 is a separate cleanup project, not the discipline-shipping work.

**Class diagnostic question for future workflow reviews:** *"Every time a new runtime target is added to the repo (new Deno function, new script, new framework), does CI have a type-check gate for that runtime? If not — when does the next PR-#25-class bug ship through it?"*

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-06-pr25-reference-error-incident-retro.md`
- Hotfix: PR #26 (`_shared/claudeReadSurface.ts:1962` — declared `consumerName` from `opts`)
- Class kill A: this PR (`scripts/check_deno_types.sh` + allowlist + CI step)
- Sibling pattern: B4 grep allowlist (`scripts/check_supabase_table_refs.allowlist`) — same allowlist-then-trim discipline applied to a different class

**Sibling-pattern observation:** today's session shipped TWO discipline-prevention CI gates of similar shape: B4 grep (writes-to-nonexistent-table) and class-kill-A deno check (use-before-declaration / type-error class). Both follow the **per-runtime-target gate** principle: each surface owns a check; CI's gate must equal the runtime's surface. As more runtime targets land in the repo (MCP servers, future agent tooling), the same per-runtime-gate discipline should be applied at each addition.

---

## audit-verification-surface-mismatch — audit verifies layer adjacent to but not same as symptom layer

A symptom report names a specific layer where the consumer sees the problem (UI surface, MCP organ output, /tape page, downstream consumer). The audit responding to the symptom verifies a *different* layer — usually upstream (producer table, cron status, ingestion pipeline). The audit's findings are technically correct at the layer it verified, but don't address the symptom layer. The conclusion ships as "resolved" while the consumer-visible symptom persists.

**Sibling but distinct from `audit-frame-mismatch`** (top of file). That one catches *"system X is broken vs join is missing"* — same layer, different diagnosis. This one catches *"layer Y is healthy vs the symptom is at layer X"* — different layers entirely.

**Sibling but distinct from `brief-author-premise-error`** (above). That catches *"the brief assumed wrong cause."* This catches *"the audit verified the wrong layer."* The brief may have been correctly framed; the audit drifted.

**Diagnostic question for every Phase A:** *"My symptom report is at surface X. Have I verified at surface X, or only at upstream Y? If only at Y, my conclusion may be correct at Y but disconnected from the actual symptom at X."*

**Class kill shape:** every Phase A's first step is *verify-the-audit-checks-the-symptom-layer.* This is **meta to `verify-the-warden's-own-framing`** — that one verifies the claim (is the metric correct?); this one verifies that the verification is happening at the right surface. Operationally: if the symptom is "consumer sees X," the Phase A pulls **the consumer's actual output**, not just upstream state. Producer-side verification is a sibling check, not a substitute for symptom-layer verification.

### Instance — 2026-05-06 PR #31 verified ct_news_causality producer; trading session symptom was at MCP organ output

**The symptom:** trading session 2026-05-06 13:45 ET reported `news_causality.causality` fields all null in cotrader MCP output for SPY (10/10 items literally null at the organ surface).

**PR #31's audit (per `docs/audit/2026-05-06-punchlist-2-null-causality-phase-a.md`):** verified `ct_news_causality` producer table — found structured zeros (110 of 563 rows `moved=true` with real data, 453 of 563 `moved=false, flow_hits=0` structured zeros, **0 actually null**). Concluded "all null framing wrong, producer healthy, close as transient."

**The verdict was correct at producer layer.** Producer was healthy. Cron firing every 15 min. Continuous writes for 19+ days.

**But the consumer surface said null.** Trading session did NOT misread structured zero as null — they pulled MCP organ output where the value really WAS null. The audit's verdict didn't address that surface.

**Phase A.7 (per `docs/audit/2026-05-06-phase-a-7-news-causality-projection-layer.md`) traced the projection layer:** `newsCausalityContext.ts:207` hardcodes `causality: EMPTY_CAUSALITY` (all-null) for every `ct_breaking_news` item by design — causality is third-layer in the architecture (firehose → analyses → causality), keyed only to `ct_news_analyses.id`. Breaking news firehose items NEVER get causality data. The helper's null projection is architecturally correct; the read shape conflates "by-design no causality possible" with "data missing" with "structured zero."

**The discipline catch:** PR #31 audited the *producer* (correct at that layer); the symptom was at the *organ output* (different layer, different finding). PR #31's verdict + Phase A.7's bridge = both correct, but only together do they address the symptom. PR #31 alone closed the punchlist item prematurely; the trading session's **MCP-as-diagnostic-readout** pull is what reopened it.

**Class diagnostic question for future audits:** *"Where does the consumer see the problem? Did I pull the consumer's actual output as part of my audit, or did I only verify upstream state? If only upstream — my finding is at the wrong layer. Re-do the audit at the symptom's actual surface."*

**Linked artifacts:**
- PR #31 (producer-layer verification): `docs/audit/2026-05-06-punchlist-2-null-causality-phase-a.md`
- PR #34 / Phase A.7 (projection-layer bridge): `docs/audit/2026-05-06-phase-a-7-news-causality-projection-layer.md`
- PR #32 (paired sub-pattern entry): `structured-zero-misread-as-null` — both patterns surfaced in same chain of investigations

### Session-level observation (2026-05-06) — meta-discipline emerging

This pattern surfaces a meta-discipline beyond `verify-the-warden's-own-framing`:

- **`verify-the-warden's-own-framing`** verifies the *claim* (is the metric correct?). Caught 5 false premises today (cache_hit error column, P3 key-divergence, cadence 10/hour wrong, 4-ticker grouping, MSFT C1 framing).
- **`audit-verification-surface-mismatch`** verifies the *audit*, recursively (is the verification at the right surface?). Caught PR #31's resolution-as-misframed verdict that didn't reach the consumer-surface symptom.

Both disciplines compound. Each new Phase A inherits both: verify the claim AND verify the verification is at the right surface. **The symptom-surface check should fire FIRST**, before any upstream verification — because if the audit is at the wrong layer, the upstream finding is irrelevant to the symptom regardless of correctness.

**Forcing function:** Phase A's opening step is "name the consumer's surface where the symptom appears, and pull data from that surface." If the symptom is "MCP returns null," pull MCP output. If symptom is "/tape page frozen," pull /tape page state (or its underlying read query). Producer-side verification is the SECOND step, not the first.

---

## brief-empirical-claim-undercount — brief reports a count; Phase A's recount finds the count is bigger

A brief frames a problem with an empirical count: *"X of Y instances are affected,"* *"N functions need redeploy,"* *"M rows are missing."* Phase A re-counts empirically and finds the actual number is **larger** than the brief framed. The brief's narrower count drove a smaller-scope fix conception; Phase A's recount expands the scope and reframes the structural shape.

**Sub-pattern of `brief-author-premise-empirical-verification`** (above). That pattern says *"verify the brief's empirical claims before treating as premise."* This one is the specific common failure mode: the brief **undercounts**. Overcount is theoretically possible but rare in practice — briefs tend to underestimate scope because the brief author hasn't yet done the full audit.

**Diagnostic question for every Phase A:** *"Did the brief give me a count? Have I empirically re-counted? If the brief's number is 'about N' or 'roughly M' — re-count first, treat the brief's count as hypothesis-pending-verification."*

**Forcing function:** any Phase A opening step that includes the words "verify the brief's empirical premises" should explicitly include re-counting. The cheapest possible operation is a `count(*)` query; the cost of skipping it is a wrong-scoped fix.

### Instance — 2026-05-06 PR #40 B-2 _shared/ consumer detection — brief said 11 missing, Phase A found 18

**The brief premise (per PR #37 class kill B Phase A):** "the workflow's `_shared/` change-detection deploys 7 hardcoded consumers; **11 of the 18 brain consumers are missing** from auto-deploy."

**Phase A measurement (per `docs/audit/2026-05-06-b-2-shared-consumer-detection-phase-a.md`):**
- Hardcoded list (deploy-functions.yml:30): 7 consumers — all JAC-side (jac-dispatcher, jac-code-agent, jac-research-agent, jac-save-agent, jac-search-agent, assistant-chat, smart-save).
- Empirical `_shared/claudeReadSurface.ts` importers: **18 ct-* brain consumers**.
- **Overlap between hardcoded-7 and actual-18: ZERO.** Hardcoded 7 don't import claudeReadSurface.ts at all.
- Actual gap: **18 of 18 missing**, not 11.

The brief framed "11 missing" — partial overcount of the hardcoded 7 against an assumed overlap with the 18. Reality: the two sets are disjoint. The hardcoded list wasn't an outdated subset of the consumer set; it was a legacy JAC-side fixture from before the brain-consumer surface existed.

**The brief's Option (a) "expand to 18 hardcoded" recommendation** was too narrow. Phase A confirmed Option (b) auto-discover via grep import-graph as the structural fix — drift-proof, replaces the legacy 7-list entirely.

**Class diagnostic question for future audits:** *"My brief gave me a count. Was the count empirically re-verified, or was it a structural-knowledge estimate? If the latter — re-count via `grep -rln` or `count(*)` before reasoning from it."*

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-06-b-2-shared-consumer-detection-phase-a.md`
- Phase B implementation: PR #42 (`.github/workflows/deploy-functions.yml`)
- Sibling instance — PR #37 class kill B Phase A surfaced 2 deploy-mechanism defects beyond the brief's "missing probe" framing (instance #16, see `audit-frame-mismatch` family)

---

## brief-framed-wrong-computational-layer — brief names a cause hypothesis; Phase A finds the symptom is real but caused at a different computational layer

A brief observes a symptom (e.g., "X is missing in MCP output") and proposes a cause hypothesis (e.g., "directional-signing CASE chain produces NULL aggressor"). Phase A's empirical investigation finds the symptom is real but the brief's framed cause is at the **wrong computational layer** — the math at the brief's named layer is correct, but the symptom emerges at a downstream/upstream layer the brief didn't consider.

**Sub-pattern of `brief-author-premise-error`** (above). The brief proposed a fix shape based on the assumed cause; the cause was at a different layer entirely. Even if the fix-shape proposed for the brief's layer worked perfectly, it wouldn't address the symptom.

**Sibling but distinct from `audit-verification-surface-mismatch`** (above). That pattern catches *audit verifies layer adjacent to symptom layer.* This one catches *brief frames cause at layer where the math is correct; the actual cause is at a different layer.* Both are about layer mismatches, but at different stages — the brief's framing vs the audit's verification surface.

**Diagnostic question for every Phase A:** *"Did the brief frame the cause at a specific computational layer? Empirically replicate the math at that layer first. If the math is correct at that layer, the cause is at a different layer — find which one."*

**Forcing function:** when a brief names a specific cause mechanism (CASE chain, threshold filter, RPC logic, projection step), Phase A's first step is **empirical replication of the math at that layer**. If the math is correct, the brief is pointing at the wrong layer. Search adjacent layers (read shape, downstream filter, upstream join, decay weight, etc.) for the actual cause.

### Instance — 2026-05-06 PR #41 IWM front-week — brief said NULL aggressor; actual cause is balanced flow + strict filter

**The brief premise (per PR #38 queue doc):** "directional-signing CASE chain produces NULL aggressor for IWM front-week" — implying the RPC's CASE chain at `ct_flow_heatmap_live` returns NULL for IWM rows because is_ask/is_bid are NULL and the fallback chain doesn't resolve.

**Phase A measurement (per `docs/audit/2026-05-06-iwm-front-week-directional-signing-phase-a.md`):**
- Replicated the RPC's CASE chain in Python over the actual IWM front-week sample (n=30).
- All 30 rows have `alert_rule LIKE 'RepeatedHits%'`.
- The CASE chain step 4 (`WHEN b.alert_rule LIKE 'RepeatedHits%' THEN 'ask'`) fires for all rows.
- **Aggressor='ask' for all 30 rows. Zero NULL aggressor cases.** The math at the CASE chain layer is correct.
- The actual cause: balanced calls-bullish + puts-bearish. Calls (ask-aggressive) sign positive; puts (ask-aggressive) sign negative. Net signed magnitude after decay weighting ≈ $19,958 — well below the `p_min_premium=100000` filter. **Bucket correctly hidden — there's volume but no actionable directional signal.**

The brief's framed cause (NULL aggressor) doesn't exist. The math at the CASE chain is correct. The symptom (no IWM 5/8 bucket) emerges at the downstream **filter layer** ($100k min_premium against signed magnitude), not at the CASE chain.

**Implication for fix shape:** the brief's cause-hypothesis fix would have been "fix the CASE chain to handle NULL aggressor." That fix would do nothing because no NULL aggressor exists. The actual fix shape is at the **read-layer integrity bundle** — add a `status: 'balanced_flow_no_directional_signal'` field to the OrganStatus enum so the captain knows when an organ correctly hides a bucket due to balanced flow vs when data is missing.

**Class diagnostic question for future audits:** *"The brief points at a specific layer (X) as the cause. Have I replicated the math at layer X empirically? If the math is correct at X, the cause is at layer Y — and my fix needs to address Y, not X."*

**Sibling-pattern observation:** this session's session-level methodology arc keeps surfacing layer-mismatches at audit:
- Instance #15 (audit-verification-surface-mismatch): audit verifies adjacent layer to symptom
- Instance #18 (this): brief frames cause at wrong computational layer
- Instance #16 (deploy-mechanism-defects-uncovered): brief assumed layer worked; Phase A found N defects at that layer

**Three different "wrong layer" failure modes**, all caught by audit-first discipline applied recursively. The forcing function is the same: empirical replication at every layer the brief or audit claims is correct, before treating that layer as resolved.

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-06-iwm-front-week-directional-signing-phase-a.md`
- Queue doc that activated this audit: `docs/audit/2026-05-06-iwm-front-week-directional-signing-queued.md` (PR #38)
- Sibling pattern: `audit-verification-surface-mismatch` (above) — same family, different stage of the audit pipeline
- Read-layer integrity bundle scope (the fix-shape destination): `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md`

---

## string-pattern-match-instead-of-real-parser — system parses structured input via regex/string-match where a real parser is needed

A system accepts structured input (SQL, code, JSON, YAML, expressions) and validates / transforms / dispatches based on it. Instead of using a real parser for that input format, the system uses string-pattern matching (`grep`, `LIKE`, regex, `.includes()`, etc.). The matcher works correctly for the common case but misses edge cases that the real parser handles trivially: comments, string literals, escaped characters, nested structures, quote-aware tokenization.

**Sibling but distinct from `tooling-classifier-false-positive`** (above). That pattern catches *"my classifier flagged valid code as broken"* — it's about the classifier's discriminator being too broad. This pattern catches *"my parser missed a structural feature that a real parser would have handled"* — it's about the wrong tool being used for the job entirely.

**Sibling family also with `warden-filter-completeness-class`** (referenced via `feedback_warden_filter_completeness_class.md` memory entry from PR #23). That pattern catches *"semantic state in non-structural string field is brittle to prefix accretion."* This pattern is the parsing-side counterpart: even when the storage shape is structurally clean, the consumer that READS the structured field via string-match instead of a parser can still mis-handle edge cases.

**Diagnostic question for any system that consumes structured input:** *"Am I parsing this with a real parser, or am I string-matching? If string-matching, which structural features (comments, strings, nesting, escaping) does my matcher miss compared to the real parser?"*

**Class kill shape:** parse the structured input with the real parser at the boundary. For SQL: use PG's own parser (e.g., `pg_parse_query` extension or `EXPLAIN`-based validation). For TypeScript: use `tsc` or `deno check`. For YAML: use a real YAML library, not regex. The real parser handles edge cases by definition; string-match never will.

**Pragmatic fix when structural fix is too costly:** scrub the input of characters that trip the matcher. This is a patch, not a class kill — it shifts the brittleness from *"matcher misses edge cases"* to *"input authors must avoid specific characters."* Both shapes accumulate (next case finds a new edge), so the structural fix should be the eventual destination.

### Instance — 2026-05-06 PR #46 warden invariant SQL string-match flagged inline-comment semicolons

**The bug:** PR #44 shipped `brain_consumer_freshness_rth` warden invariant. The SQL body contained inline comments inside a CTE VALUES clause:

```sql
covered_consumers(consumer_name, threshold_hours) AS (
  VALUES
    ('ct-tape-reader',             0.5),    -- cron */10 RTH
    ('ct-curiosity',               2.0),    -- periodic; some gaps OK
    ('ct-news-sweep',              2.0),    -- periodic; gaps OK
    ('ct-alert-post-mortem',       4.0),    -- alert-driven; longer tolerance
    ('ct-daily-brief',            26.0)     -- daily ~14 UTC; 26h covers 1 day + 2h slack
)
```

**The error at first warden run (19:30Z):**
```
last_status: error
last_error: invariant queries must be a single statement (no mid-query semicolon)
```

**The cause:** the warden's `ct-system-warden` edge function validates each invariant's `query_sql` for "single statement only" via string-pattern matching for `;`. It flagged the 4 semicolons in the inline comments (`some gaps OK`, etc.) as mid-query terminators, even though they're inside `--` comment lines that PG's parser would correctly skip.

**The hotfix (PR #46):** UPDATE the invariant with the same logic, comment text rewritten to remove SQL-meaningful punctuation. Zero semicolons in stored `query_sql` post-fix. Pragmatic patch — the bug class returns next time someone writes a comment with `;` or any future punctuation the matcher trips on.

**The structural fix (queued, separate Phase A → Phase B):**
- Use PG's own parser to validate invariant SQL before storing
- Implementation: add a `BEFORE INSERT/UPDATE` trigger on `ct_invariants` that wraps the SQL in `EXPLAIN` (or `PREPARE`) inside a savepoint and rolls back regardless. If PG raises a parse error, the trigger raises. If PG accepts it, the trigger commits.
- The "single statement" check becomes `pg_query_parse(...)` returning exactly one statement node, not a regex on `;`.
- This is the right tool for the job: PG itself decides what's valid SQL.

**Class diagnostic question for future audits:** *"Is this system using string-match where a real parser is available? If yes — what edge case is going to trip it? If you can't enumerate the edge cases, you have proof that string-match is the wrong tool."*

**Sibling-pattern observation across today's session:** This makes **THREE separate string-pattern-match issues** today:
- Morning's PR #23 cache_hit-error-column-purity (warden filter `error NOT LIKE 'warning:%' AND NOT LIKE 'skipped:%'` — adding 4th `NOT LIKE` exclusion would have repeated the pattern, the structural fix was "don't put semantic state in error column")
- Today's PR #46 (this) — warden's "single statement" check via `;` pattern-match instead of real parser
- B4 CI grep at PR #20 morning (`.from('<TABLE>')` regex couldn't tell `.storage.from(...)` from PG `.from(...)` — patched via discriminator tightening; structural fix would be a real TS parser)

**Three string-pattern-match issues** in one session points to a sustained pattern. The discipline going forward: when designing a new validator/parser/dispatcher that consumes structured input, default to a real parser over string-match. Cost is higher than regex but discipline is structural.

**Linked artifacts:**
- Initial ship: PR #44 — `supabase/migrations/20260506200000_b_4_brain_consumer_freshness_warden.sql`
- Hotfix: PR #46 — `supabase/migrations/20260506201500_b_4_brain_consumer_freshness_warden_hotfix.sql`
- Sibling pattern: `feedback_warden_filter_completeness_class.md` (memory entry from PR #23 morning class kill)
- Sibling instance: `tooling-classifier-false-positive` section above (PR #20 dumps storage-vs-table discriminator tightening)
- Future structural fix queued: warden invariant SQL parser-based validation Phase A (separate per-PR approval)

---

# Audit-First Verification Runbook (class kill D)

**Purpose:** reusable procedure synthesizing the sub-patterns above into a single reference future Phase A authors apply at the opening step of every investigation. Pattern entries describe the *what*; this runbook describes the *how*.

**When to apply:** every Phase A audit's opening move. No exceptions. Even when the finding looks obvious. Even under time pressure. Even when the audit is "just confirming what we already know." See Section 8 for cost-of-skip analysis.

**Origin:** 2026-05-06 session caught 11 false premises before any fix shipped (instances #9 through #20, excluding rejected #14). The discipline that caught them — verify-the-warden's-own-framing applied recursively at three independent verification surfaces — is now codified here as standard procedure rather than re-derived ad hoc per audit.

---

## Section 1 — Mandatory opening step for every Phase A

**Verify-the-warden's-own-framing first.** Before bucketing causes, proposing fixes, or expanding scope, verify the source-finding's own framing against ground truth. Three sub-steps applied in order:

### 1a) Reproduce the finding empirically

Don't trust the report. Re-pull the data the report was based on; confirm the symptom is current, not transient. The cheapest possible verification — a single query, a fresh MCP read, a vault read — runs first.

### 1b) Verify the framing aligns with ground truth at the SAME LAYER as the reported symptom

The `audit-verification-surface-mismatch` defense (sub-pattern above). If the punchlist says *"MCP organ output shows null,"* verify at MCP organ output layer — NOT just at producer table layer. The audit's verification surface must match the symptom's surface.

**Forcing function:** name the consumer's surface where the symptom appears, and pull data from THAT surface as the first action. Producer-side verification is the SECOND step, not the first.

### 1c) Verify the empirical claims hold without methodology artifacts

Common methodology artifacts to check before treating any finding as load-bearing:

- **Hidden row caps** (sub-pattern: `feedback_audit_query_hidden_row_caps.md`) — PostgREST default 1000-row response, RPC payload cap, edge function timeout. Use `Prefer: count=exact` + read `Content-Range` header.
- **Sample bias** — single-day vs multi-day windows on low-cadence systems produce structurally noisy single-coin-flips (`single-sample-acceptance-window`).
- **Schema drift** — column names, enum values, types may have changed. Check actual schema before reasoning about field semantics.
- **Timezone bucketing** — UTC vs ET mismatch (`ET-vs-UTC-bucketing` family above). Caller-cadence by UTC; budget-vs-cap by ET; never silently mix.
- **Apples-to-oranges comparisons** — different windows, different symbols, different units (today's PR #34 SPY drift instance).

If any (1a)/(1b)/(1c) reveals state different from the finding's framing, **surface as the first finding and re-scope.** Don't proceed to cause analysis under wrong framing.

---

## Section 2 — Decision rule for bucketing (multi-entity findings)

When a Phase A surfaces a multi-entity finding ("5 specialists are silent" / "10 SPY items are null" / "11 of 18 functions are missing from auto-deploy"), apply the **`symptom-level-grouping-hides-cause-level-differences`** discipline (sub-pattern above).

**Decompose before classifying.** List each entity individually before treating the class label as cause. Verify per-entity:

- Same symptom value or range?
- Same upstream conditions?
- Same downstream impact?

If any per-entity check reveals differences, the finding is a class-of-multiple-causes, not one cause. **Decompose into per-cause framing before proposing fix shape.**

Today's instances — class label "X" decomposed into N distinct sub-classes:
- Heatmap "5/8 missing" → two compounding filters + AAPL sign-flip risk
- "4-ticker silent class" → 3 distinct classes (C1/C2/C2.5)
- MSFT-as-C1 (A3 framing) → cron-window-misalignment shared with all tickers (A3.K1 refinement)
- "11 missing of 18" → 18 of 18 missing (instance #17 brief-empirical-claim-undercount)

---

## Section 3 — Decision rule for empirical claims in briefs

When a brief embeds an empirical claim ("expected fire rate ≈ 10/hour," "total premium ≈ $30M," "p75 score ≈ 60," "11 functions missing"), pre-flag it as **`brief-author-premise-empirical-verification`** required (sub-pattern above).

**Phase A must verify the claim against raw data before treating as load-bearing premise.**

Today's session demonstrated this is non-negotiable:
- Brief said "10 wakeups/hour at 6-min cadence." Actual: 1/hour at 60-min cadence (cron schedule per ticker).
- Brief said "8k token target for MCP composed organ." Actual: ~32k tokens (5/5 v1.1 instance).
- Brief said "11 of 18 brain consumers missing from auto-deploy." Actual: 18 of 18 missing (zero overlap with hardcoded 7).

**Brief-author-premise-error rate this session: ~50% on briefs touching empirical claims.** Without the verification step, multiple Phase A's would have shipped fixes against wrong-cause assumptions.

**Forcing function:** every count-claim, frequency-claim, distribution-claim re-counted via `grep -rln` / `count(*)` / direct query before reasoning from it.

---

## Section 4 — Decision rule for "absence-of-X" findings

When a Phase A produces an "absence" finding (no rows present, no signal detected, no fires happening, X is missing), check for the **hidden-row-caps + sample-bias** family before treating absence as real:

- **PostgREST default response cap** — 1000 rows. Use `Prefer: count=exact` to confirm result set size.
- **Supabase RPC payload limits** — ~6MB JSON. Large RPCs return arrays may be silently truncated.
- **Edge function timeouts** — 150s. Long-running aggregations return partial state.
- **`.range()` pagination is ASC-default** — no `order=`, the rows seen are first-N, not most-recent.
- **Sample window scope** — RTH-only vs 24h vs week-long produces different absence pictures.

If any hidden cap is plausible, **re-run with explicit cap-handling before treating absence as real.** "Absent from sample" ≠ "absent from population."

Today's instance: §5 specialist absence finding was a 1000-row cap artifact — narrowed window query showed 9 of 10 specialists firing nominally (instance #9).

---

## Section 5 — Decision rule for "null" findings on integer/boolean fields

When a Phase A surfaces "field is null," distinguish four cases per the **`structured-zero-misread-as-null`** sub-class (above):

| read value | meaning | semantic |
|---|---|---|
| `populated` | real data present | informative |
| `no_signal_detected` | producer wrote `0`/`false` to indicate detected absence | **informative** ("we looked, found nothing") |
| `not_yet_analyzed` | producer hasn't run for this row | uninformative |
| `data_missing` | row exists but field is genuinely unpopulated | uninformative |

The **null vs zero distinction matters**: zero means *we looked and found nothing*; null means *we don't know*.

**Read-side semantic gap is fixable via per-organ status field**, not via producer change. See `audit-verification-surface-mismatch` sub-pattern + read-layer integrity bundle scope for the structural fix.

---

## Section 6 — Three-layer discipline-stack reference

Today's session demonstrated the audit-first discipline operates at three independent verification surfaces, layered:

| Layer | When it fires | Catches |
|---|---|---|
| **Verify-the-warden's-own-framing** | At Phase A opening step | Symptoms misframed at the source layer; sample-bias artifacts; methodology errors in producer/audit queries. Section 1 above. |
| **Audit-verification-surface-mismatch** | Post-Phase-A, meta-check | Audit verified one layer (e.g., producer) but symptom is at different layer (e.g., consumer). Today's instance #15 (PR #34 A.7) caught PR #31's producer-only verification missing the consumer-surface symptom. |
| **MCP-as-diagnostic-readout** | At consumer layer during normal use | Real symptoms surfacing post-resolution; structural gaps the audit didn't see. Trading-session pulls the MCP as an observability surface. Today's instance #15 was reopened by trading-session pull after PR #31 closed prematurely. |

**Each layer catches what the previous layer missed by virtue of operating at a different verification surface.** Skip any one layer and at least one false-fix ships per session.

Today's discipline-stack catch count: **9 catches at Phase A opening + 1 at meta-check + 1 at consumer layer = 11 total.** Plus 2 catches at PR-author layer (instance #11 P3 false-cause; instance #15 reopened) = **all 11 instances caught before fix.**

---

## Section 7 — Common false-cause shapes to watch for

Pre-check Phase A framings against these recurring shapes from the methodology-errors-cascade catalog (full list as sub-patterns above):

- **#9 Hidden row-caps producing false absence findings** (PostgREST 1000-cap)
- **#10 Partial-frame symptoms from consumers** (heatmap "5/8 missing")
- **#11 False-cause cascade based on memory-shape-matching** (P3 service-role-key)
- **#12 Symptom-level grouping at multiple layers** ("4-ticker silent class")
- **#13 Nested Phase A own-framing** (A3.K1 refining A3)
- **#15 Audit-verification-surface-mismatch** (audit at adjacent layer to symptom)
- **#16 Deploy-mechanism-defects-uncovered** (brief assumed surrounding system worked)
- **#17 Brief-empirical-claim-undercount** (count too low, scope expands at Phase A)
- **#18 Brief-framed-wrong-computational-layer** (math correct at named layer; cause at different layer)
- **#19 String-pattern-match-instead-of-real-parser** (regex misses edge cases parser handles)
- **#20 Pre-existing-bug-masked-by-defensive-fallback** (`|| true` swallows the bug it was meant to handle)

Plus earlier-session shapes: D1 timing-vs-score-drift, v1.1 parallelization-vs-flat-fields, LB8 timezone-bucketing, Pulse-DORMANT-via-grep-heuristic.

**If a Phase A's framing matches any of these shapes, the verification step is mandatory regardless of how confident the finding looks.**

---

## Section 8 — When to apply the runbook + cost-of-skip analysis

**Apply at every Phase A audit's opening move.** Even when:
- The finding looks obvious
- Time pressure is high
- The audit is "just confirming what we already know"
- The cause hypothesis matches an adjacent memory entry exactly

**Cost-of-apply:** small, ~5-30 min per audit depending on scope. The cheapest possible verification first — a query, a vault read, a sample-data pull.

**Cost-of-skip (today's session, empirically measured):**
- 11 non-fixes that would have shipped without the discipline (one per false premise caught at audit)
- 1 P0-class incident that would have been left unfixed despite captain awareness (instance #11 service-role-key false hypothesis would have shipped Path 3 env-override; actual cause ReferenceError would have stayed broken)
- Unbounded surface area of future-confusion accumulating (each non-fix that ships becomes a methodology error future authors must un-frame)

**When in doubt: apply the discipline. The discipline is the moat.**

---

## Runbook recursion — applying the runbook to itself

This runbook itself underwent verify-the-warden's-own-framing at the Phase A opening step:

**1a) Reproduce the catch count empirically.** Brief stated "8 false premises caught today." Phase A enumerated instances #9 through #20 (excluding rejected #14) = 11 catches. **Brief-empirical-claim-undercount in real-time** (instance #17 surfaced again, recursively). Runbook reflects empirical 11, not brief's 8.

**1b) Verify the three-layer discipline-stack framing.** Today's catches mapped to layers:
- 9 catches at Phase A opening step (verify-the-warden's-own-framing)
- 1 catch at meta-check (PR #34 A.7 audit-verification-surface-mismatch)
- 1 catch at consumer layer (trading-session reopened PR #31 verdict)

Three-layer framing holds empirically. Each layer catches what the others miss.

**1c) Verify naming consistency.** All cross-referenced sub-patterns checked against current methodology-patterns.md entries — names match (`brief-author-premise-error`, `structured-zero-misread-as-null`, `audit-verification-surface-mismatch`, etc.).

**Forcing function recursion:** the runbook describes practices; the runbook's writing applied those practices to its own claims. Recursion is correct, not over-engineered.

---

# End of Audit-First Verification Runbook

---

## pre-existing-bug-masked-by-defensive-fallback — defensive `|| true` / `2>/dev/null` swallows the bug it was meant to handle

A defensive fallback is added to a step that might fail for legitimate reasons (e.g., file not found, command unavailable, pipeline error). The fallback returns a benign default (empty string, zero, "unknown"). Downstream code branches on the default as if it represented "nothing happened" rather than "something failed silently." Bug introduced upstream of the fallback is then invisible — the system proceeds as if everything is fine, when actually the upstream condition is not what the author intended.

**Sibling but distinct from `silent-no-op-write`** (referenced via `feedback_silent_failure_detection_pattern.md`). That pattern catches *producer wrote nothing*; this pattern catches *defensive fallback in the consumer interpreted "wrote nothing" as "nothing to do."* Both are silent-failure shapes; this one is at the consumer's defensive-handling layer.

**Sibling but distinct from `string-pattern-match-instead-of-real-parser`** (above). That pattern catches *parser uses wrong tool*; this pattern catches *defensive code uses the right tool but interprets failures as success-equivalent*.

**Diagnostic question for any defensive fallback:** *"When this fallback fires, can the downstream code distinguish 'fallback fired because input was empty' from 'fallback fired because upstream failed'? If not, the fallback is masking failures rather than handling them."*

**Class kill shape:** when adding a defensive fallback, also add an explicit signal to the consumer that the fallback fired. Either:

- **Fail loud option:** remove the fallback. Let the upstream failure propagate. Surface the actual error.
- **Tagged-fallback option:** use a sentinel value the downstream code can detect (e.g., `"FALLBACK_EMPTY"` instead of `""`). Downstream branches on the sentinel and surfaces the unusual state.
- **Logged-fallback option:** keep the fallback but log/echo when it fires. Downstream code still sees empty/zero, but the log surfaces the abnormal state for forensic investigation.

The bug is NOT the fallback itself — it's the consumer treating the fallback output identically to the legitimate-empty case.

### Instance — 2026-05-06 PR #49 deploy-functions checkout fetch-depth=1 default + `2>/dev/null || echo ""` defensive

**The bug:** `.github/workflows/deploy-functions.yml` had:

```bash
CHANGED=$(git diff --name-only HEAD~1 HEAD -- supabase/functions/ 2>/dev/null || echo "")
```

`actions/checkout@v4` defaulted to `fetch-depth: 1`. Only the current commit was checked out; `HEAD~1` did not exist. `git diff HEAD~1 HEAD` errored. The `2>/dev/null || echo ""` defensive caught the error and produced empty string. SLUGS computed as empty. Downstream steps:

```yaml
- name: Deploy functions
  if: steps.changes.outputs.slugs != ''
```

Saw empty SLUGS, **skipped silently.** CI conclusion: success. Nothing actually deployed.

**Why this surfaced today:** the bug had been silently passing CI for an unknown duration. Surfaced **at the moment** when B-1 / B-2 / B-3 (PRs #39 / #42 / #48) shipped — those checks all depend on the deploy step actually running. With the deploy step skipped, the new defenses had nothing to defend, and the workflow conclusion remained spuriously green.

**Empirical evidence (PR #48 deploy run logs):**
- Workflow triggered (path filter matched: `supabase/functions/**`)
- Detect step ran, computed `Deploying:` (empty after the colon)
- Deploy step `if` evaluated false, skipped
- Probe step `if` evaluated false, skipped
- Workflow conclusion: success

The fact that NOTHING DEPLOYED was the spurious-success signal.

**The fix (PR #49):** `actions/checkout@v4` with `fetch-depth: 2`. One-line YAML addition. Just enough git history for `HEAD~1` to exist. The `2>/dev/null || echo ""` fallback stays for now (defense against unanticipated git-state edge cases) but it's no longer masking the fetch-depth bug because there's no error for it to swallow.

**Class diagnostic question for future workflow / script reviews:** *"Is there a defensive `|| true` / `2>/dev/null` / `.catch()` / try-catch returning a benign default? When it fires, does the downstream code branch on a value indistinguishable from the legitimate-empty case? If yes — the defensive fallback is potentially masking a bug."*

**Sibling-pattern observation across today's session:** This is the **fourth string-pattern-or-defensive-fallback issue** today:
- PR #23 cache_hit-error-column-purity (warden's `NOT LIKE` filter accretion)
- PR #46 warden-SQL `;` regex flagging inline-comment semicolons
- PR #20 morning B4 grep `.from()` regex couldn't tell Postgres `.from()` from Storage `.from()`
- PR #49 (this) `2>/dev/null || echo ""` masking fetch-depth bug

**Four same-shape catches in one session.** Pattern is *real-tool-or-fail-loud* — when handling structured input or potentially-failing operations, default to the real tool (parser, error propagation) rather than the brittle convenience (regex, defensive default). The structural fix path: replace string-match with parser; replace silent-default with explicit signal or fail-loud.

**Linked artifacts:**
- Hotfix: PR #49 — `.github/workflows/deploy-functions.yml` (`fetch-depth: 2` added)
- Surfacing PR run: deploy run databaseId 25457538716 (PR #48 merge) — `Deploying:` empty, deploy + probe skipped
- Sibling family: `string-pattern-match-instead-of-real-parser` (above)
- Sibling family: `silent-no-op-write` class (referenced in `feedback_silent_failure_detection_pattern.md`)

---

## false-cause forcing function (class kill E discipline)

When a fix PR proposes a cause, **enumerate orthogonal evidence** before treating the cause as load-bearing. When a hypothesis matches the shape of an adjacent memory entry (a `feedback_*.md` file, a prior incident retro, a known failure-class catalog entry), treat the match as a **narrowing heuristic, not a confirmation.** The matching shape biases the reasoner toward premature conclusion — making the verification step MORE important, not less.

**Forcing function shape:** `.github/PULL_REQUEST_TEMPLATE.md` requires a Diagnosis section for fix PRs. Authors enumerate hypothesis + supporting evidence + adjacent memory matches + orthogonal verification + orthogonal evidence collected. Mechanical — can't ship a fix PR without filling it (or marking n/a for non-cause-dependent fixes).

**Pair with `verify-the-warden's-own-framing` discipline:** that pattern fires at audit-time. This forcing function fires at PR-author time. Different temporal layers — together they catch false-cause inference at multiple stages of the workflow.

### Instance — 2026-05-06 P0 service-role-key false-cause hypothesis (instance #11)

The exact shape this forcing function exists to prevent:

- **Symptom:** 18 edge functions returning 401 Unauthorized post-redeploy
- **Adjacent memory match:** `feedback_service_role_key_rotation.md` documenting key-rotation as a known cause class
- **Hypothesis-shaped-as-conclusion:** "must be service-role-key rotation" — adopted as load-bearing premise
- **What caught it (Path 1, manual):** vault read produced empirical evidence that the rotation hypothesis was wrong. Actual cause was a `ReferenceError` from PR #25 (instance #11 captured in `docs/audit/2026-05-06-pr25-reference-error-incident-retro.md`)
- **What would have shipped without verification:** Path 3 env-override, a non-fix that would have left the 18 functions still broken AND created vault/env divergence to clean up

The PR template's Diagnosis section makes the orthogonal-verification step **mechanical** — the author MUST enumerate it before submitting. Same forcing-function shape as class kill A's CI gate but at the PR-author layer.

### Companion: verify-before-applying discipline for memory-shape-matched hypotheses

When a Phase A or PR's hypothesis matches an existing `feedback_*.md` entry's documented shape, **the verification step is mandatory regardless of how confident the match looks.** The matching shape is what creates the bias toward premature conclusion. The cheapest verification first — a single query, a vault read, a sample-data pull — catches the false-cause before fix ships.

**Diagnostic question for every fix PR:** *"My hypothesis matches the shape of memory entry X. Have I verified the hypothesis with evidence orthogonal to the matching shape, or am I treating the match as confirmation?"*

**Empirical validation pending:** the forcing function's effectiveness measured by future P0 incident counts. If next P0 catches a false-cause hypothesis at the PR template layer (Diagnosis section reveals missing orthogonal verification), that's structural validation. Until then, the forcing function is a structural discipline pending validation.

### Linked artifacts

- PR template ship: `.github/PULL_REQUEST_TEMPLATE.md` (this PR)
- Original P0 incident retro: `docs/audit/2026-05-06-pr25-reference-error-incident-retro.md`
- Methodology-errors-cascade catalog (full instance list including #11 + #15 + others)
- Sibling discipline: `verify-the-warden's-own-framing` standard Phase A first step (Phase A-time application of the same orthogonal-verification principle)

---

## cadence-anchored-thresholds-for-burst-cron-consumers — bimodal-burst metrics need cadence math, not statistical (p90/median) recipes

When a freshness/staleness invariant measures a consumer that writes on a deterministic cron cadence, the underlying metric is **bimodal-burst**, not continuous-distribution. Many rows arrive in the same second (within-burst inter-arrival ≈ 0); the only meaningful gap is the inter-burst gap, which equals the cron interval. Statistical recipes (`p90`, `median`, `1.5 × median`, rolling percentiles) all collapse to ~0 on this shape because they're dominated by within-burst zeros — using them to set a freshness threshold either silences the invariant entirely (threshold=0 → every healthy second fires nothing) or anchors it nonsensically near zero.

The right threshold is **cadence-anchored**: `cron_interval + 1 warden tick buffer`. The cron interval is the true empirical maximum age in healthy state; the warden tick buffer (typically 30 min for a 30-min warden cadence) gives one-tick slack so a single missed cron run trips the invariant on the next warden sample without false-firing on cadence-edge moments.

**Why this matters:** the wrong instrument silences a bug class structurally. Either (a) the threshold is set below cadence and fires every tick on healthy operation (desensitization-class — see `feedback_warden_threshold_calibration.md` 2026-05-05 calibrate-DOWN case), or (b) the threshold is computed from p90/median and collapses to 0 (silenced-class — invariant exists but never fires). Both shapes defeat the warden's purpose.

**Sub-pattern: phase-keyed thresholds sidestep the burst trap by design.** When the producer's cadence varies across phases (rth / off-hours / weekend / dead-of-night), encoding a different threshold per phase in the SQL `CASE phase.p WHEN ... THEN N` directly mirrors the cadence shape. Two of the 9 24/7 brain-consumer-freshness invariants from commit 16aaeb3 (`consumer_freshness_daily_brief_24x7`, `consumer_freshness_news_sweep_24x7`) use this design and never hit the burst trap. Worth considering for any new freshness invariant where producer cadence is non-uniform across phases.

**Sibling but distinct from `brief-author-premise-error`** (above). That pattern catches *brief proposes a fix shape based on assumed cause; cause is wrong.* This pattern is the formula-recipe variant: *brief pre-specifies a statistical formula for threshold setting; the formula is wrong-instrument for the metric's distribution shape.* The structural fix at the brief-author layer is the same — briefs assert intent (*"recalibrate above empirical healthy baseline"*), not formula (*"use p90 of last 7d"*). Phase A identifies the metric's distribution shape first; the math follows the shape, not the other way around.

**Sibling but distinct from `brief-framed-wrong-computational-layer`** (above). That pattern catches *brief frames cause at wrong layer; math at named layer is correct.* This one catches *brief specifies a statistical recipe; recipe assumes wrong distribution shape.* Both are brief-author-premise variants — different thing the brief got wrong.

**Diagnostic question for every threshold-calibration brief:** *"What's the underlying metric's distribution shape? (a) bimodal-burst from deterministic cron — use cadence + warden tick buffer; (b) continuous from request rate / latency / ratio — use p90 + safety margin; (c) count-of-events with seasonality — use rolling-window percentile per season-bucket. Which shape matches my metric, and does my recipe match the shape?"*

**Class kill shape:** before specifying any threshold-calibration formula, Phase A's first step is **identify the metric's distribution shape empirically**. Pull 7-day telemetry, group rows into bursts by gap >1min boundary, and compute inter-burst median. If inter-burst median > 0 and within-burst median ≈ 0 — bimodal-burst, use cadence math. If the inter-arrival distribution is unimodal continuous — use statistical recipe. The shape comes first, the formula comes second.

### Instance — 2026-05-07 hypothesis_proposer 120 → 270 (Class B Phase B follow-on)

**The brief premise:** "Recalibrate hypothesis_proposer threshold above empirical healthy baseline. Threshold = `max(p90 of last 7 days, 1.5× median)`. Justify the multiplier in migration comment."

**Phase A.1 measurement (per `feedback_warden_threshold_calibration.md` burst-shape sub-pattern):**
- Pulled 7-day `ct_brain_telemetry` for `consumer_name='ct-hypothesis-proposer'`: 176 rows.
- Inter-arrival distribution: median 0.0 min, p90 1.1 min, p95 240.0 min. Ten gaps crossed 120 min (the current threshold), all 240.0–240.1 min — **bimodal-burst signature**.
- Cron cadence: every 4h on UTC 11:00 / 15:00 / 19:00 (within active hours; 4h gap during RTH between 11:00→15:00 and 15:00→19:00 burst pairs).
- `ct_invariant_log` empirical confirmation: today's RTH window 17:30Z=150min (FAIL), 18:00Z=180min (FAIL), 18:30Z=210min (FAIL), 19:00Z=240min (FAIL), 19:30Z=30min (PASS, burst arrived). Threshold 120 fires ~8× per RTH day on healthy operation.

**The brief's recipe applied:** `max(p90, 1.5×median)` = `max(1.1, 0.0)` = **1.1 min**. Setting threshold to 1.1 min would silence the invariant entirely (every within-burst measurement passes; every between-burst gap fires permanently — desensitization-class). The recipe is wrong-instrument for the shape.

**Phase A.2 audit of all 9 24/7 brain-consumer-freshness invariants from commit 16aaeb3:**

| Consumer | Inter-burst cadence | Current threshold | Margin | 48h fires post-deploy | Classification |
|---|---|---|---|---|---|
| ct-alert-post-mortem | 30 min | 240 (uniform) | 8.0× | 0 | continuous-shape, calibrated |
| ct-curiosity | 30 min | 120 (uniform) | 4.0× | 0 | continuous-shape, calibrated |
| ct-daily-brief | 450 min | 1500/1560 (phase-keyed) | 3.3× | 0 | designed-phased |
| ct-hypothesis-health-check | 15 min | 60 (uniform) | 4.0× | 0 | continuous-shape, calibrated |
| **ct-hypothesis-proposer** | **240 min** | **120 (uniform)** | **0.5×** | **4 (max=240)** | **burst-shape, mis-calibrated** |
| ct-news-sweep | 30 min | 120/480/720 (phase-keyed) | 4.0× | 0 | designed-phased |
| ct-self-grader | 120 min | 240 (uniform) | 2.0× | 0 | continuous-shape, calibrated |
| ct-tape-reader | 10 min | 30 (uniform) | 3.0× | 0 | continuous-shape, calibrated |
| ct-watcher | 15 min | 60 (uniform) | 4.0× | 0 | continuous-shape, calibrated |

**Only `hypothesis_proposer` is mis-calibrated.** The other 8 sit at 2-8× margin above empirical cadence with zero false fires. Single-purpose ship per Phase A.2 audit, not blanket multi-target migration.

**Resolution:** threshold 120 → 270 = cron cadence (240) + warden tick buffer (30). Migration `20260510010000_hypothesis_proposer_threshold_recalibration.sql`, commit `8b64f34`. Validation window: 2026-05-08 RTH 13:00-20:00 UTC — old threshold's 8-fire-per-RTH-day pattern should be zero fires.

**Class diagnostic question for future audits:** *"Before recommending a threshold-calibration formula, did Phase A identify the metric's distribution shape? If the shape is bimodal-burst, the formula is `cron_interval + warden_tick_buffer` — not p90 / median / rolling percentiles. The math follows the shape."*

**Sibling-pattern observation across this session's audit-arc:** the brief specified a recipe (`max(p90, 1.5×median)`) that pre-committed to a continuous-distribution assumption. Phase A's first move was to verify the shape, not execute the recipe. The structural fix at the brief-author layer: **briefs assert intent (recalibrate to silence false fires) and ask Phase A to identify the underlying shape; briefs do NOT pre-specify formulas.** The formula is downstream of the shape diagnosis. Same family as `brief-author-premise-error` and `brief-framed-wrong-computational-layer` — different premise the brief got wrong (formula-vs-shape, not cause-vs-effect or layer-vs-layer).

**Linked artifacts:**
- Migration: `supabase/migrations/20260510010000_hypothesis_proposer_threshold_recalibration.sql`
- Commit: `8b64f34` — fix(warden): hypothesis_proposer threshold 120→270 (cadence-anchored)
- Updated memory entry: `feedback_warden_threshold_calibration.md` (sub-pattern: burst-shape consumers added)
- Sibling 16aaeb3: feat(warden): class-kill C Phase B rescoped — 9 24/7 brain-consumer invariants
- Phase-keyed sibling examples in same family: `consumer_freshness_daily_brief_24x7`, `consumer_freshness_news_sweep_24x7`
- Sibling pattern: `brief-author-premise-error` (above) — same family, different premise shape
- Sibling pattern: `brief-framed-wrong-computational-layer` (above) — same family, different premise shape

---

## docs-PR-merge-doesnt-imply-migration-applied — schema_migrations PRIMARY KEY collisions silently no-op

When a migration file's timestamp prefix collides with an already-applied migration on the remote `supabase_migrations.schema_migrations` table, the git merge succeeds (different filenames; no file conflict) but the apply silently no-ops (PRIMARY KEY conflict on version). The migration file lives on main as a load-bearing record but its SQL never ran.

**Why this matters:** trust in "PR is merged" implies "fix is live." For migrations that share a timestamp prefix with another already-applied migration, that implication breaks. The fix sits in main, captain assumes prod is fixed, but the cron table / RPC / schema is unchanged.

### Instance — 2026-05-09 morning slate-clean: ct-flow-ingester apikey fix

**The setup:** PR #70 (`fix/ct-flow-ingester-cron-apikey-fix-2026-05-08`) authored 2026-05-08 evening to add `apikey` header to 3 ct-flow-ingester crons after the 5/07 service-role-key gateway-rewrite incident. Migration filename: `20260510040000_ct_flow_ingester_cron_apikey_fix.sql`. PR sat open over the weekend.

**The collision:** PR #79 / #80 (Flow Butterfly Phase 1) shipped 2026-05-08 with migration `20260510040000_ct_butterfly_cross_events.sql` — SAME timestamp prefix. PR #79/#80 applied to remote. `schema_migrations` row with `version=20260510040000` was inserted.

**The merge:** PR #70 merged 2026-05-09 11:09 UTC during morning slate-clean. Git merge succeeded (different filenames; no file conflict). Vercel deploy succeeded.

**The silent no-op:** Vercel doesn't run migrations. Subsequent `supabase db push` attempts INSERT into `schema_migrations(version=20260510040000, ...)` — fails on PRIMARY KEY. The apikey fix never ran. Cron table on remote DB still has the buggy Authorization-only headers.

**Detection:** `npx supabase migration list` showed:
```
20260510040000 | 20260510040000 | 2026-05-10 04:00:00     <- butterfly (applied)
20260510040000 |                | 2026-05-10 04:00:00     <- apikey-fix (NOT applied)
```

Two local rows with the same timestamp; one with no remote pair. **That's the smell.**

**Fix:** ship a fresh-timestamp re-application (`20260510090000_ct_flow_ingester_cron_apikey_reapply.sql`) with identical idempotent body. The DROP-then-CREATE cron pattern is safe to re-run; if the bug isn't live it's a no-op.

**Process fix to prevent recurrence:** before merging any migration PR, run `npx supabase migration list` and confirm the migration's version doesn't already appear on Remote with a different filename. Or — pre-merge, add a CI check that scans staged migrations for timestamp collisions vs `git ls-tree origin/main supabase/migrations/`.

**Diagnostic question for future:** *"Does this migration's timestamp prefix already exist in remote `schema_migrations`?"* If yes — even if the filename differs — the apply will silently fail. Bump the timestamp before merge.

**Companion class:** `phantom-schema-migrations-record` (PR #80 incident 5/8 — opposite direction: schema_migrations recorded a row but the table didn't actually exist). Both classes share root: trusting `schema_migrations` is dangerous when the migration system's invariants (one row per version, applied = SQL ran) get violated.

**Linked artifacts:**
- Original PR (silent no-op): #70 `fix/ct-flow-ingester-cron-apikey-fix-2026-05-08`
- Re-apply migration: `supabase/migrations/20260510090000_ct_flow_ingester_cron_apikey_reapply.sql`
- Companion phantom-record incident: PR #80 5/8
- Slate-clean session that surfaced this: 2026-05-09 morning

### Instance — 2026-05-09 evening: orphan-on-main blocks fresh `db push`

The same 5/9 morning's incomplete recovery surfaced a second-order fire later the same day. PR #94 (SKIP LOCKED class-kill) shipped a new migration at `20260510100000`. When running `npx supabase db push` post-merge to apply it, the push failed with a duplicate-key error against `schema_migrations` — the orphan PR #70 file (`20260510040000_ct_flow_ingester_cron_apikey_fix.sql`) is still on main alongside PR #79's butterfly file at the same timestamp, and the push tooling apparently re-attempted the apply on the orphan as part of catching up. Recovery: `npx supabase migration repair --status applied 20260510040000` to mark it applied (it's a known historical no-op; the apikey fix itself has been re-shipped via PR #92's fresh-timestamp file), temporarily move the orphan file aside, retry the push for `20260510100000`, restore the orphan file. The orphan file IS load-bearing as a record (it documents what was attempted) and CAN'T be deleted without rewriting history; it now lives as a permanent historical artifact that future `db push` runs route around via the `migration repair` row.

### Class-kill ship — 2026-05-09 evening: CI workflow

Two empirical fires of the same cascade in one day clears the YAGNI bar for write-time prevention. Class-kill ship: `.github/workflows/migration-timestamp-check.yml`. Triggers on `pull_request` against `supabase/migrations/*.sql`. Enumerates timestamps already on `origin/main` via `git ls-tree`, enumerates new-migration timestamps in the PR via `git diff --diff-filter=A`, fails the workflow with an explicit error annotation if any new timestamp collides with an already-present one. The collision does not surface as a git merge conflict (different filenames) so this is the only pre-merge layer that catches it. Pre-existing collisions on main (the PR #70 ↔ PR #79 orphan pair) are NOT flagged — the check is regression-only. Branch protection should add this workflow as a required check once one PR has exercised the rule live.

**Resolution path the rule enforces:** when the workflow fails, the fix is to bump the offending file's timestamp to a value greater than the latest on main and re-push. The rule does not require migration content changes — it only blocks the silently-no-op'ing apply.

**Why this is structural, not patching:** the rule does not catch any individual collision; it catches every future collision. Same shape as Tenet 13 (structural prevention beats validators) applied to the migration-apply layer. The 2026-05-08 mid-day fire was visible only in retrospect; the 2026-05-09 evening fire was visible only via push-failure. The CI rule moves detection to PR-open time.

**Linked artifacts:**
- Workflow file: `.github/workflows/migration-timestamp-check.yml`
- Mid-day instance (orphan blocks push): PR #94 SKIP LOCKED class-kill recovery sequence
- Sibling discipline ship pattern: `.github/workflows/docs-pr-discipline.yml` (PR #57, 2026-05-07)

---

## page-multiplication-violates-no-silos-at-UX-layer

**Pattern:** Tenet 24 ("all systems talk to each other — no silos") is enforced at the substrate layer (`buildClaudeContext` composes all organs, `ct-reflect-to-jac` bridges Co-Trader → JAC, audience-gating per consumer). The discipline does NOT auto-extend to the UX layer. New surfaces ship as new ROUTES (`/alpha`, `/tape-v2`, `/tape-reader`, `/heatmap`, `/pulse`, `/specialists`, `/flags`, `/alarms`, `/eod`, `/eod-report`, `/morning-brief`, `/butterflies`, ...). Each route becomes a silo from the captain's perspective even when the backend is unified.

**Structural shape:** substrate-vs-surface gap. Shipping unified backend (organs + buildClaudeContext + audience filtering) doesn't unify the user experience. Captain's daily glance involves navigating between surfaces; each navigation = a silo cost. Substrate compounds; UX silos fragment.

**Discipline rule:**
1. Every new surface PR explicitly answers: *does this consolidate existing surfaces, or add a new one?* If it adds a new one, what's the consolidation plan?
2. Page count is a metric to watch. Tenet 24 at UX layer = fewer surfaces with more density, not more surfaces with focused alpha each.
3. Command-center pattern (Tape composition surface, locked 2026-05-08 evening) is the canonical shape — one daily-glance surface renders snapshots from every dedicated alpha surface; dedicated pages exist for depth.
4. Top-nav dropdown reflects the canonical command-center route, not all live surfaces.

### Instance — 2026-05-09 afternoon /alpha consolidation gap

After iter #2 of `/alpha` shipped (PRs #88 + #89 + #90 = TapeReaderArc + semantic ClaudesRead + News Causality Matrix), captain observed: `/alpha` is now a THIRD surface alongside `/tape` and `/tape-v2` (plus `/tape-reader`). Originally `/tape-v2` was supposed to consolidate; now `/alpha` sits on top of it. *"We're making more pages, and that's one of our main no-no's. That was the reason for V2 tape."* + *"Even if the backend is not siloed, the user feels like it's getting siloed."*

Consolidation paths flagged (captain decides post-iter-#2-#5 land):
- (a) `/alpha` becomes the new `/tape-v2` (rename + retire `/tape-v2` contents)
- (b) `/alpha` and `/tape-v2` merge into one canonical command-center route
- (c) all three (`/tape`, `/tape-v2`, `/alpha`) collapse to one canonical surface; legacy routes deprecate

Top-nav exposure decision deferred until consolidation pick lands.

**Class diagnostic question for future surface PRs:** *"Does this PR add a new route, or compose into an existing one? If new route, what existing surface(s) would the captain stop visiting once this lands?"* If the answer is none → page-multiplication.

**Sibling patterns:**
- compose-with-the-kernel (kernel-vs-application discipline) — surface-layer analog: compose with the existing canonical surface before adding a new route.
- Tenet 24 (no silos) substrate-level — this entry extends the same discipline to UX.

**Canonical articulation (Cowork-side):** `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` `## Page-multiplication-violates-no-silos-at-UX-layer (2026-05-09 afternoon)` — captures captain's 5/9 afternoon catch + full discipline rule + cross-references to command-center pattern + tape-command-center-snapshot-inventory.

**Linked artifacts:**
- 2026-05-09 evening sync report — empirical motivation
- Cowork-side decisions.md 2026-05-09 afternoon entry — captain's framing + 3 resolution paths
- This alignment PR — codifies in engine-room catalog per cross-catalog rule

---

## substrate-on-table-vs-sibling-table-discrimination — cascade #43

**Pattern:** When a brief calls for "embed table X," verify which sibling table is the LIVE writer. Two tables in the same family can have nearly identical names and overlapping schemas while serving very different roles — one may be the actual producer (the live writer), the other may be dead-on-arrival or vestigial. A brief that doesn't distinguish will write the embed in the wrong place. The wrong-place embed silently never gets queried because consumers read the live table.

**Structural shape:** family-of-tables ambiguity. Naming similarity does not imply functional equivalence. Always verify "which table is the live writer this consumer reads from" before targeting an embed insertion site.

**Discipline rule:** before any substrate ship that adds an `embedding` column to an existing table, run a 3-question check:
1. *Does any current edge function INSERT into this table?* (verify via `git grep`)
2. *Does any consumer SELECT from this table?* (verify via `git grep` + brain organ inventory)
3. *If yes to both, this is the live writer.* If no to either, it's a vestige; the live sibling needs identification.

### Instance — 2026-05-09 Phase 7 specialist substrate Phase A

PR #93 audit Section 2: `ct_specialist_memory` already has an `embedding` column from an earlier scoping pass — but inspecting the codebase found ZERO writers and ZERO consumers. Dead-on-arrival sibling. The live writer + consumer is `ct_specialist_reads` (`specialistRunner` writes; `specialistRecallContext` reads). A naive Phase 7 brief that targeted `ct_specialist_memory` for embedding would have shipped the column on the wrong table; specialists would never have benefited because the recall organ reads `ct_specialist_reads`.

The audit caught the discrimination before any code shipped. Phase 7a now correctly targets `ct_specialist_reads`.

**Class diagnostic question for future audits:** *"Have I verified the live writer + consumer of this table, or am I about to embed a vestigial sibling?"*

**Sibling patterns:**
- audit-frame-mismatch — surface-vs-substrate confusion at the table-identity layer.
- back-anchorability-is-a-feature-precondition — adjacent: "is this column the right shape for the consumer?" Same family of pre-implementation verification.

**Linked artifacts:**
- PR #93 — `docs/audit/2026-05-09-phase-7-specialist-substrate-phase-a.md` Section 2 — original codification.

---

## measurement-window-respect-on-additive-substrate-vs-consumer-change — cascade #44

**Pattern:** During an active measurement window (D2.2 acceptance, D3 experiment, any multi-day-acceptance criterion), distinguish between SUBSTRATE changes (add a column, populate it via write-time embed, leave consumer behavior unchanged) and CONSUMER changes (read the new column, change what the consumer surfaces). Substrate changes are window-safe — zero behavior change to the consumer being measured. Consumer changes are NOT window-safe — they alter the very behavior the measurement window is grading.

**Structural shape:** Tenet 26 (one-structural-change-per-measurement-window) refines into two-tier classification. Additive substrate is structurally distinct from consumer behavior; the discipline applies to the latter, not the former. Naive application of Tenet 26 blocks BOTH; precise application unblocks substrate ships during measurement windows while keeping consumer ships gated until the window closes.

**Discipline rule:** before deferring a ship under a measurement-window guard, ask: *"Does this ship change what the consumer reads, or does it only add substrate the consumer continues to ignore?"* If only substrate (column add + write-time embed + RPC available but not yet called by the consumer): window-safe; ship. If consumer change (the recall organ now queries the new column / the surface now renders the new field): window-blocked; defer to post-window.

### Instance — 2026-05-09 Phase 7 splitting into 7a (substrate) + 7b (consumer)

PR #93 audit Section 8: Phase 7 was originally framed as one ship — "embed `ct_specialist_reads` AND activate semantic recall in `specialistRecallContext`." Naive Tenet 26 application = the entire ship is blocked until D2.2 verdict (5/13) + D3 experiment closes (5/26). 17+ days deferred.

The audit refined: Phase 7a = additive substrate (embedding column + write-time embed in `specialistRunner` + match RPC available; consumer untouched). Phase 7b = consumer change (`specialistRecallContext` swaps chronological recall for semantic recall). Phase 7a is window-safe — zero behavior change to specialist organ output. Phase 7b is window-blocked — it changes what specialists recall, contaminating D2.2's measurement of specialist verdict quality.

Phase 7a can ship same-day on 5/13 (or even earlier with explicit captain go); Phase 7b waits for explicit captain go after D2.2 verdict + D3 close. Articulating the distinction at audit time saved ~17 days of unnecessary defer.

**Class diagnostic question for future window-gated work:** *"Does this ship change what the measured consumer reads, or only what's available to it?"* If the latter, it's window-safe.

**Sibling patterns:**
- one structural change per measurement window (Tenet 26) — this entry refines its application precision.
- back-anchorability-is-a-feature-precondition — adjacent verification at the column-shape layer.

**Linked artifacts:**
- PR #93 — `docs/audit/2026-05-09-phase-7-specialist-substrate-phase-a.md` Section 8 — original codification.

---

## parallel-drainer-without-skip-locked — cascade #45

**Pattern:** When N concurrent callers execute `SELECT ... WHERE <claim_predicate> ORDER BY ... LIMIT M` against the same table, all N callers receive the SAME M rows. Each caller then re-processes those rows (re-embedding, re-grading, re-ingesting). (N − 1) × M of the calls are wasted dupes. The dupe issue silently never surfaces under steady-state operation (single-caller cron) but explodes the moment a manual fire goes parallel.

**Structural shape:** absence of row-level claim atomicity. The fix is `FOR UPDATE SKIP LOCKED` inside an atomic claim RPC that combines the SELECT and the UPDATE-the-claim-marker into one statement. Optionally write a sentinel value (zero-vector for embeddings; status='claimed' for state-machine work) so concurrent SELECTs see the row as already-claimed and skip it.

**Discipline rule:** any drainer / worker function that selects un-processed rows from a queue-shaped table needs the claim to be atomic. Patterns that work:
1. **`SELECT ... FOR UPDATE SKIP LOCKED` inside an RPC** with a claim-marker UPDATE (sentinel value) inside the same statement.
2. **Optimistic concurrency via `UPDATE ... WHERE id = X AND embedding IS NULL`** with row-version checking.
3. **Job-queue table** with explicit claim TTL + crash recovery RPC.

The first is the cheapest retrofit and matches the SQL-native pattern.

### Instance — 2026-05-09 manual tape_commentary backlog drain

Session-A fired 10 parallel batches of `ct-embed-tape-commentary` via `invoke_edge_function` RPC, expecting ~1,000 rows drained in ~70s wall-clock. Actual: only ~100 unique rows drained; the other 900 Voyage calls were wasted dupes. The drainer's `SELECT WHERE embedding IS NULL ORDER BY created_at DESC LIMIT 100` doesn't claim atomically — all 10 parallel calls grabbed the same top-100 set, computed embeddings concurrently, then UPDATEd them all (the UPDATE didn't conflict because UPDATE-after-UPDATE is idempotent on the embedding column). 90% of Voyage spend was waste.

PR #94 class-killed: migration `20260510100000` adds `claim_unembedded_breaking_news` + `claim_unembedded_tape_commentary` RPCs (atomic SELECT + UPDATE inside one statement using `FOR UPDATE SKIP LOCKED` + zero-vector sentinel). Plus `reset_stale_embed_claims` for crash recovery. Both drainer JS files swap their `.from(...).select(...)` for `.rpc(...)`. Steady-state cron unaffected; activates under concurrent claims.

**Class diagnostic question for future drainer / worker designs:** *"If N callers fire this in parallel, do they each claim a disjoint slice or do they all grab the same slice?"* If the latter, the drainer needs atomic claim.

**Sibling patterns:**
- pg_cron_schedule_idempotency — both about ensuring intended-once operations actually run once.
- back-anchorability-is-a-feature-precondition — pre-implementation verification cousin.

**Linked artifacts:**
- PR #94 — `fix(drainers): FOR UPDATE SKIP LOCKED class-kill on embedding backlogs`.
- `docs/runbooks/embedding_gate.md` — appended "parallel-fire is now safe" + recovery sequence for stuck sentinel rows.

---

## disciplines-need-write-time-enforcement-not-just-post-hoc-audit

**Pattern:** Locking a discipline at the methodology layer (codify the rule in `methodology-patterns.md` / `decisions.md` / engine-room CLAUDE.md tenets) catches drift via post-hoc audit, but does NOT prevent the writing of artifacts that violate the discipline. Each fire = one more wall-clock day of drift before catch. Write-time enforcement = prevention. Same shape as Tenet 13 (structural prevention beats validators) applied to methodology discipline itself.

**Structural shape:** codification establishes the rule; the write-time gate prevents violation. Without a write-time gate, the discipline-stack works as audit-catch but artifacts in canonical state propagate stale framings until the next audit. Compounded over weeks of build velocity = many artifacts carrying drift.

**Discipline rule:** when a discipline is locked, identify the WRITE-TIME enforcement layer alongside the codification. Examples:
- **Brief-author write-time check** — before sending paste-ready PR, run a 5-check audit: state assertions, calendar anchors, cross-catalog parity, substrate-target verification, page-multiplication.
- **Memory-file write-time gate** — before appending to `methodology-patterns.md` / pickup files, search for calendar anchors + verify cross-catalog parity if the entry codifies a new discipline.
- **CI-layer enforcement** — regex check on docs PRs for calendar anchors outside historical context; cross-catalog parity check between Cowork-side `memory/patterns.md` and engine-room `docs/methodology-patterns.md`.
- **Templated entries** — methodology-patterns.md entry-template that prompts cross-catalog parallel codification before the entry can be saved.

### Instance — 2026-05-09 evening sync (this PR)

Two disciplines locked earlier in the day fired on their own canonization artifacts within 30 minutes of locking:

1. **calendar-anchor-becomes-deferral discipline** (locked 2026-05-09 morning, codified in this catalog via PR #95) fired on `project_co_trader_5pr_chain_shipped_2026_05_09_evening.md` — engine-room's own pickup file used "Sunday" 6 times AFTER the discipline was locked AND PR #95 explicitly dropped "Sunday is calibration day" from Tenet 19. Same anti-pattern on the artifact that's supposed to canonize the lesson.

2. **Cowork↔engine-room cross-catalog rule** (locked 2026-05-07 evening) fired on this very catalog — Cowork-side codified `page-multiplication-violates-no-silos-at-UX-layer` 5/9 afternoon, but engine-room methodology-patterns.md never got the parallel entry. Plus 3 cascade instances #43/#44/#45 codified inline in PR descriptions but not as top-level entries here. Catalog gap existed despite cross-catalog rule existing.

In both cases, the discipline existed; the artifact-author didn't run a write-time check. Audit caught the drift hours later; meanwhile artifacts existed in canonical form propagating bad framings. The 5/9 evening sync report surfaced the drift; this alignment PR closes it. Write-time gates for next time would have prevented the drift entirely.

**Class diagnostic question for future discipline codifications:** *"What's the write-time enforcement layer for this rule?"* If the answer is "we'll catch it at audit," that's not enforcement — it's reactive catch-up. Identify a gate at the layer where the violating artifact is written.

**Sibling patterns:**
- Tenet 13 (structural prevention beats validators) — same shape applied to methodology discipline itself.
- audit-first discipline — write-time check IS audit-first applied to brief-author / memory-author layer.
- brief-author-state-vs-intent — the rule itself is a write-time gate at the brief layer; this entry generalizes the gate concept across all artifact-writing layers.

**Canonical articulation (Cowork-side):** `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` `## Disciplines need write-time enforcement, not just post-hoc audit (2026-05-09 evening)` — same content, parallel codification per cross-catalog rule. The entry itself observes that it must land in BOTH catalogs to honor the cross-catalog rule it cites.

**Linked artifacts:**
- 2026-05-09 evening sync report — empirical motivation; Drift A + B both fired at artifact-creation layer.
- This alignment PR — closes Drift A + B and codifies the meta-pattern simultaneously.

---

## calendar-anchor-becomes-deferral — when discipline evolves past the framing

**Pattern:** When a tenet articulates discipline via a calendar anchor ("Sunday is calibration day," "weekly Sonnet distillation," "nightly retro"), the calendar anchor was the right shape AT THAT TIME. As build velocity accelerates and the discipline gets operationalized into continuous practice, the calendar anchor becomes obsolete — but the FRAMING persists in language. Continuing to invoke it creates a deferral pattern ("we'll do that Sunday") rather than the discipline the original tenet wanted.

**Structural shape:** the tenet's MECHANISM evolves into continuous practice; the tenet's FRAMING doesn't update. The framing then becomes the anti-pattern. The fix is at the framing layer, not per-incident.

**Discipline rule:** periodically check tenet framings against actual discipline operationalization. If discipline has evolved past the framing, update the framing. Drop calendar-day anchors from forward work; content-gate everything ("when X capacity opens" / "when validation surfaces issue" / "when N captures complete"). If actual calendar-anchored discipline is wanted (a genuine pause-and-calibrate day), name it explicitly as a workflow change, not a wish anchored to a calendar slot.

**Canonical articulation (Cowork-side):** `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` calendar-anchor-becomes-deferral entry — captures empirical motivation (Cowork's 4+ "Sunday becomes [X]" framings during the v2 push), structural shape (mechanism evolves but framing doesn't), full discipline rule (5 sub-rules), and cross-references to the broader framing-discipline family.

### Instance — 2026-05-09 Tenet 19 framing update

CLAUDE.md Tenet 19 originally read: *"Replay harness as continuous calibration tool. ct-backtest-harness — built once, used weekly. Every meaningful detector change goes through harness backtest before shipping. Sunday is calibration day."* Articulated when build velocity was slower; the harness was the primary calibration mechanism.

By 2026-05-09 calibration is operationalized continuously across the daily workflow:
- Phase A audits per ship (today's 6-PR chain ran Phase A per PR before any merge)
- Iteration log validation (`docs/audit/tape-v2-iteration-log.md` appends per-PR findings)
- Audit-while-building shape (architecture-fundamental Phase A first, design-iterable build in parallel)
- Captain-validates-live-URL on /alpha after each surface ship
- Warden 30-min invariant ticks (53+ invariants, 7 layers of defense net continuously evaluated)

`ct-backtest-harness` (commit `1fc795f`) remains available for specific tracks needing backtest grounding (D3 fork picks, threshold recalibration, detector lifecycle promotion) — content-gated by track readiness, not calendar slot.

Captain caught the drift after observing repeated "Sunday becomes [X]" framings in briefs during the v2 push. The "Sunday is calibration day" anchor was creating a deferral shell ("we'll do that Sunday") rather than the calibration discipline the tenet originally wanted. Updated Tenet 19 framing in this same PR. The catch IS the discipline working — drift caught at the framing layer rather than per-incident.

**Class diagnostic question for future audits:** *"Do any of my tenets anchor discipline to a calendar slot? If so, has the discipline been operationalized into continuous practice such that the calendar anchor is now obsolete? If yes, update the framing — the obsolete anchor will create deferral, not discipline."*

**Sibling patterns:**
- date-gating-vs-content-gating (CLAUDE.md preferences, locked 2026-05-07 evening) — same structural shape applied to forward commitments. Forward gates are content-shaped, never calendar dates.
- brief-author-state-vs-intent (cascade #37, cataloged 2026-05-07) — calendar anchors in briefs are state assertions about future capacity that drift between memory updates and actual operationalization.
- discovery-of-existing-coverage-changes-edit-shape-not-edit-target — when existing operationalization exists, the edit shape changes (update the framing), not the edit target (don't add another mechanism on top).

**Linked artifacts:**
- Cowork-side canonical entry: `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` `## Calendar-anchor-becomes-deferral when discipline evolves past the framing (2026-05-09 morning)`
- Cowork-side decision log: `/Users/jameschellis/Documents/cowork-cotrader/memory/decisions.md` 2026-05-09 morning entry
- This PR: Tenet 19 framing update + this entry codification

---

## parallel-agents-create-same-file-with-different-signatures

**Pattern:** When two parallel agents (worktree-isolated, dispatched simultaneously) each receive a brief that requires creating a shared resource (a hook, helper, RPC, or component file) — and the brief doesn't pre-specify the exact API — both agents land on a "reasonable" but different signature for the same file. When their PRs both merge or rebase, the file is created twice with diverging APIs. The merge surfaces the conflict; the resolution requires either dropping one version (and ensuring callers compile against the survivor) or maintaining both versions as drift.

**Structural shape:** parallel composition where the SHAPE of a shared resource isn't predetermined leaves room for divergent author judgment. Each agent makes a reasonable local choice; the global outcome is multiple sources of truth for the same logical resource. Sibling pattern to `Cowork↔engine-room cross-catalog rule` and `compose-with-the-kernel` — both about ensuring single-source-of-truth at composition boundaries.

**Discipline rule:** when dispatching parallel agents that may need a shared resource:
1. **Pre-author the shared API in the brief** — define the exact function signature, return type name, and import surface BEFORE either agent starts. Both agents bind to the contract; neither authors it from scratch.
2. **OR sequence the dispatch** — first agent ships the shared resource, then second agent dispatches against it once the first is on main. Substrate-before-surface pattern.
3. **OR pre-existing kernel** — if a shared kernel already exists (e.g., a brain organ that both surfaces compose against), point both briefs at it explicitly with paste-ready import statements.

**Diagnostic question for parallel dispatches:** *"Is there a shared resource both agents will create? If yes, who authors its API — the brief (pre-defined) or the first agent (sequenced)? If neither, expect signature divergence at merge."*

### Instance — 2026-05-09 evening iter #3 PR-B + PR-C parallel dispatch

PR-B (/heatmap alpha-class redesign) and PR-C (/alpha snapshot card) dispatched in parallel after PR-A (substrate brain organ at `_shared/gexInferenceContext.ts`) merged. Both briefs needed a frontend hook to consume PR-A's helper output. Neither brief pre-specified the hook's API signature.

PR-C shipped `useGexInference(tickers: string[] = DEFAULT_WATCHLIST)` returning `GexInferenceResponse` via `ct-gex-inference` edge function (thin wrapper around PR-A's helper).

PR-B shipped `useGexInference(args: UseGexInferenceArgs = {})` returning `GexInferenceResult` via direct PostgREST query against `ct_gex_timeseries` with kernel math RE-IMPLEMENTED in the hook.

PR-C merged first (`#105` → `0e931b0`). PR-B's rebase surfaced the file conflict. Captain locked resolution path (α): drop PR-B's hook, PR-B's 3 components compile against PR-C's hook (single-source kernel preserved).

**Lucky outcome:** both hooks happened to expose identical type names (`DealerNetDirection`, `PriceVsFlip`, `ConsensusDirection`, `PinAttractor`, `GexInferencePerTicker`) and PR-B's components called `useGexInference()` with no args (compatible with both signatures). Component edits required: zero. `tsc --noEmit` clean post-rebase.

**Unlucky outcome would have been:** components keyed to PR-B's specific args object or `GexInferenceResult` wrapper name → component edits required mid-rebase, potentially substantial. Or worse: silent semantic divergence (e.g., one hook computes flip differently than the other) → math drift on /heatmap vs /alpha until iter #3.5.

**Class diagnostic question for future parallel dispatches:** *"If both agents hit the same shared-resource decision, do they make the same call, or different calls? If different, what's the cost of resolution at merge time — zero edits, mechanical edits, or structural rewrite?"*

**Sibling patterns:**
- `compose-with-the-kernel` — same family at the kernel-vs-application boundary. Parallel agents authoring application-side hooks may each compose differently with the kernel (or worse, re-implement it locally) without explicit briefing.
- `Cowork↔engine-room cross-catalog rule` — same family at the catalog boundary. Two surfaces (Cowork memory, engine-room methodology) need parallel codification or they drift.

**Canonical articulation (Cowork-side):** Parallel entry at `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` to be added by captain post-merge per the cross-catalog rule. Paste-ready text in PR #106 description.

**Linked artifacts:**
- PR #105 (PR-C, merged `0e931b0`) — shipped the surviving `useGexInference` hook signature.
- PR #106 (PR-B, rebased post-#105) — dropped its own hook version, components consumed PR-C's hook.
- Iteration log entry at `docs/audit/tape-v2-iteration-log.md` `## 2026-05-09 evening — iter #3 PR-B rebase: hook conflict resolved per (α)`.

---

## analysis-pair-selection-contamination-by-temporal-adjacency

**Pattern:** Pairwise correlation/similarity backtests on time-stamped substrate (embeddings, feature vectors, observation rows) must filter for minimum time-separation between paired rows. Without the filter, pairs sampled from adjacent timestamps (same-session, same-minute, or same-N-minute window) dominate the high-similarity tail of the distribution. Adjacent-time pairs share persistent market conditions, identical or near-identical content, and trivially-correlated forward outcomes — they over-validate any test that uses similarity-vs-outcome correlation as the bet validator.

**Structural shape:** the contamination is *invisible at the macro level* — total pair count looks healthy, statistical-significance p-values look strong, top-decile shows tightest correlation. Without the temporal-adjacency filter, the result reads "embedding works great" while the actual signal driving the result is "rows from the same minute are obviously similar." The fix is mechanical (a single time-difference filter) but the *discipline is structural* — every backtest design over time-stamped substrate needs the filter as a default, not an afterthought.

**Discipline rule:** before running a pairwise correlation backtest, add a temporal-adjacency filter (`pair_time_diff > N` where N is the natural session/cycle boundary for the substrate). Default N = 24h for daily-scope analyses; N = same-session-end for intra-session analyses. Surface the result with AND without the filter so the contamination ratio is visible.

### Instance — 2026-05-09 evening prose-embedding backtest

Tier 1 raw run (n=247K pairs, no time filter): top-decile mean |Δret| = 0.001498, bottom-decile = 0.002123. **Top decile 29% smaller than bottom — looks like strong validation.**

Tier 2 raw top-10 cross-pair examples (no time filter) surfaced the contamination: pairs #1, #3, #4, #5, #6 were all adjacent-minute reads from the same session with cosine ≥ 0.997 and identical commentary text (`tape commentary` is the system's evolving narrative; adjacent minutes share most of the prose). Forward outcomes were trivially identical because the SPY price barely moved in 1 minute.

After filtering to pair_time_diff > 24h (n=206,650): top-decile mean |Δret| = 0.001747 vs bottom = 0.002125. **Top decile 18% smaller — still validates, but the real effect size is half what the raw run suggested.** The filtered result is the trustworthy validation; the raw result over-validated by ~10 percentage points.

The filter is what made the test result trustworthy. **Without the filter, the discipline-stack would have validated the embedding bet on contaminated evidence.** Caught at Tier 2 trader-level inspection (the prose pairs at top cosine were obviously duplicates), not at Tier 1 statistical-significance level.

**Class diagnostic question for future analyses:** *"Are my pair-similarity samples drawing from a population where adjacent-time pairs share content/conditions trivially? If yes, what's the natural session-cycle boundary and am I filtering above it?"*

**Sibling patterns:**
- `placeholder-glyph-collapses-three-states` (cascade #45 instance) — same family of UI/analysis ambiguity-collapse: a single output value (em-dash glyph there, top-decile pair here) that can mean multiple things gets read as ONE thing.
- `audit-frame-mismatch` — surface-vs-substrate confusion. Here the surface is "Tier 1 raw correlation looks strong" while the substrate has "adjacent-time pairs dominating the tail."
- `audit-verification-surface-mismatch` — meta-check: verify the analysis surface matches the question the analysis is actually asking. "Does cosine predict forward outcome?" requires sampling from temporally independent pairs; raw run was asking "does adjacent-minute prose predict adjacent-minute return?" (a different, trivial question).

**Canonical articulation (Cowork-side):** Parallel codification at `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` per cross-catalog rule — Cowork drafts at write-time of this entry's parallel.

**Linked artifacts:**
- `docs/analysis/embedding-bet-backtest-2026-05-09.md` — empirical motivation; full Tier 1/Tier 2 raw + filtered comparison.
- Throwaway analysis script (Tenet 26): `/tmp/embedding-backtest/run.py`.

---

## embedding-validation-saturation-at-high-cosine

**Pattern:** Decile-binned correlation curve shape IS the instrument diagnostic for embedding-axis backtests. The shape tells you *what kind of signal the embedding captured* — not just whether it captured signal. Four canonical shapes, four interpretations.

**The four diagnostic shapes:**

1. **Linear monotonic (no plateau)** — top decile shows tightest forward-outcome correlation; correlation continues to improve from D1 → D10 with no saturation. Reading: the embedding instrument captures the bulk of the signal available in this axis; *upside ceiling not yet hit*. Continue extending the same axis with more substrate / better embeddings — gains compound.

2. **Monotonic + plateau at high deciles** — D1 → D7-ish shows monotonic improvement; D8/D9/D10 plateau or slightly invert. Reading: the embedding instrument captures real signal at low/mid similarity, but at high similarity the residual variance lives in *other axes* the instrument doesn't see. **Instrument-mismatch ceiling.** Adding more data on this axis won't help; the next axis (different feature substrate) is the unlock.

3. **Flat curve** — no meaningful difference in mean forward-outcome delta across deciles. Reading: the embedding instrument captured *linguistic* similarity (or whatever surface property) but the pattern doesn't live in this axis. Wrong instrument entirely. Iterate test design on a different substrate.

4. **Inverse curve** — D10 (highest cosine) shows LOWER correlation than D1 (lowest cosine). Reading: structural problem. Either the similarity metric is computing the inverse of what was intended, the substrate is corrupted, or the forward-outcome metric is misaligned with the embedding axis. Flag for investigation; do not extend the test.

**Discipline rule:** every embedding-axis backtest plots the decile curve AND reports the shape diagnosis as the load-bearing finding. Pearson r and Spearman ρ summarize magnitude; the curve shape summarizes *what kind of signal exists in this axis*. Two embedding tests with identical Pearson r can have completely different decile curves and require completely different next-test decisions.

### Instance — 2026-05-09 evening prose-embedding backtest

Decile curve shape (after temporal-adjacency filter, n=206,650 pairs):
- D1 (cosine 0.5278-0.6925): mean |Δret| 0.002125
- D2: 0.002067, D3: 0.001937, D4: 0.001828, D5: 0.001805, D6: 0.001795, D7: 0.001764
- **D8 (cosine 0.8059-0.8194): mean |Δret| 0.001737 — minimum**
- D9: 0.001746, D10 (cosine 0.8361-0.9217): 0.001747

**Shape: monotonic D1→D8, plateau D8-D10.** Reading: prose embedding captures the bulk of setup-shape signal (tide × VIX bucket × dominant-ticker character × time-of-session × regime/conviction language); at the top of the cosine distribution, prose has extracted what it can extract. Residual variance lives in *other axes* the prose instrument doesn't see — algo footprints, strike concentration, GEX state, microstructure timing.

**The plateau IS the load-bearing finding** — Pearson r of −0.078 understates the case. The curve says: prose works, AND another axis is needed. Captain's instrument-mismatch hypothesis (5/8 vision-mode: "algos leave clues in flow not prose") is empirically supported by the plateau diagnostic. The next test (flow-sequence embedding, ct_flow_alerts axis) ships against this same diagnostic framework — the curve shape on flow-sequence will tell us whether that axis captures additional signal (linear shape) or hits the same ceiling (saturation).

**Class diagnostic question for future embedding tests:** *"What shape is my decile curve? What does that shape tell me about whether this instrument hit its ceiling, missed the pattern entirely, or is structurally broken?"* Decide next-test direction by curve-shape, not by p-value alone.

**Sibling patterns:**
- `audit-frame-mismatch` — same family of "the question being asked vs the question being answered." A flat decile curve can produce a non-zero Pearson r if there's micro-variation; the shape diagnosis is what tells you it's flat.
- `compose-with-the-kernel` — implication for substrate design: when shape says "instrument-mismatch ceiling," the move is *another axis on the same kernel*, not "more rows on this axis." The kernel composes; the axes compound.

**Canonical articulation (Cowork-side):** Parallel codification at `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` per cross-catalog rule.

**Linked artifacts:**
- `docs/analysis/embedding-bet-backtest-2026-05-09.md` — Tier 1 decile table + plateau interpretation.
- `docs/analysis/embedding-bet-flow-sequence-backtest-2026-05-09.md` (forthcoming) — second instance of decile-shape diagnosis on a different axis. Will validate or refine this pattern.

---

## How to add an entry

When a methodology error bites:

1. Identify whether it's an instance of an existing sub-section above. If so, add under that heading with a dated **Instance** subsection.
2. If it's a new class, add a new top-level `## name — short description` heading and write up the pattern, then add the instance.
3. Always link source artifacts (memos / decisions / migrations) so the reasoning chain stays traceable.
4. End each instance with the **diagnostic question** future-you should have asked earlier — that's the actionable lesson.
