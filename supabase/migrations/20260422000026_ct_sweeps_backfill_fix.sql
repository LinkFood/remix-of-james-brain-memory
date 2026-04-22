-- Fix: original migration had COALESCE(date, text) type mismatch. Drop the
-- to_char and let to_date feed expiry as DATE directly.

CREATE OR REPLACE FUNCTION public.ct_backfill_sweeps_from_raw()
RETURNS INT
LANGUAGE plpgsql
AS $fn$
DECLARE v_rows INT;
BEGIN
  WITH updated AS (
    UPDATE public.ct_sweeps
    SET
      type = COALESCE(type, substring(option_symbol FROM '^[A-Z0-9]+?[0-9]{6}([CP])[0-9]{8}$')),
      strike = COALESCE(strike, NULLIF(substring(option_symbol FROM '([0-9]{8})$'), '')::numeric / 1000),
      expiry = COALESCE(expiry, to_date(substring(option_symbol FROM '^[A-Z0-9]+?([0-9]{6})[CP][0-9]{8}$'), 'YYMMDD')),
      ask_side_perc = COALESCE(
        ask_side_perc,
        CASE
          WHEN NULLIF((raw->>'ask_side_volume'), '') IS NOT NULL
           AND NULLIF((raw->>'bid_side_volume'), '') IS NOT NULL
           AND ((raw->>'ask_side_volume')::numeric + (raw->>'bid_side_volume')::numeric) > 0
          THEN ((raw->>'ask_side_volume')::numeric
                / ((raw->>'ask_side_volume')::numeric + (raw->>'bid_side_volume')::numeric)) * 100
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
