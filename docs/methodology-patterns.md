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

## How to add an entry

When a methodology error bites:

1. Identify whether it's an instance of an existing sub-section above. If so, add under that heading with a dated **Instance** subsection.
2. If it's a new class, add a new top-level `## name — short description` heading and write up the pattern, then add the instance.
3. Always link source artifacts (memos / decisions / migrations) so the reasoning chain stays traceable.
4. End each instance with the **diagnostic question** future-you should have asked earlier — that's the actionable lesson.
