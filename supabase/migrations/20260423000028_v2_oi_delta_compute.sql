-- =============================================================================
-- 20260423000028_v2_oi_delta_compute.sql
--
-- Co-Trader v2 Phase 1c — OI change tracker delta compute.
--
-- After ct-oi-snapshot upserts the top-40 OI contracts per ticker, this RPC
-- fills in oi_delta_1d and oi_delta_5d for any rows where they are still NULL.
--
-- Strategy:
--   For each NULL-delta row, look up the same (ticker, option_symbol) on
--   snap_date - 1 day and snap_date - 5 days, and subtract. If multiple slots
--   exist on the prior day, prefer the most recent slot (close > mid > open).
--
-- Called at the end of each ct-oi-snapshot run so by the end of the day's
-- close slot, T+1 OI confirmation is computable off a single lookup.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_compute_oi_deltas()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_updated INTEGER;
BEGIN
  WITH updates AS (
    SELECT
      s.id,
      s.oi - p1.oi AS d1,
      s.oi - p5.oi AS d5
    FROM public.ct_oi_snapshots s
    LEFT JOIN LATERAL (
      SELECT oi FROM public.ct_oi_snapshots
      WHERE ticker = s.ticker
        AND option_symbol = s.option_symbol
        AND snap_date = s.snap_date - INTERVAL '1 day'
      ORDER BY CASE snap_slot
          WHEN 'close' THEN 3
          WHEN 'mid'   THEN 2
          WHEN 'open'  THEN 1
          ELSE 0 END DESC
      LIMIT 1
    ) p1 ON TRUE
    LEFT JOIN LATERAL (
      SELECT oi FROM public.ct_oi_snapshots
      WHERE ticker = s.ticker
        AND option_symbol = s.option_symbol
        AND snap_date = s.snap_date - INTERVAL '5 days'
      ORDER BY CASE snap_slot
          WHEN 'close' THEN 3
          WHEN 'mid'   THEN 2
          WHEN 'open'  THEN 1
          ELSE 0 END DESC
      LIMIT 1
    ) p5 ON TRUE
    WHERE s.oi_delta_1d IS NULL
  )
  UPDATE public.ct_oi_snapshots t
  SET oi_delta_1d = u.d1,
      oi_delta_5d = u.d5
  FROM updates u
  WHERE t.id = u.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_compute_oi_deltas() TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_compute_oi_deltas() IS
  'V2 Phase 1c: populate oi_delta_1d / oi_delta_5d for ct_oi_snapshots rows. Called at end of ct-oi-snapshot runs so T+1 OI confirmation is always fresh.';
