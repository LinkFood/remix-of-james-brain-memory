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

## How to add an entry

When a methodology error bites:

1. Identify whether it's an instance of an existing sub-section above. If so, add under that heading with a dated **Instance** subsection.
2. If it's a new class, add a new top-level `## name — short description` heading and write up the pattern, then add the instance.
3. Always link source artifacts (memos / decisions / migrations) so the reasoning chain stays traceable.
4. End each instance with the **diagnostic question** future-you should have asked earlier — that's the actionable lesson.
