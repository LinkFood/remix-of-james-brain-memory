-- ============================================================================
-- Phase 7a (cont.) — claim RPC + cron drainer for ct_specialist_reads embedding.
--
-- Specialists are RTH-only producers (10 wakeups/6 min RTH ~= 60 rows/hr).
-- Off-RTH scheduling buys nothing. Schedule: every 5 min RTH (UTC 13-21 = ET 09-17).
--
-- claim_unembedded_specialist_reads uses FOR UPDATE SKIP LOCKED + zero-vector
-- sentinel to give concurrent callers disjoint slices. Same pattern as
-- claim_unembedded_breaking_news / claim_unembedded_tape_commentary (PR #94,
-- cascade #45). The sentinel is rewritten on success; stuck rows
-- (drainer crash) detectable as embedding IS NOT NULL AND rich_text IS NULL.
--
-- Idempotent unschedule-then-schedule per feedback_pg_cron_schedule_idempotency.md.
-- apikey-header pattern handled by 20260507170000_apikey_in_invoke_edge_function.sql.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. Atomic claim RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_unembedded_specialist_reads(p_batch_size int)
RETURNS TABLE (
  id             bigint,
  updated_at     timestamptz,
  ticker         text,
  direction_lean text,
  conviction     int,
  flagged        boolean,
  flag_id        uuid,
  read_text      text,
  session_date   date
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH claimed AS (
    SELECT r.id
    FROM public.ct_specialist_reads r
    WHERE r.embedding IS NULL
    ORDER BY r.updated_at DESC
    LIMIT GREATEST(p_batch_size, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ct_specialist_reads u
  SET embedding = (('[' || repeat('0,', 511) || '0]')::extensions.vector(512))
  FROM claimed c
  WHERE u.id = c.id
  RETURNING u.id, u.updated_at, u.ticker, u.direction_lean, u.conviction,
            u.flagged, u.flag_id, u.read_text,
            (u.updated_at AT TIME ZONE 'America/New_York')::date AS session_date;
$fn$;

GRANT EXECUTE ON FUNCTION public.claim_unembedded_specialist_reads(int) TO service_role;

COMMENT ON FUNCTION public.claim_unembedded_specialist_reads IS
  'Atomic claim of un-embedded ct_specialist_reads rows for the drainer. Uses FOR UPDATE SKIP LOCKED to ensure concurrent callers get disjoint slices. Sets a zero-vector sentinel so subsequent claims skip these rows; the drainer overwrites with the real embedding + rich_text on success. Stuck rows (drainer crash) detectable as embedding IS NOT NULL AND rich_text IS NULL. session_date derived as the updated_at-in-ET trading-day key.';

-- ----------------------------------------------------------------------------
-- 2. Cron drainer schedule — RTH only
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('ct-embed-specialist-reads-rth')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-embed-specialist-reads-rth');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-embed-specialist-reads-rth',
  '*/5 13-21 * * 1-5',
  $cron$ SELECT public.invoke_edge_function('ct-embed-specialist-reads', '{"batch_size": 50}'::jsonb); $cron$
);
