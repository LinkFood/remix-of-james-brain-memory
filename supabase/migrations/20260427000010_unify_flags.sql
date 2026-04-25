-- Unify the two parallel flag systems (ct_flags specialist + ct_james_flags
-- manual stars) into one ct_flags table keyed by `source`.
--
-- After this migration ct_flags carries three sources:
--   specialist        — Sonnet-written, current default (41 existing rows)
--   james_star        — manual stars from /tape (backfilled from ct_james_flags)
--   signature_alarm   — auto-fired by ct-signature-watcher
--
-- The grader is updated separately to handle source-aware defaults. UI
-- surfaces filter on `source`. ct_james_flags + ct_james_flag_grades drop in
-- a follow-up migration after verify.
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. Source column + indexes
-- ----------------------------------------------------------------------------
ALTER TABLE public.ct_flags
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'specialist'
    CHECK (source IN ('specialist', 'james_star', 'signature_alarm'));

CREATE INDEX IF NOT EXISTS idx_ct_flags_source ON public.ct_flags(source);
CREATE INDEX IF NOT EXISTS idx_ct_flags_option_symbol_source
  ON public.ct_flags(option_symbol, source);

COMMENT ON COLUMN public.ct_flags.source IS
  'specialist (Sonnet-written), james_star (manual ⭐ on /tape), signature_alarm (ct-signature-watcher auto-fired)';

-- specialist_ticker is required for specialist flags but stays NULL for stars
-- and alarms — those are vibes-tagged from outside the specialist roster.
ALTER TABLE public.ct_flags ALTER COLUMN specialist_ticker DROP NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Backfill ct_james_flags → ct_flags as source='james_star'
-- ----------------------------------------------------------------------------
-- Defaults satisfy NOT NULL columns: instrument=ticker, direction='neutral'
-- when James didn't pick a side, score=0, horizon_hours=24, horizon_ts=+24h.
-- Tags = ['james_star'] so source is also visible from tag-only readers.
INSERT INTO public.ct_flags (
  source,
  specialist_ticker,
  instrument,
  option_symbol,
  direction,
  score,
  thesis,
  tags,
  horizon_hours,
  horizon_ts,
  source_flow_ids,
  status,
  created_at,
  updated_at
)
SELECT
  'james_star'                                AS source,
  NULL                                        AS specialist_ticker,
  jf.ticker                                   AS instrument,
  jf.option_symbol                            AS option_symbol,
  COALESCE(
    CASE jf.direction_view
      WHEN 'bullish' THEN 'bullish'
      WHEN 'bearish' THEN 'bearish'
      WHEN 'neutral' THEN 'neutral'
      ELSE NULL
    END,
    'neutral'
  )                                           AS direction,
  0                                           AS score,
  jf.note                                     AS thesis,
  ARRAY['james_star']                         AS tags,
  24                                          AS horizon_hours,
  jf.created_at + INTERVAL '24 hours'         AS horizon_ts,
  NULL                                        AS source_flow_ids,
  'active'                                    AS status,
  jf.created_at                               AS created_at,
  jf.created_at                               AS updated_at
FROM public.ct_james_flags jf
WHERE NOT EXISTS (
  SELECT 1
  FROM public.ct_flags cf
  WHERE cf.option_symbol = jf.option_symbol
    AND cf.source = 'james_star'
    AND cf.created_at = jf.created_at
);
