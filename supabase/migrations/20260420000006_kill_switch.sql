-- 20260420000006_kill_switch.sql
--
-- Emergency kill switch for Co-Trader.
--
-- One button. Flips a single row. Every Claude-calling or trade-writing edge
-- function must consult this at entry and skip when active. Chat READs pass
-- through; only chat's commit path is gated. Slack commands and UI reads are
-- NEVER gated — James always keeps a control channel.
--
-- The "single-row" invariant is enforced by a UNIQUE check on id=1 plus
-- matching RLS (no INSERTs allowed from clients — the seed row is it).
--
-- Auto-release: if auto_release_at is set and now() is past it, the
-- ct_killswitch_active() reader auto-disarms on read (lazy). No cron needed.

-- ============================================================================
-- Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ct_kill_switch (
  id                INTEGER     PRIMARY KEY DEFAULT 1,
  active            BOOLEAN     NOT NULL DEFAULT false,
  engaged_at        TIMESTAMPTZ,
  engaged_by        TEXT,                          -- 'rpc' | 'slack' | 'ui'
  engaged_reason    TEXT,
  auto_release_at   TIMESTAMPTZ,                   -- null = manual disarm only
  disarmed_at       TIMESTAMPTZ,
  disarmed_by       TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ct_kill_switch_singleton CHECK (id = 1)
);

-- Seed the singleton (idempotent)
INSERT INTO public.ct_kill_switch (id, active)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE  public.ct_kill_switch IS
  'Single-row emergency kill switch for all Claude-calling + trade-writing functions. id=1 singleton.';
COMMENT ON COLUMN public.ct_kill_switch.auto_release_at IS
  'If set, ct_killswitch_active() auto-disarms past this timestamp. Null = manual disarm only.';

-- ============================================================================
-- RLS — authenticated can read + update (single-user app). Service role bypasses.
-- ============================================================================
ALTER TABLE public.ct_kill_switch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_kill_switch_read   ON public.ct_kill_switch;
DROP POLICY IF EXISTS ct_kill_switch_update ON public.ct_kill_switch;

CREATE POLICY ct_kill_switch_read   ON public.ct_kill_switch
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_kill_switch_update ON public.ct_kill_switch
  FOR UPDATE TO authenticated USING (true) WITH CHECK (id = 1);

-- ============================================================================
-- Reader: ct_killswitch_active()  →  bool
--
-- Used by every instrumented edge function. Also handles lazy auto-release:
-- if auto_release_at is in the past, disarm the row in-place and return false.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ct_killswitch_active()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT active, auto_release_at
    INTO r
    FROM public.ct_kill_switch
   WHERE id = 1;

  IF r IS NULL OR NOT r.active THEN
    RETURN false;
  END IF;

  -- Lazy auto-release: if the timer has elapsed, disarm and report inactive.
  IF r.auto_release_at IS NOT NULL AND r.auto_release_at <= now() THEN
    UPDATE public.ct_kill_switch
       SET active        = false,
           disarmed_at   = now(),
           disarmed_by   = 'auto_release',
           updated_at    = now()
     WHERE id = 1;
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_killswitch_active() TO authenticated, service_role, anon;

-- ============================================================================
-- Engage: ct_killswitch_engage(reason, minutes_until_auto_release)
--
-- minutes_until_auto_release NULL → manual-only disarm (no auto-release).
-- Otherwise auto_release_at = now() + interval.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ct_killswitch_engage(
  reason                     TEXT,
  minutes_until_auto_release INTEGER DEFAULT NULL
)
RETURNS TABLE (
  active          BOOLEAN,
  engaged_at      TIMESTAMPTZ,
  auto_release_at TIMESTAMPTZ,
  engaged_reason  TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  release_at TIMESTAMPTZ;
BEGIN
  IF minutes_until_auto_release IS NOT NULL AND minutes_until_auto_release > 0 THEN
    release_at := now() + make_interval(mins => minutes_until_auto_release);
  ELSE
    release_at := NULL;
  END IF;

  UPDATE public.ct_kill_switch
     SET active          = true,
         engaged_at      = now(),
         engaged_by      = 'rpc',
         engaged_reason  = reason,
         auto_release_at = release_at,
         disarmed_at     = NULL,
         disarmed_by     = NULL,
         updated_at      = now()
   WHERE id = 1;

  RETURN QUERY
    SELECT k.active, k.engaged_at, k.auto_release_at, k.engaged_reason
      FROM public.ct_kill_switch k
     WHERE k.id = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_killswitch_engage(TEXT, INTEGER) TO authenticated, service_role;

-- ============================================================================
-- Disarm: ct_killswitch_disarm()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ct_killswitch_disarm()
RETURNS TABLE (
  active      BOOLEAN,
  disarmed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ct_kill_switch
     SET active          = false,
         disarmed_at     = now(),
         disarmed_by     = 'rpc',
         auto_release_at = NULL,
         updated_at      = now()
   WHERE id = 1;

  RETURN QUERY
    SELECT k.active, k.disarmed_at
      FROM public.ct_kill_switch k
     WHERE k.id = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_killswitch_disarm() TO authenticated, service_role;
