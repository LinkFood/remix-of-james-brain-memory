# D3 Feature-Isolation Experiment — Pipeline Scaffold

**Status:** scaffold only (2026-05-08). Loaders are stubs; no live pulls. Brief: `scope/2026-05-08-d3-feature-isolation-experiment.md`.

## Purpose

Reconstruct the F1-F8 feature vector for every `ct_specialist_reads` wakeup
across the 14-day rolling window so the H0-A / H0-B / H0-C decision tree in
the brief can be evaluated. Today's pipeline lays down the writer; statistical
analysis (Hartigan dip, per-ticker logistic regression) deferred ~3 weeks.

## Phase A verification (2026-05-08)

- **UW budget impact: NONE.** All 8 features reconstruct from internal Supabase
  tables and RPCs (`ct_flow_pulse`, `flowHeatmapContext`, `ct_ticker_snapshots`,
  `news_causality`, `ct_events`, `ct_signature_alarms`, deterministic, `ct_flag_grades`).
  Zero UW MCP calls. The brief's "~4,000 RPCs" figure is internal PostgREST/RPC,
  not UW. Recent UW pct: 64-65% (12-13k of 20k daily cap). No constraint.
- **MSFT exclusion is analytical, not pipeline-coupled.** MSFT remains a normal
  watchlist member in `_shared/watchlist.ts`, `_shared/uwClient.ts`,
  `_shared/edgePriors.ts`, `tickerCoherenceValidator.ts`. The script will reconstruct
  MSFT wakeups; statistical analysis will mark MSFT inconclusive. Excluding from
  the script would silently break parallel-track with MSFT Phase A.6.
- **MSFT N=13/wk vs 14d power: brief was conservative.** Empirical 14-day
  (2026-04-23 → 2026-05-07) per-ticker `ct_specialist_reads` counts show
  MSFT=46, NVDA=37 — both clear N≥30 in the rolling window. The brief's
  "~10-15 trading days to clear MSFT" was likely framed off a 7-day pull.
  Logged as a candidate for cascade-catalog instance #12 (premise-staleness).

## How to run (when loaders are filled in)

```bash
deno run --allow-net --allow-env scripts/d3_experiment/run_experiment.ts \
  --window=14 --tickers=NVDA,AAPL,AMZN,TSLA,IWM,GOOGL,META,QQQ,SPY,MSFT
```

Expected runtime ~30 min wall (PostgREST + RPC, ~50ms × 4,000 calls).
Output appended to `ct_d3_feature_observations`.

## Output location

`public.ct_d3_feature_observations` — per-wakeup row keyed by
`(ticker, wakeup_at, generation_id)`. Migration:
`supabase/migrations/20260508_*_d3_feature_observations.sql` (write-only;
not deployed today).

## Files

- `feature_reconstruction.ts` — 8 feature loaders, all stubbed with TODO blocks.
  Each returns the type-correct shape so `run_experiment.ts` can compile.
- `run_experiment.ts` — orchestrator: pulls wakeups, runs loaders in parallel
  per wakeup, writes rows.
- `cron_schedule.sql` — design-only daily window-extension cron, NOT deployed.

## Discipline

- Phase A first, scaffolding second. Loaders are stubs until each is verified
  individually against a held-out set of wakeups (per brief §4 reconstruction
  check).
- No statistical analysis in this pipeline. Analysis lives in terminal-Claude
  per Tenet 26 (three-mode architecture).
- No fork pick today.

## D2.2 dependency (verdict-report forward-handling)

When D3 closes (14-day capture + analysis), its verdict report MUST explicitly handle the D2.2 dependency. D2.2 was rendered PASS on 2026-05-13, conditional on D3 → bimodal. D3's resolution of the bimodal-vs-continuous fork retroactively confirms or re-opens D2.2:

| D3 outcome | D2.2 disposition | Action |
|---|---|---|
| **bimodal** | PASS stands | GOOGL/AMZN/META join AAPL/NVDA as hardened. Note in D3 verdict report. No engine-room operational work. |
| **continuous** | RE-OPENS | Empty 5-day marginal band under continuous distribution is structurally surprising; threshold-drop becomes suspicious. Captain re-renders D2.2 per the surprise. May involve threshold revert (55 → 60) or different parameter. |
| **hybrid** | RE-OPENS per fork's actual shape | Captain re-renders D2.2 against the empirical mixture (e.g., bimodal on some tickers, continuous on others). |

Full reasoning chain: `docs/decisions/2026-05-13-d2.2-verdict-pass-conditional-on-d3.md`.

Methodology pattern motivated by this dependency: `docs/methodology-patterns.md` ## `threshold-calibration-test-premise-requires-distribution-shape-verification`.
