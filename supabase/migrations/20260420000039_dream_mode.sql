-- =============================================================================
-- 20260420000039_dream_mode.sql
--
-- ct_dreams — Claude's overnight reflection on the session just closed.
--
-- Why this exists: between EOD (21:30 UTC) and morning brief (10:45 UTC) there
-- is a ~13-hour silence. Dream Mode fires at 06:00 UTC (1am ET during DST,
-- 2am EST) and produces a loose, stream-of-consciousness reflection on the
-- session. Not structured analysis — free-association. Pattern-matches
-- today's session against recent history, notices things the structured EOD
-- couldn't capture, seeds the next morning's thinking.
--
-- Cadence: weekdays only (no session to reflect on over the weekend). First
-- few dreams will be thin while the 10-day session-embedding context
-- accumulates; that is expected and documented in the edge function.
--
-- Cost: ~$0.03–0.05 per dream (Sonnet, 3-5k tokens in, ~2k out).
-- Annualized: ~$0.75/month. Negligible.
--
-- Storage pattern: embedding lives on the ct_dreams row directly (same
-- pattern as ct_debates / ct_session_embeddings — dreams are a first-class
-- searchable entity, not a sidecar on ct_embeddings).
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_dreams (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date          date        NOT NULL,          -- the day being reflected on
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- The dream itself.
  reflection            text        NOT NULL,          -- 3-5 paragraphs of loose prose
  patterns_noticed      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  connections_drawn     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tomorrow_hypotheses   jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Voyage 512-dim embedding of the reflection text. Written once on save.
  embedding             extensions.vector(512),

  -- Cost accounting.
  tokens_used           integer,
  cost_usd              numeric(10, 6)
);

COMMENT ON TABLE  public.ct_dreams IS
  'Overnight Claude reflection on a closed session. Fires weekdays at 06:00 UTC via ct-dream. Loose stream-of-consciousness, not structured analysis. Feeds morning brief hypotheses.';
COMMENT ON COLUMN public.ct_dreams.session_date IS
  'The trading day being reflected on (not the day the dream was written — they are separated by ~9 hours).';
COMMENT ON COLUMN public.ct_dreams.patterns_noticed IS
  'jsonb array: [{ pattern: string, evidence_refs: string[] }]';
COMMENT ON COLUMN public.ct_dreams.connections_drawn IS
  'jsonb array: [{ today_thing, past_thing, why_connected }]';
COMMENT ON COLUMN public.ct_dreams.tomorrow_hypotheses IS
  'jsonb array: [{ hypothesis, how_to_test }] — piped into ct-morning-brief as testable priors.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
-- Latest-first lookup for the DreamLog panel.
CREATE INDEX IF NOT EXISTS ct_dreams_session_date_idx
  ON public.ct_dreams (session_date DESC);

-- IVFFlat for semantic recall ("what were you dreaming about last time we
-- saw this setup?"). lists=100 matches the small-corpus pattern used by
-- ct_debates / ct_session_embeddings. Rebuild when corpus exceeds ~10K
-- dreams, which at ~250 weekdays/year is ~40 years out.
CREATE INDEX IF NOT EXISTS ct_dreams_ivfflat
  ON public.ct_dreams
  USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 100);

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service role full. Mirrors ct_session_embeddings.
-- ct_dreams are per-instance (single-user MVP) not per-user, so no user_id
-- column. If this ever goes multi-user, add user_id + tighten policies.
-- -----------------------------------------------------------------------------
ALTER TABLE public.ct_dreams ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_dreams_authenticated_read ON public.ct_dreams;
CREATE POLICY ct_dreams_authenticated_read
  ON public.ct_dreams FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_dreams_service_all ON public.ct_dreams;
CREATE POLICY ct_dreams_service_all
  ON public.ct_dreams FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Manual-trigger RPC — mirrors every other ct-* cron. Called from /health
-- "Run now" button if we wire one, and usable in SQL for ad-hoc backfills.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_dream()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-dream'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_dream()
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Cron — weekdays only at 06:00 UTC.
-- 06:00 UTC = 01:00 ET during DST (EDT, Mar–Nov), 02:00 ET standard (EST).
-- Weekend suppression: `* * 1-5` (Mon–Fri). No session closed on Sat/Sun,
-- so nothing to reflect on.
-- Note: on Tuesday morning this reflects on Monday's session, etc. Monday
-- mornings would normally reflect on Sunday (which had no session) — but
-- because we run Mon–Fri, Monday 06:00 UTC reflects on... actually let's be
-- precise: the cron fires Mon–Fri 06:00 UTC. Mon 06:00 UTC is ~2am ET Mon
-- = after the weekend (Fri was the last session). The edge function picks
-- "most recent trading day" = Friday. Tue 06:00 UTC reflects on Mon. Etc.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-dream',
  '0 6 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-dream',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
