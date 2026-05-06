# D3 Feature-Isolation Experiment Design — Cross-Watchlist Bimodality

**Status:** Experiment-design brief. **Does NOT pick the A/B/C fork.** Designs the evidence-collection that will pick it. Drafted 2026-05-08 morning; runs against the cross-watchlist read pull from 2026-05-07.

**Anchor evidence (from yesterday, do not re-pull):**
- 5 YES (clear bimodal): NVDA, AAPL, AMZN, TSLA, IWM
- 3 AMBIGUOUS (two peaks but middle band 12–16% populated): GOOGL, META, QQQ
- 2 NO (single mode): MSFT, SPY
- Geometry asymmetry: IWM upper-mode-dominated, SPY lower-mode-dominated in the same window
- Brief's pre-flag #2 fired: "if some specialists are continuous-distributed → bimodality is feature-dependent"
- Per-ticker 7-day N (from `/tmp/reads_7d.json`): SPY 40, TSLA 36, QQQ 32, IWM 30, AMZN 29, AAPL 25, META 25, GOOGL 25, MSFT 13, NVDA 12 (267 total)

---

## 1. Hypothesis

Q1 cause-attribution restated as three falsifiable nulls, each tied to one A/B/C fork. The experiment rejects at most one; surviving null(s) define the operational fork.

