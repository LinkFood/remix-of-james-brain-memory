-- marketClock — single source of truth for "is the market open" and trading-time
-- arithmetic. Co-Trader's pre-clock code treated calendar time as trading time;
-- specialists wrote horizon_ts = now() + horizon_hours, which let weekend hours
-- count as trading hours and produced flag horizons that landed Saturday with
-- frozen Friday-close spot. These functions and the matching TS module fix that.
--
-- Constants: NYSE RTH 09:30–16:00 America/New_York, Mon-Fri. DST handled by the
-- timezone conversion. Holiday list is currently empty — add as they approach.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.market_open(p_ts timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
  WITH ny AS (
    SELECT (p_ts AT TIME ZONE 'America/New_York') AS ny_ts
  )
  SELECT
    EXTRACT(DOW FROM ny.ny_ts)::int BETWEEN 1 AND 5
    AND ny.ny_ts::time >= '09:30'::time
    AND ny.ny_ts::time < '16:00'::time
  FROM ny;
$fn$;

GRANT EXECUTE ON FUNCTION public.market_open(timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.next_market_open(p_ts timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
DECLARE
  ny TIMESTAMP;       -- naive NY local time
  d DATE;
  dow INT;
  candidate TIMESTAMP;
BEGIN
  ny := p_ts AT TIME ZONE 'America/New_York';
  d := ny::date;
  dow := EXTRACT(DOW FROM d)::int;

  -- Same-day case: if it's a weekday and we're before 09:30, today's open works
  IF dow BETWEEN 1 AND 5 AND ny::time < '09:30'::time THEN
    candidate := d::timestamp + INTERVAL '9 hours 30 minutes';
    RETURN candidate AT TIME ZONE 'America/New_York';
  END IF;

  -- Else advance day-by-day until we land on Mon-Fri
  LOOP
    d := d + 1;
    dow := EXTRACT(DOW FROM d)::int;
    EXIT WHEN dow BETWEEN 1 AND 5;
  END LOOP;
  candidate := d::timestamp + INTERVAL '9 hours 30 minutes';
  RETURN candidate AT TIME ZONE 'America/New_York';
END
$fn$;

GRANT EXECUTE ON FUNCTION public.next_market_open(timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.last_market_close(p_ts timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
DECLARE
  ny TIMESTAMP;
  d DATE;
  dow INT;
  candidate TIMESTAMP;
BEGIN
  ny := p_ts AT TIME ZONE 'America/New_York';
  d := ny::date;
  dow := EXTRACT(DOW FROM d)::int;

  -- Same-day case: weekday with time >= 16:00 → today's close
  IF dow BETWEEN 1 AND 5 AND ny::time >= '16:00'::time THEN
    candidate := d::timestamp + INTERVAL '16 hours';
    RETURN candidate AT TIME ZONE 'America/New_York';
  END IF;

  -- Walk backwards day-by-day until we hit a weekday
  LOOP
    d := d - 1;
    dow := EXTRACT(DOW FROM d)::int;
    EXIT WHEN dow BETWEEN 1 AND 5;
  END LOOP;
  candidate := d::timestamp + INTERVAL '16 hours';
  RETURN candidate AT TIME ZONE 'America/New_York';
END
$fn$;

GRANT EXECUTE ON FUNCTION public.last_market_close(timestamptz) TO authenticated, service_role;

-- The workhorse: add N trading hours to a timestamp, skipping weekends and
-- non-RTH time. If start is outside RTH it snaps forward to the next open
-- before counting. Used by:
--   * Specialist runner when computing horizon_ts from horizon_hours
--   * Phase A data repair to fix the 32 weekend-falling horizons created today
CREATE OR REPLACE FUNCTION public.add_trading_hours(p_start timestamptz, p_hours numeric)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions
AS $fn$
DECLARE
  ny TIMESTAMP;
  cur_date DATE;
  cur_time TIME;
  dow INT;
  remaining NUMERIC := p_hours;
  step NUMERIC;
BEGIN
  IF p_hours <= 0 THEN
    RETURN p_start;
  END IF;

  ny := p_start AT TIME ZONE 'America/New_York';

  LOOP
    cur_date := ny::date;
    cur_time := ny::time;
    dow := EXTRACT(DOW FROM cur_date)::int;

    -- Weekend → advance to Monday 09:30
    IF dow = 0 THEN  -- Sunday
      ny := (cur_date + 1)::timestamp + INTERVAL '9 hours 30 minutes';
      CONTINUE;
    ELSIF dow = 6 THEN  -- Saturday
      ny := (cur_date + 2)::timestamp + INTERVAL '9 hours 30 minutes';
      CONTINUE;
    END IF;

    -- Weekday. Snap to RTH window.
    IF cur_time < '09:30'::time THEN
      ny := cur_date::timestamp + INTERVAL '9 hours 30 minutes';
      CONTINUE;
    ELSIF cur_time >= '16:00'::time THEN
      ny := (cur_date + 1)::timestamp + INTERVAL '9 hours 30 minutes';
      CONTINUE;
    END IF;

    -- Inside RTH. Hours left in this trading day.
    step := EXTRACT(EPOCH FROM ('16:00'::time - ny::time)) / 3600.0;

    IF step >= remaining THEN
      ny := ny + (remaining * INTERVAL '1 hour');
      EXIT;
    END IF;

    remaining := remaining - step;
    ny := (cur_date + 1)::timestamp + INTERVAL '9 hours 30 minutes';
  END LOOP;

  RETURN ny AT TIME ZONE 'America/New_York';
END
$fn$;

GRANT EXECUTE ON FUNCTION public.add_trading_hours(timestamptz, numeric) TO authenticated, service_role;

-- Quick sanity check function — returns a JSON snapshot useful for debugging
-- without dumping the whole logic into queries.
CREATE OR REPLACE FUNCTION public.market_clock_state(p_ts timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $fn$
  SELECT jsonb_build_object(
    'now_utc',       p_ts,
    'now_ny',        (p_ts AT TIME ZONE 'America/New_York')::text,
    'is_open',       public.market_open(p_ts),
    'next_open',     public.next_market_open(p_ts),
    'last_close',    public.last_market_close(p_ts),
    'plus_4h',       public.add_trading_hours(p_ts, 4),
    'plus_24h',      public.add_trading_hours(p_ts, 24)
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.market_clock_state(timestamptz) TO authenticated, service_role;
