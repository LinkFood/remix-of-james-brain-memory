-- ct_interval_flow: minute-by-minute aggregated options activity per ticker.
-- Source: UW MCP get_interval_flow. Richer than hourly flow_last_hour —
-- exposes velocity + acceleration over the session, which is what actually
-- distinguishes "accumulation" from "distribution" in live tape.
--
-- The raw payload shape from UW varies; we capture the core scalars we
-- expect (premium, volume, side, ask/bid side perc) and store the raw
-- row in `raw` jsonb so downstream queries can mine new fields without
-- an ingester rewrite.

CREATE TABLE IF NOT EXISTS public.ct_interval_flow (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,
  interval_start  TIMESTAMPTZ NOT NULL,
  side            TEXT,                      -- 'call' | 'put' | NULL
  premium         NUMERIC,
  volume          BIGINT,
  ask_side_volume BIGINT,
  bid_side_volume BIGINT,
  ask_side_perc   NUMERIC,                   -- 0..1
  bid_side_perc   NUMERIC,                   -- 0..1
  raw             JSONB,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, interval_start, side)
);

CREATE INDEX IF NOT EXISTS idx_ct_interval_flow_lookup
  ON public.ct_interval_flow (ticker, interval_start DESC);

ALTER TABLE public.ct_interval_flow ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_interval_flow" ON public.ct_interval_flow
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.ct_interval_flow IS
  'Minute-by-minute options activity per ticker from UW MCP get_interval_flow. Feeds quant card flow velocity signal.';
