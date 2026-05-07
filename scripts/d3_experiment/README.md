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
