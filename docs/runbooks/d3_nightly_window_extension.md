# Runbook — D3 Feature-Isolation Nightly Window Extension

## Purpose

The D3 Feature-Isolation Experiment ([scope brief](../../scope/2026-05-08-d3-feature-isolation-experiment.md))
runs as a **manually invoked, terminal-Claude-only** orchestrator that
reconstructs F1-F8 feature vectors per `ct_specialist_reads` wakeup and writes
one row per (ticker, wakeup_at, generation_id) into
`ct_d3_feature_observations`. After 14 trading days the corpus locks and
statistical analysis begins (Hartigan's dip test + per-ticker logistic
regression, brief §4 Stage 1/2). The script is intentionally **NOT wired as
an edge function** — Tenet 26: analysis-mode work belongs in terminal-me, not
autonomous infra. The product of D3 is a fork decision (option A / B / C),
not a live service.

---

## Window calendar

Day 1 was already captured by the 2026-05-07 validation run; that run is being
**reclassified** as day 1, no re-run (see Idempotency below).

| Day | Date     | RTH window (UTC)                              | Action                                              |
|-----|----------|-----------------------------------------------|-----------------------------------------------------|
| 1   | Wed 5/6  | 13:30Z → 20:00Z                               | DONE — `tag=validation-2026-05-09` (55 rows, 0 err) |
| 2   | Thu 5/7  | 13:30Z → 20:00Z                               | run tonight after 20:00Z                            |
| 3   | Fri 5/8  | 13:30Z → 20:00Z                               | run Fri night                                       |
| 4   | Mon 5/11 | 13:30Z → 20:00Z                               | (skip Sat-Sun)                                      |
| 5-8 | 5/12-5/15| 13:30Z → 20:00Z                               | Tue-Fri                                             |
| 9   | Mon 5/18 | 13:30Z → 20:00Z                               | (skip Sat-Sun)                                      |
| 10-13| 5/19-5/22| 13:30Z → 20:00Z                              | Tue-Fri                                             |
| 14  | Tue 5/26 | 13:30Z → 20:00Z                               | **Memorial Day 5/25 closed → slides to Tue**        |

Day 14 lands on **Tue 2026-05-26**. Memorial Day pushes it one weekday past
the naive 14-weekday count. If any other holiday falls inside the window,
slide forward.

---

## Nightly command

After RTH closes (≥20:00 UTC), from project root. Replace date and day-NN
suffix per the calendar.

```bash
cd /Users/jameschellis/jac-agent-os
export SUPABASE_URL=https://rvhyotvklfowklzjahdd.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=$(npx supabase projects api-keys \
  --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')

deno run --allow-net --allow-env scripts/d3_experiment/run_experiment.ts \
  --start=2026-05-07T13:30:00Z \
  --end=2026-05-07T20:00:00Z \
  --tag=window-day-02-2026-05-07
```

Wall time: ~3-5 min for one RTH day (≈30-50 wakeups × 8 RPCs, parallel
batched). Distribution summary prints to stdout at the end.

---

## Verification after each run

The script prints a `DISTRIBUTION` JSON block. Check four things:

1. **`total`** — ~30-50 expected for normal RTH. Day 1 was 55. <20 means
   either the window is wrong (check UTC) or specialists genuinely
   no-event'd.
2. **`withErrors`** — must be 0. Any non-zero means a feature loader failed
   for ≥1 wakeup; inspect `perLoaderErrors` and the JSONB
   `reconstruction_error_flags`. Cross-check `get_brain_health(24)` for
   degraded organs.
3. **Distribution sanity** — F1-F8 should NOT be 100% saturated for one day.
   Single-day saturations expected and OK: F7 (`has_0dte_today`) high on
   Wed/Fri (Mag7 + ETFs) lower on Tue (ETFs only). F3 regime usually
   dominated by one state per day. F1/F2/F4/F6/F8 should show real spread.
   Bimodality only emerges at the **window** level, not daily.
