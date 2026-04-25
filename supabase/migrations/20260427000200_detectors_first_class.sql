-- Detector portfolio framework — Wave 1.
-- Realizes tenets 8 (detector portfolio — first-class strategies), 24 (no
-- silos — every detector publishes provenance to a shared schema), 25
-- (adding a detector is a database INSERT, not a code change).
--
-- Tonight's scope is FOUNDATION: detectors live as registered ROWS with
-- lifecycle status and config. Per-detector scoreboards, lifecycle ladders,
-- cross-detector trust weighting, and /detectors UI are explicitly deferred
-- to next weekend's calibration session (project_co_trader_roadmap_post_2026_04_25).
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_detectors (
  id text PRIMARY KEY,                      -- short slug, e.g. 'cluster_slow_stacker'
  name text NOT NULL,                       -- human-readable
  description text,                         -- what pattern this detects
  status text NOT NULL DEFAULT 'shadow' CHECK (status IN ('shadow','trial','live','decay','retired')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,-- detector-specific tunables
  thesis text,                              -- "this detector finds X because Y"
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_detectors_status ON public.ct_detectors(status);

-- Provenance on every alarm. NULL = pre-framework legacy or specialist-direct
-- before the wrapper landed (back-compat for historical rows).
ALTER TABLE public.ct_flags
  ADD COLUMN IF NOT EXISTS detector_id text REFERENCES public.ct_detectors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ct_flags_detector_id ON public.ct_flags(detector_id);

-- Seed the detectors that exist today as registered rows. Once these exist,
-- the watcher / specialists / future detectors stamp detector_id on every
-- alarm row and the portfolio becomes queryable as data, not code.
INSERT INTO public.ct_detectors (id, name, description, status, config, thesis) VALUES
  ('scorer_v1',
   'Scorer (volatility-magnitude)',
   'Per-print volatility magnitude detector. Currently colors SCORE column; framework can route as alarm source if score >= threshold.',
   'shadow',
   '{"min_score": 80}'::jsonb,
   'High volatility-magnitude prints are setups likely to MOVE big regardless of direction.'),
  ('signature_v1',
   'Signature class match',
   'Tier evaluator: gold/silver/bronze based on score + signature class median peak + n.',
   'live',
   '{"see": "ct_config signature_alarm_*"}'::jsonb,
   'When a print matches a historically winning signature class, alarm with tier severity.'),
  ('cluster_default',
   'Cluster (5min/3prints/2%/80%)',
   'Original cluster detector — moderate window, 3+ prints near-money, 80% directional unanimity.',
   'live',
   '{"window_min":5,"min_prints":3,"strike_band_pct":0.02,"min_unanimity_pct":0.80}'::jsonb,
   'Catches rapid accumulation patterns in moderate windows.'),
  ('cluster_slow_stacker',
   'Slow Stacker (15min/5prints/3%/75%)',
   'Wide-window cluster — Friday 4/24 backtest winner. Catches grinding accumulation. Avg cluster peak +160%.',
   'trial',
   '{"window_min":15,"min_prints":5,"strike_band_pct":0.03,"min_unanimity_pct":0.75}'::jsonb,
   'Grinding institutional accumulation across longer time windows pays bigger than fast bursts. Friday 4/24 backtest: 42 winners caught, +160% avg cluster peak.'),
  ('specialist_flag',
   'Specialist direct flag',
   'When a per-ticker specialist (NVDA/QQQ/SPY/etc) writes a flag to ct_flags, that IS the detector firing. Wraps the specialist as a registered detector.',
   'live',
   '{}'::jsonb,
   'Specialist analysis is its own detection layer. Each specialist''s flags accumulate per-detector track record.')
ON CONFLICT (id) DO NOTHING;
