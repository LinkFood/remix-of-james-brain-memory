-- ============================================================================
-- Co-Trader v2 — ct_specialist_reads (running commentary)
-- ============================================================================
-- Context: specialists only persisted output when they fired a flag. Every
-- wakeup they reason with full context (tape-reader, flow pulse, stacking,
-- lean, peers, news, OI) but if they passed, that entire read was thrown
-- away. This table surfaces each specialist's running commentary on every
-- wakeup — flag or pass — so the TickerSheet "SPECIALIST — LATEST TAKE"
-- section is a live voice, not a placeholder.
--
-- Distinct from ct_specialist_memory (embedded graded-flag reflections):
-- that table is post-hoc learning substrate; this table is live read-out.
-- ============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_specialist_reads (
  id             BIGSERIAL PRIMARY KEY,
  ticker         TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction_lean TEXT CHECK (direction_lean IN ('bullish','bearish','neutral','mixed')),
  conviction     INT CHECK (conviction >= 0 AND conviction <= 100),
  read_text      TEXT NOT NULL,
  flagged        BOOLEAN NOT NULL DEFAULT FALSE,
  flag_id        UUID REFERENCES public.ct_flags(id) ON DELETE SET NULL,
  source_flow_ids BIGINT[]
);

CREATE INDEX idx_ct_specialist_reads_ticker_time
  ON public.ct_specialist_reads (ticker, updated_at DESC);

ALTER TABLE public.ct_specialist_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_specialist_reads_read ON public.ct_specialist_reads
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_specialist_reads_service ON public.ct_specialist_reads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_reads IS
  'V2 per-specialist running commentary. One row per wakeup — specialist''s 2-3 sentence read on what the ticker is doing, whether they flagged, and direction lean + conviction (0-100). Powers the live TickerSheet LATEST TAKE surface.';
COMMENT ON COLUMN public.ct_specialist_reads.conviction IS
  '0-100: how close this wakeup came to firing a flag. 0=quiet day, 100=DID flag.';
COMMENT ON COLUMN public.ct_specialist_reads.source_flow_ids IS
  'BIGINT[] — ct_scored_flow.id values considered in this wakeup. Matches ct_flags.source_flow_ids typing.';