**H0-A — "Bimodality is intrinsic to the score function."** The bimodal shape is a property of the combinator, independent of which features are present or what regime is in effect. *Killed by:* any feature stratum that, when held constant, yields a unimodal conviction distribution. *Killed by:* explaining IWM-vs-SPY mode-dominance asymmetry through differential inputs (an intrinsic combinator can't produce inverted dominance from identical inputs).

**H0-B — "Bimodality is driven by a single dominant feature flip."** A specific binary/near-binary feature (regime flag, wall-proximity check, 0DTE branch, earnings gate) flips conviction by a fixed magnitude, creating two clusters separated by an empty band. *Killed by:* three or more features each contributing 10–20% with no feature exceeding ~40%. *Killed by:* the suspected feature being continuous-valued yet still producing bimodal output downstream (pushes back to H0-A).

**H0-C — "Bimodality is feature-set dependent and ticker-conditional."** Multiple features interact; interaction shape differs by ticker because feature availability and distribution differ. SPY's flow regime is dense and continuous; IWM's is sparser and discrete; same combinator, different mode shapes. *Killed by:* bimodality surviving ticker-controlled stratification (pushes back to H0-A). *Killed by:* one feature dominating across all 10 tickers (pushes back to H0-B).

**Observation map:** H0-A predicts identical bimodal shape across all tickers under any stratification. H0-B predicts one feature explains the gap across all tickers. H0-C predicts explaining feature(s) and effect sizes differ by ticker.

---

## 2. Ticker pair design

Three pairs chosen for diagnostic asymmetry. Each has a prediction under each H0.

**Pair 1 — IWM (upper-mode-dominated bimodal) vs SPY (single mode, lower-dominated).** Same broad-index regime exposure, mirror-opposite mode geometry in the same window. Strongest pair for falsifying H0-A — if intrinsic, both should be bimodal; SPY isn't. *H0-A:* identical bimodal shape predicted; asymmetry unexplained → weakened. *H0-B:* dominant feature differs sharply — IWM fires it (upper), SPY suppresses (lower). *H0-C:* feature *distributions* differ; SPY's flow dense enough to fill the middle band, IWM's sparse and clusters.

**Pair 2 — NVDA (clear bimodal) vs MSFT (single mode).** Same Mag7 cohort, same earnings/expiry calendar, opposite mode shapes. Separates "mode shape via ticker-level feature availability" (C) from "mode shape via regime entry" (B). *Caveat:* MSFT N=13, NVDA N=12 — diagnostically rich, statistically weakest. *H0-A:* both bimodal; asymmetry unexplained. *H0-B:* single feature consistently present in NVDA, absent in MSFT. *H0-C:* multiple features differ; ticker-conditional combinator.

**Pair 3 — AMBIGUOUS-trio (GOOGL, META, QQQ) as a group.** Diagnostic surface is the populated middle band (12–16% in [45, 60]). H0-A says it shouldn't exist; existence already weakens H0-A. H0-B says it's wakeups where the dominant feature is partially present (continuous-valued interpreted as flip in some tickers, gradient in others). H0-C says it's where multi-feature interaction produces a moderate score because no feature is decisive. **Cleanest B-vs-C diagnostic:** consistent feature signature in middle-band wakeups → B; heterogeneous combinations → C.

**Why these three:** Pair 1 falsifies A from outside Mag7. Pair 2 falsifies A from inside. Pair 3 separates B from C in the wakeups A can't explain.

---

## 3. Candidate features

Enumerated from `_shared/specialistRunner.ts:1243-1282` (the parallel input bundle) plus `tickerQuantCard.ts` and `flowHeatmapContext.ts`. Five-to-eight candidates with rationale, ordered by hypothesized explanatory power.

**F1 — `flow_pulse.is_unusual` (boolean).** From `loadFlowPulse`, RPC `ct_flow_pulse`, 6h window. Trips when call:put ratio is 2x or 0.5x the 30-day baseline. **Rationale:** prime H0-B suspect — it is a binary regime flag with a fixed effect on the specialist's prompt ("⚠ UNUSUAL direction skew" string). If conviction jumps a fixed magnitude when this trips, this is the single dominant feature.

**F2 — `flow_heatmap.stacks[].value` for the front week (continuous, signed).** From `flowHeatmapContext`, 168h aggressive-directional decay. **Rationale:** continuous feature; if conviction shows a clean linear relationship to front-week stack magnitude, that argues against H0-B (no flip) and toward H0-C with this as a primary input.

**F3 — `tickerContext.regime` (categorical: positive_gamma / negative_gamma / neutral).** From `ct_ticker_snapshots.regime`. **Rationale:** three-state categorical with sharp prompt-level effects; classic H0-B candidate. Negative-gamma days may systematically push conviction higher because every prompt section reads "regime: negative_gamma" and the specialist treats it as a force-multiplier.

**F4 — `news_count` and `news.severity` (count + max severity).** From `newsItemsForTicker` cap=8. **Rationale:** SPY (single mode, lower) has the densest macro-wide news; NVDA (clear bimodal) has sharper per-ticker news clustering. If news *density* (continuous) explains the middle-band fill in QQQ/GOOGL/META, that's H0-C evidence.

**F5 — `event_recency.whatJustHappened` non-empty (boolean).** From `ctx.preamble.whatJustHappened`. **Rationale:** binary "is there a recent material event" gate. If conviction systematically clusters higher when this is non-empty, H0-B. The brief's tape-reader continuity suggests this is a strong signal-amplifier.

**F6 — `signature_alarms.recent_count` (count, 0/1/2+).** From `loadRecentSignatureAlarms`. **Rationale:** signature-watcher alarms are the v2 detector portfolio's binary "this pattern fired" surface. Mostly zero, occasionally one. Three-bin variable that can act flip-like (0 vs ≥1) or graded (0/1/2+). NVDA bimodality is plausibly downstream of signature alarms firing or not.

**F7 — `dte_eligibility.has_0dte_today` (boolean).** From `buildSystemContextHeader` (dteEligibility). **Rationale:** Mag7 + IBIT + AVGO have Mon/Wed/Fri 0DTE; SPY/QQQ/IWM are daily; non-Mag7 single-names are weekly. Day-of-week interaction makes this a per-ticker feature with day-conditional distribution — classic H0-C generator.

**F8 — `specialist_recall.last_flag_outcome` (categorical: WIN/LOSS/EXPIRED_*/none).** From `specialistRecallContext`. **Rationale:** the specialist sees its own prior outcomes; a recent WIN may push conviction up via prompt anchoring. Confound check rather than primary hypothesis (the recall property is too new for 7 days of stable behavior, but worth measuring to rule out as a cause of the bimodality).

---

## 4. Experimental design

**Read window:** 14 days rolling, refreshed nightly. Anchored to the cross-watchlist evidence pull but extended forward to address sample-size constraints (see §6).

**Per-wakeup feature snapshot.** For every row in `ct_specialist_reads`, reconstruct the F1–F8 feature vector by querying the same upstream tables the specialist read at wakeup time. Sources:
- F1: `ct_flow_alerts` aggregated through `ct_flow_pulse(p_window_min=>360, p_ticker=>X)` evaluated at `updated_at - epsilon`.
- F2: front-week `flow_heatmap` stack via the same RPC the helper uses, anchored to `updated_at`.
- F3: `ct_ticker_snapshots.regime` row nearest to `updated_at`.
- F4: `news_causality` row count + max severity in the 6h window prior to `updated_at`.
- F5: `ct_events` row presence in the 72h window prior to `updated_at`.
- F6: `ct_signature_alarms` count for ticker in 6h window prior.
- F7: deterministic from ticker + `updated_at::date`.
- F8: most recent `ct_flag_grades` row prior to `updated_at` for `specialist_ticker = X`.

**Reconstructibility check:** F1, F2, F4, F5, F6 are time-bucketed and may have drifted (UW backfills, news-causality re-grading). Run a Phase A on a 24h window first to confirm reconstruction error is below 5% on a held-out validation set (10 wakeups with cached prompt snapshots).

**Statistical method.** Two-stage:

*Stage 1 — per-ticker univariate stratification.* For each ticker with N≥25 (8 of 10 tickers), split conviction by each binary/categorical feature and compare distributions. Test: Hartigan's dip test on each stratum's conviction distribution. If a stratum is unimodal where the parent is bimodal, that feature is implicated. Continuous features (F2, F4) get binned into terciles for this stage.

*Stage 2 — multi-feature regression on bimodality membership.* Define a binary "mode" label per row: 1 if conviction ≥ 55, 0 if ≤ 45, drop the middle band. Per-ticker logistic regression of mode on F1–F8. Report McFadden's R² per ticker. Compare R² distributions across tickers. The variance of single-feature contributions across the 8 tickers with N≥25 is the H0-B vs H0-C discriminator.

**Sample size required.** Hartigan's dip test needs N≥30 to detect mode separation at α=0.05 with reasonable power for the bimodality effect size we're seeing (visible mode separation ~15-20 conviction points). Of the 10 tickers, only SPY/TSLA/QQQ/IWM/AMZN clear that bar today; AAPL/META/GOOGL are at N=25 (marginal); MSFT/NVDA at N≤13 (insufficient). Per-stratum tests halve N at minimum; this is the binding constraint.

**To clear N≥30 per ticker:** wait ~3 trading days for AAPL/META/GOOGL/MSFT to accrete to ~35-50; NVDA needs ~10 trading days at current ~1.7 reads/day. Either accept a 2-week experiment window or accept lower power for MSFT/NVDA (and report H0-C-on-those-two as inconclusive rather than rejected).

**Confound checks.**
- *Vol regime:* repeat each per-ticker test conditioned on `iv_rank ∈ {low/mid/high}`. If the bimodality survives all three buckets, vol is not the explanation.
- *Day-of-week:* MWF-vs-TTh split for Mag7; All-days for ETFs. Tests for 0DTE-availability artifacts (F7 confound).
- *News-event clustering:* exclude wakeups within 2h of a severity≥3 news event; rerun. If bimodality vanishes, news clustering is the explanation (H0-C-flavored, but feature-attributable).
- *Specialist-prompt drift:* `ct_specialist_prompts.updated_at` over the 14-day window. Any prompt edit during the window is a regime change; segment around the edit timestamp.

**Output of experiment.** Per-ticker table: bimodality dip-test p-value, top 3 features by univariate stratum-effect, multi-feature logistic R², feature contribution table. Cross-ticker meta-table: which features have consistent vs heterogeneous effects.

---

## 5. Decision tree from results

**Result class 1 — single feature dominates (top-1 feature R² > 0.40 in ≥7 of 10 tickers, with the same feature ranked top-1 across them).** H0-B survives, H0-A and H0-C are rejected. → Option B opens up: fix the dominant feature so it produces continuous output rather than a flip. Threshold for the "≥7 of 10" bar is set by acknowledging two tickers (MSFT, NVDA) will be statistically weak; we need the 8 well-powered tickers to converge.

**Result class 2 — multiple correlated features with R² spread across 3+ features each contributing 10–20%, with feature ranking varying by ticker.** H0-C survives, H0-A and H0-B are rejected. → Option C opens up: the structural fix is feature stratification (per-ticker conviction is interpreted in the context of which feature combination produced it) plus per-stratum score adjustment. Implementation is heavier than B; this is the "hybrid" path.

**Result class 3 — no per-ticker feature combination explains mode membership at R² > 0.20.** H0-A re-opens. The bimodality is a structural property of the score function combinator that is unreachable from the input feature distribution. → Option A re-opens: admit bimodality is real, redesign the score function from the combinator outward (this is the "redesign the score function" interpretation of A from the original D3 brief).

**Result class 4 — mixed: one feature dominates for 4-5 tickers, multiple-feature for the rest.** Option C with ticker-class differentiation (some tickers get B-style fix, others get C-style stratification). This is the genuinely hybrid path the original brief contemplated.

**Threshold rationale.** R² ≥ 0.40 for "single feature dominates" is the standard decision-tree split point; below 0.40 there's ambiguity that argues for the heavier C path. The 7-of-10 ticker bar is calibrated to the 8 well-powered tickers (allowing one of them to disagree); MSFT/NVDA are excluded from the bar because their power is insufficient to discriminate.

---

## 6. Cost estimate

**Sample-size cost.** Today's 7-day N has SPY 40, TSLA 36, QQQ 32, IWM 30, AMZN 29 above the N≥30 bar. AAPL/META/GOOGL at 25 reach the bar in ~3 trading days. MSFT (13) and NVDA (12) reach 30 in ~10-15 trading days at current accretion rate. **Implication:** the experiment is gated on a 14-day rolling window, not a one-shot pull. Statistical power on MSFT and NVDA will remain marginal even at the end of the window; their results should be reported as effect-direction-only, not significance-tested.

**Feature reconstruction cost.** Per-wakeup snapshot reconstruction across F1–F8 for ~500 wakeups (14 days × ~35 reads/day average) is ~8 RPC calls per wakeup = 4,000 RPC calls. Run as a one-shot batch script, not as an edge function. Estimated 30 minutes wall time.

**Statistical analysis cost.** Per-ticker dip tests + logistic regressions are negligible compute. Half a day of analyst-mode work in terminal-Claude (this is analysis-mode, not autonomous-mode — Tenet 26).

**Implementation effort for the experiment itself.** Scripted feature-reconstruction job (~200 LOC), Hartigan dip-test wrapper, logistic regression per ticker, output table generator. Estimate 1-2 days of focused work. Does **not** include any architectural fix — the experiment's output picks the fork; implementation is sized in the original D3 brief (1-2 weeks A, 2-4 weeks B, ~6 weeks C).

**MSFT bottleneck surfaced.** MSFT N=13/week is the single biggest constraint. The experiment cannot give a strong MSFT verdict in the 14-day window. Two options: (a) accept inconclusive MSFT, design the fork using the 8 well-powered tickers; (b) extend MSFT-only window to 30 days, treating MSFT as a separate analysis with delayed verdict. Recommend (a) — MSFT Phase A.6 is parallel-tracked anyway.

---

## 7. Null hypothesis the design favors

**Honest priors:** the experiment is structurally biased to reject H0-A faster than B or C, and biased toward H0-C as the fallback when neither A nor B cleanly survives.

**H0-A bias (against).** IWM-vs-SPY geometry asymmetry is already strong evidence against intrinsic bimodality; Pair 1 starts H0-A's likelihood low. Dip tests and multi-feature regression are designed to find structure, not fail to find it.

**H0-B bias (modest, toward).** F1–F8 over-weights binary/categorical features (F1, F3, F5, F7 binary-ish; F6 bin-graded). If H0-B is right, these are exactly the right features. If H0-B is wrong but the cause is a continuous feature not enumerated (e.g., dollar-weighted flow not in the bundle), the design routes to H0-C by elimination. F2 (continuous front-week stack value) is included as counter-bias.

**H0-C bias (strongest, toward).** "Multiple features each 10–20%" is the easiest landing zone by elimination — any time the data is noisy and no single feature dominates, H0-C survives. Mirrors the brief's mixed-evidence prior; messy evidence lands in C.

**Implication for fork choice.** Decision tree favors B over C only on unambiguous evidence (R² > 0.40 across 7+ tickers); anything less lands in C. Intentional — shipping B against ambiguous evidence patches the wrong feature; shipping C against single-feature evidence over-engineers.

**Not biased toward Option A.** A only re-opens if multi-feature regression explains essentially nothing (R² < 0.20 everywhere). The design assumes the score function is reachable from input features; if it isn't, the experiment will say so by failing to find any feature with explanatory power.

---

## 8. Cascading effects

**D2.2 verdict on 5/13 — GOOGL/AMZN/META threshold drop to 55.** If experiment lands in result class 1 (H0-B) by 5/13, drop is *patch pending B* and reverts when B ships. If class 2 (H0-C) by 5/13, drop is *right fix at the per-ticker level* and stays under C's stratification. If experiment is still running on 5/13 (likely given 14-day window), D2.2 ships as buffer with explicit "patch pending D3 verdict" framing.

**MSFT Phase A.6 — parallel-tracked, weakest verdict.** Different cause class per original D3 brief; MSFT's bimodality verdict is the weakest in this experiment due to N=13. MSFT-specific D3 unblock date is *after* MSFT Phase A.6 ships, not after this experiment concludes. Sequencing: experiment concludes ~5/22 → 8 well-powered tickers locked → MSFT Phase A.6 ships → MSFT-specific verdict ~5/29.

**Captain hardening 5/10 → 9/10 target.** Without a D3 fork, the next 4 specialists (ambiguous-trio + one of MSFT/NVDA) can't harden beyond threshold-shimming. Critical path: experiment ~5/22 → fork ~5/23 → A or B ships ~6/05, C ships ~7/03. Trajectory: 5/10 → 8/10 by ~6/05 (A or B), 5/10 → 9/10 by ~7/03 (C).

**Read-Layer Integrity Bundle Phase 2 interaction.** Experiment needs per-wakeup feature reconstruction across 8 organs. Phase 2 (per-organ status population, weeks of work per PR #53) strengthens reliability but isn't a prerequisite — reconstruction error tolerance is ~10%. If Phase 2 ships mid-window, retroactively strengthens the experiment.

**Synthesis layer telemetry.** `ct_brain_telemetry` records per-helper p50/p95 for the 9 organs; reconstruction job consumes the same organ outputs. If telemetry shows a helper degrading mid-window, segment around the degradation. Watch `get_brain_health(24)` daily during the run.

**No ripples into broker-bridge or specialist-recall.** Both are downstream surfaces; experiment touches neither. Recall C1 hit-rate window (through 5/15) is independent — experiment does not modify recall behavior.

---

## Footer

**Pre-conditions before kicking off the experiment.** None blocking. Run script can ship today against the existing `ct_specialist_reads` table and reconstructible upstreams. The 14-day clock starts on first reconstruction pass.

**One thing this brief explicitly does not do.** Does not pick A, B, or C. The experiment picks it. If midway through the 14-day window the result is overwhelmingly clear (e.g., F1 alone explains 70% of variance in 9 of 10 tickers by day 7), the fork can be picked early — but the early-pick threshold should be unambiguous, not "leaning."
