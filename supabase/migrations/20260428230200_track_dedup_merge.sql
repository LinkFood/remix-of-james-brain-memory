-- Collapse ct_contract_tracks to one row per option_symbol (WORKING-only).
--
-- Merge rules (locked by user 2026-04-28):
--   - Canonical row = the row with the EARLIEST print_time. Preserves the
--     first-fired entry signal — if a contract starts trickling in, you want
--     the entry the system saw first, not a midpoint of all prints.
--   - entry_contract_price stays at the canonical row's value (FIRST fired,
--     NOT averaged). Same first-fired logic.
--   - print_count = COUNT(*) of all merged rows for that option_symbol.
--   - last_print_at = MAX(print_time) — most-recent re-print.
--   - peak_contract_pct = MAX (best favourable move ever observed across all
--     merged rows — never lose the multibagger reading).
--   - max_drawdown_pct = MIN (worst drawdown ever observed — likewise).
--   - sweep_count = SUM (preserve total poll history across all dup rows; the
--     poller's per-row sweep_count was effectively double-counting work
--     against the same contract anyway, but the ledger value matters).
--   - first_alert_id = alert_id of the canonical (earliest) row.
--
-- ONLY merge WHERE track_status = 'WORKING'. Closed/expired rows are immutable
-- history — the option already hit terminal state, the merge would lie about
-- when it happened and which alert lifecycle it belonged to.
SET search_path = public, extensions;

-- Step 1: identify dup groups + canonical row per group.
WITH dups AS (
  SELECT option_symbol, MIN(print_time) AS canonical_print_time
  FROM public.ct_contract_tracks
  WHERE track_status = 'WORKING'
  GROUP BY option_symbol
  HAVING COUNT(*) > 1
),
canonical AS (
  -- Pick exactly ONE id per option_symbol even if two rows share the same
  -- min(print_time) — DISTINCT ON guarantees uniqueness so the partial index
  -- in Phase 4 won't fail.
  SELECT DISTINCT ON (t.option_symbol)
         t.id AS canonical_id,
         t.option_symbol,
         t.alert_id AS canonical_alert_id
  FROM public.ct_contract_tracks t
  JOIN dups d
    ON d.option_symbol = t.option_symbol
   AND t.print_time = d.canonical_print_time
  WHERE t.track_status = 'WORKING'
  ORDER BY t.option_symbol, t.id
),
agg AS (
  SELECT t.option_symbol,
         COUNT(*)::int       AS new_print_count,
         MAX(t.print_time)   AS new_last_print_at,
         MAX(t.peak_contract_pct) AS new_peak,
         MIN(t.max_drawdown_pct)  AS new_drawdown,
         SUM(t.sweep_count)::int  AS new_sweep_count
  FROM public.ct_contract_tracks t
  JOIN dups d ON d.option_symbol = t.option_symbol
  WHERE t.track_status = 'WORKING'
  GROUP BY t.option_symbol
)
UPDATE public.ct_contract_tracks ct
SET print_count       = agg.new_print_count,
    last_print_at     = agg.new_last_print_at,
    peak_contract_pct = agg.new_peak,
    max_drawdown_pct  = agg.new_drawdown,
    sweep_count       = agg.new_sweep_count,
    first_alert_id    = canonical.canonical_alert_id
FROM agg, canonical
WHERE ct.id = canonical.canonical_id
  AND canonical.option_symbol = agg.option_symbol;

-- Step 2: delete non-canonical duplicates among WORKING rows.
WITH dups AS (
  SELECT option_symbol, MIN(print_time) AS canonical_print_time
  FROM public.ct_contract_tracks
  WHERE track_status = 'WORKING'
  GROUP BY option_symbol
  HAVING COUNT(*) > 1
),
canonical AS (
  SELECT DISTINCT ON (t.option_symbol)
         t.id AS canonical_id,
         t.option_symbol
  FROM public.ct_contract_tracks t
  JOIN dups d
    ON d.option_symbol = t.option_symbol
   AND t.print_time = d.canonical_print_time
  WHERE t.track_status = 'WORKING'
  ORDER BY t.option_symbol, t.id
)
DELETE FROM public.ct_contract_tracks t
USING canonical c
WHERE t.option_symbol = c.option_symbol
  AND t.track_status = 'WORKING'
  AND t.id <> c.canonical_id;
