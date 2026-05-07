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

Enumerated from `_shared/specialistRunner.ts:1243-1282` (parallel input bundle) plus `tickerQuantCard.ts` and `flowHeatmapContext.ts`. Eight candidates with one-line rationale, ordered by hypothesized explanatory power.

**F1 — `flow_pulse.is_unusual` (boolean).** From `loadFlowPulse` / `ct_flow_pulse`, 6h. Trips when call:put ratio is 2x or 0.5x 30d baseline. *Prime H0-B suspect:* binary flag with a fixed prompt-level effect ("⚠ UNUSUAL direction skew").

**F2 — `flow_heatmap.stacks[].value` front-week (continuous, signed).** From `flowHeatmapContext`, 168h aggressive-directional decay. *Continuous; clean linear relationship to conviction would argue against H0-B (no flip) and toward H0-C as primary input.*

**F3 — `tickerContext.regime` (positive_gamma / negative_gamma / neutral).** From `ct_ticker_snapshots.regime`. *Three-state categorical with sharp prompt-level effects; classic H0-B candidate. Negative-gamma days may systematically push conviction up.*

**F4 — `news_count` + `news.severity` (count + max severity).** From `newsItemsForTicker` cap=8. *SPY has dense macro-wide news (single mode); NVDA has sharper per-ticker clustering (bimodal). News density may explain the middle-band fill in QQQ/GOOGL/META — H0-C evidence.*

**F5 — `event_recency.whatJustHappened` non-empty (boolean).** From `ctx.preamble.whatJustHappened`. *Binary "is there a recent material event" gate; conviction clustering higher when non-empty is H0-B-flavored.*

**F6 — `signature_alarms.recent_count` (0/1/2+).** From `loadRecentSignatureAlarms`. *Detector-portfolio "pattern fired" surface; can act flip-like (0 vs ≥1) or graded. NVDA bimodality plausibly downstream.*

**F7 — `dte_eligibility.has_0dte_today` (boolean).** From `buildSystemContextHeader` (dteEligibility). *Mag7+IBIT+AVGO MWF; SPY/QQQ/IWM daily; non-Mag7 weekly. Day-of-week interaction → per-ticker conditional distribution; classic H0-C generator.*

**F8 — `specialist_recall.last_flag_outcome` (WIN/LOSS/EXPIRED_*/none).** From `specialistRecallContext`. *Confound check rather than primary hypothesis — recall property too new for stable 7-day behavior, but measure to rule out as a bimodality cause.*

---

## 4. Experimental design

**Read window:** 14 days rolling, refreshed nightly. Anchored to the 2026-05-07 evidence pull, extended forward to clear sample-size bars (see §6).

**Per-wakeup feature snapshot.** For every `ct_specialist_reads` row, reconstruct the F1–F8 vector from the same upstream tables the specialist read at wakeup time:
- F1: `ct_flow_pulse(p_window_min=>360, p_ticker=>X)` at `updated_at - epsilon`.
- F2: front-week `flow_heatmap` stack via the helper's RPC, anchored to `updated_at`.
- F3: `ct_ticker_snapshots.regime` row nearest `updated_at`.
- F4: `news_causality` row count + max severity in 6h prior to `updated_at`.
- F5: `ct_events` presence in 72h prior.
- F6: `ct_signature_alarms` count for ticker, 6h prior.
- F7: deterministic from ticker + `updated_at::date`.
- F8: most recent `ct_flag_grades` for `specialist_ticker = X` prior to `updated_at`.

**Reconstructibility check.** F1, F2, F4, F5, F6 are time-bucketed and may have drifted (UW backfills, news-causality re-grading). Phase A on a 24h window first; confirm reconstruction error <5% on a held-out validation set (10 wakeups with cached prompt snapshots).

**Statistical method (two-stage):**

*Stage 1 — per-ticker univariate stratification.* For each ticker with N≥25 (8 of 10), split conviction by each binary/categorical feature; Hartigan's dip test on each stratum. A stratum that's unimodal where the parent is bimodal implicates the feature. Continuous features (F2, F4) binned into terciles.

*Stage 2 — multi-feature regression on mode membership.* Binary mode label: 1 if conviction ≥ 55, 0 if ≤ 45, drop middle band. Per-ticker logistic regression of mode on F1–F8. Report McFadden's R² per ticker. Variance of single-feature contributions across 8 well-powered tickers is the H0-B vs H0-C discriminator.

