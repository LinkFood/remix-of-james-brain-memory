-- Manually recompute OI deltas after the backfill loaded 2-day snapshot pairs.
DO $$
DECLARE
  _updated INTEGER;
BEGIN
  SELECT public.ct_compute_oi_deltas() INTO _updated;

  INSERT INTO public.ct_heartbeats(status_line, watching, current_reads, prompt_version)
  VALUES (
    '[oi-compute-deltas] manual post-backfill: updated=' || _updated,
    ARRAY['ct-compute-oi-deltas'],
    jsonb_build_object('updated', _updated),
    'oi-compute-deltas-manual'
  );
END $$;
