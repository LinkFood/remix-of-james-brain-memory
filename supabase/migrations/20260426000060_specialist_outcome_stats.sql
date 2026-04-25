-- ct_specialist_scoreboard + ct_specialist_outcome_stats RPC.
--
-- Purpose: replace activity-Elo (points for flagging) with outcome-Elo
-- (points for being right). Joins ct_flags to ct_contract_tracks on
-- option_symbol within ±2h of the flag's created_at, so the per-flag truth
-- is the contract's lifetime peak/track_status — not an arbitrary horizon.
--
-- Tenet 4: this closes the learning-loop link "specialist proposed → graded
-- truth" with a structural join, not a per-row scorer cron. If the truth
-- dataset (ct_contract_tracks) updates, the scoreboard reflects it on next
-- nightly snapshot — no backfill needed.
--
-- Naming: the ct_flags column is `specialist_ticker` (one specialist per
-- ticker). The scoreboard exposes it as `specialist_name` to match the
-- public contract (each specialist's name == its ticker today, but the
-- field is forward-compatible with multi-specialist-per-ticker).

SET search_path = public, extensions;

-- Daily snapshot per specialist. UNIQUE on (specialist_name, snap_date) so
-- the nightly upsert is idempotent.
CREATE TABLE IF NOT EXISTS public.ct_specialist_scoreboard (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specialist_name   text NOT NULL,
  snap_date         date NOT NULL,
  flags_total       integer NOT NULL DEFAULT 0,
  flags_with_track  integer NOT NULL DEFAULT 0,
  wins              integer NOT NULL DEFAULT 0,
  losses            integer NOT NULL DEFAULT 0,
  flat              integer NOT NULL DEFAULT 0,
  hit_rate          numeric,
  median_peak_pct   numeric,
  expected_peak_pct numeric,
  top_pick          text,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (specialist_name, snap_date)
);

CREATE INDEX IF NOT EXISTS ct_specialist_scoreboard_snap_date
  ON public.ct_specialist_scoreboard (snap_date DESC, hit_rate DESC NULLS LAST);

ALTER TABLE public.ct_specialist_scoreboard ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_specialist_scoreboard_authread ON public.ct_specialist_scoreboard
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_specialist_scoreboard_svcall ON public.ct_specialist_scoreboard
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_scoreboard IS
  'Daily outcome snapshot per specialist. Built from ct_specialist_outcome_stats() — wins/losses derived from ct_contract_tracks.track_status, not from activity volume.';

-- ---------------------------------------------------------------------------
-- ct_specialist_outcome_stats(p_since_days)
--
-- One row per specialist over the trailing window. Joins ct_flags to
-- ct_contract_tracks on option_symbol where the track was first observed
-- within ±2h of the flag's created_at — that window scopes the truth to
-- contracts the specialist actually picked, not coincidental same-symbol
-- prints from elsewhere in the day.
--
-- track_status semantics (from ct_contract_tracks):
--   WIN / EXPIRED_WIN   → wins
--   LOSS / EXPIRED_LOSS → losses
--   EXPIRED_FLAT        → flat (no edge either way)
--   WORKING             → working (still tracking, excluded from hit_rate)
--
-- hit_rate = wins / (wins + losses + flat). Working tracks excluded so a
-- specialist who flagged 100 things last hour doesn't get 100% from
-- in-flight tracks.
--
-- expected_peak_pct = AVG(peak_contract_pct) weighted 1.0 for WINs / 0 for
-- losses. Crude "what-if-we-bought-every-pick" proxy in decimal-fraction
-- terms (matches ct_contract_tracks.peak_contract_pct convention).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ct_specialist_outcome_stats(p_since_days integer)
RETURNS TABLE (
  specialist_name    text,
  flags_total        bigint,
  flags_with_track   bigint,
  wins               bigint,
  losses             bigint,
  flat               bigint,
  working            bigint,
  hit_rate           numeric,
  median_peak_pct    numeric,
  expected_peak_pct  numeric,
  top_pick           text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH window_start AS (
    SELECT (now() - make_interval(days => GREATEST(p_since_days, 1)))::timestamptz AS ts
  ),
  -- Each flag joined to its truth row (or NULL) — left join preserves
  -- ungraded flags so flags_total reflects all activity, not just picks
  -- with truth coverage.
  flag_truth AS (
    -- Join on print_time, NOT first_tracked_at: print_time is when the
    -- underlying tape print happened (the moment the specialist flagged
    -- against). first_tracked_at is when the print-grader created the row
    -- (often hours later in a backfill sweep) and would mis-window the
    -- truth join. ±2h tolerates a specialist reading slightly before/after
    -- the official print stamp.
    SELECT
      f.specialist_ticker                    AS specialist_name,
      f.option_symbol,
      f.created_at,
      t.track_status,
      t.peak_contract_pct,
      t.print_time
    FROM public.ct_flags f
    LEFT JOIN public.ct_contract_tracks t
      ON t.option_symbol = f.option_symbol
     AND t.print_time BETWEEN f.created_at - interval '2 hours'
                           AND f.created_at + interval '2 hours'
    WHERE f.created_at >= (SELECT ts FROM window_start)
      AND f.option_symbol IS NOT NULL
  ),
  -- Top pick = the joined track with the highest peak per specialist.
  top_picks AS (
    SELECT DISTINCT ON (specialist_name)
      specialist_name,
      option_symbol AS top_pick
    FROM flag_truth
    WHERE peak_contract_pct IS NOT NULL
    ORDER BY specialist_name, peak_contract_pct DESC NULLS LAST
  ),
  agg AS (
    SELECT
      specialist_name,
      COUNT(*)                                                      AS flags_total,
      COUNT(track_status)                                           AS flags_with_track,
      COUNT(*) FILTER (WHERE track_status IN ('WIN','EXPIRED_WIN')) AS wins,
      COUNT(*) FILTER (WHERE track_status IN ('LOSS','EXPIRED_LOSS')) AS losses,
      COUNT(*) FILTER (WHERE track_status = 'EXPIRED_FLAT')         AS flat,
      COUNT(*) FILTER (WHERE track_status = 'WORKING')              AS working,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY peak_contract_pct) AS median_peak_pct,
      AVG(
        CASE
          WHEN track_status IN ('WIN','EXPIRED_WIN')   THEN peak_contract_pct
          WHEN track_status IN ('LOSS','EXPIRED_LOSS') THEN 0
          ELSE NULL
        END
      ) AS expected_peak_pct
    FROM flag_truth
    GROUP BY specialist_name
  )
  SELECT
    a.specialist_name,
    a.flags_total,
    a.flags_with_track,
    a.wins,
    a.losses,
    a.flat,
    a.working,
    -- NULLIF guards a no-graded-flags specialist (don't divide by zero,
    -- don't fake a 0% hit rate).
    (a.wins::numeric / NULLIF(a.wins + a.losses + a.flat, 0))     AS hit_rate,
    a.median_peak_pct,
    a.expected_peak_pct,
    tp.top_pick
  FROM agg a
  LEFT JOIN top_picks tp USING (specialist_name)
  ORDER BY hit_rate DESC NULLS LAST, a.flags_total DESC;
$$;

GRANT EXECUTE ON FUNCTION public.ct_specialist_outcome_stats(integer)
  TO authenticated, service_role, anon;

COMMENT ON FUNCTION public.ct_specialist_outcome_stats(integer) IS
  'Per-specialist outcome stats over trailing window. Joins ct_flags to ct_contract_tracks on option_symbol within ±2h of flag created_at. Truth source: ct_contract_tracks.track_status + peak_contract_pct.';
