-- Backfill ct_sweeps.type / strike / expiry / ask_side_perc from stored raw payload.
-- UW returns no `type`/`strike`/`ask_side_perc` field; these are derived from
-- option_symbol (OCC format) and ask_side_volume/bid_side_volume. Until the
-- ingester fix in this same commit, 6,300+ rows were written with NULL
-- direction-tagging fields, making sweep signals invisible to attribution.
--
-- Wrapped in a function to avoid psql CLI complaints on complex literals.
-- Call via REST: POST /rpc/ct_backfill_sweeps_from_raw

CREATE OR REPLACE FUNCTION public.ct_backfill_sweeps_from_raw()
RETURNS INT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_rows INT;
BEGIN
  WITH updated AS (
    UPDATE public.ct_sweeps
    SET
      type = COALESCE(
        type,
        substring(option_symbol FROM '^[A-Z0-9]+?[0-9]{6}([CP])[0-9]{8}$')
      ),
      strike = COALESCE(
        strike,
        NULLIF(substring(option_symbol FROM '([0-9]{8})$'), '')::numeric / 1000
      ),
      expiry = COALESCE(
        expiry,
        to_date(substring(option_symbol FROM '^[A-Z0-9]+?([0-9]{6})[CP][0-9]{8}$'), 'YYMMDD')
      ),
      ask_side_perc = COALESCE(
        ask_side_perc,
        CASE
          WHEN NULLIF((raw->>'ask_side_volume')::text, '') IS NOT NULL
           AND NULLIF((raw->>'bid_side_volume')::text, '') IS NOT NULL
           AND ((raw->>'ask_side_volume')::numeric + (raw->>'bid_side_volume')::numeric) > 0
          THEN (
            (raw->>'ask_side_volume')::numeric
            / ((raw->>'ask_side_volume')::numeric + (raw->>'bid_side_volume')::numeric)
          ) * 100
        END
      )
    WHERE option_symbol ~ '^[A-Z0-9]+?[0-9]{6}[CP][0-9]{8}$'
      AND (type IS NULL OR strike IS NULL OR expiry IS NULL OR ask_side_perc IS NULL)
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM updated;
  RETURN v_rows;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_backfill_sweeps_from_raw() TO service_role;