4. **`per_ticker_count`** — each of 10 tickers ≥1 row unless a specialist
   genuinely no-event'd. Day 1 had MSFT=2; brief §6 calls MSFT/NVDA out as
   the weakest power tickers.

### SQL: per-night count by ticker

```sql
SELECT ticker, count(*) AS rows, max(reconstructed_at) AS last_rec
FROM public.ct_d3_feature_observations
WHERE generation_id LIKE 'd3_window-day-02-2026-05-07_%'
GROUP BY ticker ORDER BY ticker;
```

REST equivalent:
```bash
KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd \
  | grep service_role | awk '{print $NF}')
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_d3_feature_observations?generation_id=like.d3_window-day-02-*&select=ticker,reconstruction_error_flags" \
  -H "Authorization: Bearer $KEY" -H "apikey: $KEY"
```

---

## Idempotency contract — read before any re-run

**Idempotency is convention, not constraint.** The unique key is
`(generation_id, ticker, wakeup_at)`. The script generates a fresh
`generation_id` of form `d3_<tag>_<ISO-timestamp>` on every invocation, so
**running the same window twice produces TWO row sets** with different
generation_ids — both persist. This is intentional per the migration comment
("Reruns get a new generation_id so retroactive comparisons across
reconstruction-logic iterations are possible without destructive
overwrites").

Window-extension contract:

- **One `--tag` per night**: `window-day-NN-YYYY-MM-DD`.
- **Always pass `--start` and `--end`**; never rely on default `--window=14`,
  which would re-pull the entire trailing window every invocation.
- **Don't re-run a night** without auditing. If you must, use a distinct tag
  (`window-day-02-2026-05-07-rerun`) so row sets are separable downstream.
- **Aggregation queries filter by tag substring** in `generation_id`, not by
  `wakeup_at`. The tag is the analysis identifier.

### Recovery from a missed night

Skip Friday → catch up Monday: Mon evening run Monday's window normally;
Tuesday evening run Friday's missed window first with the day-3 tag, then
Tuesday's normal run after. Distinct tags = no row duplication. The script
does NOT auto-detect gaps; the calendar table is the source of truth.

### Verification: already captured?

Before running any night, check:
```bash
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_d3_feature_observations?generation_id=like.d3_window-day-02-*&select=generation_id&limit=1" \
  -H "Authorization: Bearer $KEY" -H "apikey: $KEY"
```
Empty `[]` = safe. Any row = already captured, do not re-run.

---

## Window-end auto-stop

The window is **complete** when 14 distinct day-tags are present:

```sql
SELECT count(DISTINCT
  substring(generation_id from 'd3_(window-day-[0-9]+-[0-9-]+)_')
) AS days_captured
FROM public.ct_d3_feature_observations
WHERE generation_id LIKE 'd3_window-day-%';
```

`days_captured >= 14` (validation counted as day 1) → window locks. Proceed
to statistical analysis per scope §4. Do NOT run additional nights past day
14 unless extending the window is explicitly chosen.

---

## Generation ID convention

Format: `d3_<tag>_<ISO-timestamp-with-colons-replaced>`. Examples:
- Day 1: `d3_validation-2026-05-09_2026-05-07T00-50-53-928Z`
- Day 2: `d3_window-day-02-2026-05-07_<ts>`

Analysis filters by tag substring:
```sql
WHERE generation_id ~ 'd3_(window-day-[0-9]+|validation-2026-05-09)'
```

The validation gen_id IS day 1; either include it explicitly or re-tag the
55 rows at analysis time. Defer that rename decision until query patterns
are clearer.

---

## Cross-references

- **Brief:** `scope/2026-05-08-d3-feature-isolation-experiment.md`
- **Migration:** `supabase/migrations/20260508000000_d3_feature_observations.sql`
  + `20260508020000_d3_feature_observations_read_id_bigint.sql` (cascade #30
  read_id type fix)
- **Loader:** `scripts/d3_experiment/feature_reconstruction.ts`
- **Orchestrator:** `scripts/d3_experiment/run_experiment.ts`
- **Tenet 26:** `CLAUDE.md` — analysis-mode lives in terminal, never edge fn.