**Sample size.** Hartigan's dip test needs N≥30 to detect mode separation at α=0.05 with reasonable power for the observed effect size (mode separation ~15-20 conviction points). Today: SPY/TSLA/QQQ/IWM/AMZN clear; AAPL/META/GOOGL marginal at N=25; MSFT/NVDA insufficient at N≤13. Per-stratum tests halve N — binding constraint.

**Clearing N≥30:** AAPL/META/GOOGL accrete to 35-50 in ~3 trading days; NVDA needs ~10 trading days at ~1.7/day. Accept lower power for MSFT/NVDA — report H0-C-on-those-two as inconclusive rather than rejected.

**Confound checks.**
- *Vol regime:* condition on `iv_rank ∈ {low/mid/high}`; bimodality surviving all three buckets rules out vol.
- *Day-of-week:* MWF-vs-TTh split for Mag7; tests for F7 0DTE-availability artifacts.
- *News-event clustering:* exclude wakeups within 2h of severity≥3 news event; rerun. Bimodality vanishing → news clustering is feature-attributable cause.
- *Specialist-prompt drift:* `ct_specialist_prompts.updated_at` over the window. Any edit is a regime change; segment around the edit timestamp.

**Output.** Per-ticker table: dip-test p-value, top 3 features by univariate stratum-effect, multi-feature logistic R², feature-contribution table. Cross-ticker meta-table: features with consistent vs heterogeneous effects.

---

## 5. Decision tree from results

**Class 1 — single feature dominates (top-1 R² > 0.40 in ≥7 of 10 tickers, same feature ranked top-1).** H0-B survives, A and C rejected. → **Option B opens:** fix the dominant feature so it produces continuous output rather than a flip. The 7-of-10 bar acknowledges MSFT/NVDA statistical weakness; we need the 8 well-powered tickers to converge.

**Class 2 — multiple correlated features, R² spread across 3+ features each contributing 10–20%, ranking varies by ticker.** H0-C survives, A and B rejected. → **Option C opens:** feature stratification (per-ticker conviction interpreted by which feature combination produced it) plus per-stratum score adjustment. Heavier than B.

**Class 3 — no feature combination explains mode membership at R² > 0.20 anywhere.** H0-A re-opens; bimodality is unreachable from input features. → **Option A re-opens:** redesign the score function from the combinator outward.

**Class 4 — mixed: one feature dominates 4-5 tickers, multiple-feature for the rest.** → Option C with ticker-class differentiation (some tickers get B-style fix, others get C-style stratification). The genuinely hybrid path.

**Threshold rationale.** R² ≥ 0.40 is the standard decision split; below 0.40 the ambiguity argues the heavier C path. The 7-of-10 bar lets one well-powered ticker disagree; MSFT/NVDA excluded because their power can't discriminate.

---

## 6. Cost estimate

**Sample-size cost.** Today: SPY 40, TSLA 36, QQQ 32, IWM 30, AMZN 29 clear N≥30. AAPL/META/GOOGL at 25 reach the bar in ~3 trading days. MSFT (13) and NVDA (12) reach 30 in ~10-15 trading days. Experiment gated on 14-day rolling window, not a one-shot pull. MSFT/NVDA power stays marginal at window end; report effect-direction-only, not significance-tested.

**Feature reconstruction cost.** ~500 wakeups × ~8 RPC calls = ~4,000 RPCs. One-shot batch script (analysis-mode, Tenet 26), ~30 min wall time.

**Statistical analysis cost.** Dip tests + logistic regressions negligible compute. ~½ day of terminal-Claude analyst work.

**Implementation effort.** Reconstruction script (~200 LOC), Hartigan dip-test wrapper, logistic regression per ticker, output table generator. 1-2 days of focused work. Does **not** include the architectural fix — experiment picks the fork; A/B/C implementation cost is sized in the original D3 brief (1-2w A, 2-4w B, ~6w C).

**MSFT bottleneck.** MSFT N=13/week is the single biggest constraint; can't give a strong MSFT verdict in the 14-day window. Options: (a) accept inconclusive MSFT, design fork from 8 well-powered tickers; (b) extend MSFT-only window to 30 days, delayed verdict. Recommend (a) — MSFT Phase A.6 is parallel-tracked.

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
