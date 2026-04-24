-- ct_rescore_flow_since — re-run ct_score_flow_event against every
-- ct_scored_flow row whose event_ts is within the last N hours, pulling
-- the original raw inputs from the source tables (ct_sweeps, ct_flow_alerts).
--
-- We need this to backfill score_breakdown.t1_oi on rows scored before
-- migration 20260424000021. Rows whose source was deleted or whose side
-- can't be re-derived are skipped (count returned reflects rows actually
-- updated).

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_rescore_flow_since(
  p_since_hours INT DEFAULT 48
) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
DECLARE
  v_count   INTEGER := 0;
  v_cutoff  TIMESTAMPTZ := now() - make_interval(hours => p_since_hours);
  r         RECORD;
  j         JSONB;
BEGIN
  -- ---- ct_sweeps-sourced rows ----
  FOR r IN
    SELECT
      sf.id                     AS scored_id,
      sf.ticker                 AS ticker,
      sf.option_symbol          AS option_symbol,
      sf.event_ts               AS event_ts,
      sw.strike                 AS strike,
      sw.expiry                 AS expiry,
      sw.type                   AS side,        -- 'C' | 'P'
      sw.premium                AS premium,
      sw.volume::integer        AS volume,
      sw.open_interest::integer AS open_interest,
      sw.ask_side_perc          AS ask_side_perc
    FROM public.ct_scored_flow sf
    JOIN public.ct_sweeps sw ON sw.id::text = sf.source_id
    WHERE sf.source_table = 'ct_sweeps'
      AND sf.event_ts >= v_cutoff
  LOOP
    IF r.side IS NULL THEN CONTINUE; END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      TRUE,   -- is_sweep
      FALSE,  -- is_multileg
      FALSE   -- is_floor
    );

    UPDATE public.ct_scored_flow SET
      classification    = j->>'classification',
      direction         = j->>'direction',
      score             = (j->>'score')::numeric,
      raw_score         = (j->>'raw_score')::numeric,
      score_breakdown   = j->'breakdown',
      penalty_breakdown = j->'penalty',
      delta_est         = NULLIF(j->>'delta_est','')::numeric,
      iv_rank_at_event  = NULLIF(j->>'iv_rank','')::numeric,
      scored_at         = now()
    WHERE id = r.scored_id;
    v_count := v_count + 1;
  END LOOP;

  -- ---- ct_flow_alerts-sourced rows ----
  FOR r IN
    SELECT
      sf.id                                            AS scored_id,
      sf.ticker                                        AS ticker,
      sf.option_symbol                                 AS option_symbol,
      sf.event_ts                                      AS event_ts,
      fa.strike                                        AS strike,
      fa.expiry                                        AS expiry,
      CASE
        WHEN lower(COALESCE(fa.side, fa.raw->>'type', '')) LIKE 'c%' THEN 'C'
        WHEN lower(COALESCE(fa.side, fa.raw->>'type', '')) LIKE 'p%' THEN 'P'
        ELSE NULL
      END                                              AS side,
      fa.premium                                       AS premium,
      fa.volume::integer                               AS volume,
      fa.open_interest::integer                        AS open_interest,
      CASE
        WHEN (fa.raw->>'total_ask_side_prem')::numeric IS NOT NULL
         AND (fa.raw->>'total_bid_side_prem')::numeric IS NOT NULL
         AND ((fa.raw->>'total_ask_side_prem')::numeric + (fa.raw->>'total_bid_side_prem')::numeric) > 0
        THEN 100.0 * (fa.raw->>'total_ask_side_prem')::numeric
             / ((fa.raw->>'total_ask_side_prem')::numeric + (fa.raw->>'total_bid_side_prem')::numeric)
        ELSE NULL
      END                                              AS ask_side_perc,
      COALESCE((fa.raw->>'has_sweep')::boolean, FALSE)    AS is_sweep,
      COALESCE((fa.raw->>'has_multileg')::boolean, FALSE) AS is_multileg,
      COALESCE((fa.raw->>'has_floor')::boolean, FALSE)    AS is_floor,
      CASE
        WHEN fa.raw ? 'all_opening_trades'
          THEN (fa.raw->>'all_opening_trades')::boolean
        ELSE NULL
      END                                              AS all_opening
    FROM public.ct_scored_flow sf
    JOIN public.ct_flow_alerts fa ON fa.alert_id = sf.source_id
    WHERE sf.source_table = 'ct_flow_alerts'
      AND sf.event_ts >= v_cutoff
  LOOP
    IF r.side IS NULL OR r.ask_side_perc IS NULL THEN CONTINUE; END IF;

    j := public.ct_score_flow_event(
      r.ticker, r.option_symbol, r.strike, r.expiry,
      r.side, r.premium, r.volume, r.open_interest, r.ask_side_perc,
      r.event_ts,
      r.is_sweep,
      r.is_multileg,
      r.is_floor,
      r.all_opening
    );

    UPDATE public.ct_scored_flow SET
      classification    = j->>'classification',
      direction         = j->>'direction',
      score             = (j->>'score')::numeric,
      raw_score         = (j->>'raw_score')::numeric,
      score_breakdown   = j->'breakdown',
      penalty_breakdown = j->'penalty',
      delta_est         = NULLIF(j->>'delta_est','')::numeric,
      iv_rank_at_event  = NULLIF(j->>'iv_rank','')::numeric,
      scored_at         = now()
    WHERE id = r.scored_id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_rescore_flow_since(INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_rescore_flow_since(INT) IS
  'Reruns ct_score_flow_event against all ct_scored_flow rows in the last N hours, rebuilding breakdown (including new t1_oi block). Returns count updated.';
