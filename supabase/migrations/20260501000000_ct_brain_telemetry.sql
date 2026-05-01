-- Synthesis Layer — Phase 8 D8 telemetry table.
--
-- Every helper invocation in `buildClaudeContext()` (the brain orchestrator
-- in supabase/functions/_shared/claudeReadSurface.ts) fires a fire-and-forget
-- insert into this table. Aggregated by `get_brain_health(window_hours)` for
-- the /health dashboard.
--
-- See docs/SYNTHESIS_LAYER_ARCHITECTURE.md (D8) and docs/SYNTHESIS_LAYER.md
-- for context. This is the floor of brain observability — without it we fly
-- blind on which organs degrade and which consumers over-fetch.

CREATE TABLE IF NOT EXISTS public.ct_brain_telemetry (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  helper_name     text NOT NULL,
  helper_version  text,
  audience        text,
  ticker_focus    text,
  consumer_name   text,
  latency_ms      integer NOT NULL DEFAULT 0,
  output_size_bytes integer NOT NULL DEFAULT 0,
  cache_hit       boolean NOT NULL DEFAULT false,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ct_brain_telemetry IS
  'D8 telemetry: one row per ContextHelper invocation in buildClaudeContext. Fire-and-forget, must never block consumers.';
COMMENT ON COLUMN public.ct_brain_telemetry.helper_name IS
  'snake_case organ name from HelperName union (e.g. flow_heatmap, specialist).';
COMMENT ON COLUMN public.ct_brain_telemetry.error IS
  'NULL on success. "skipped:<reason>" on orchestrator skip (audience_filter, organ_filter, error). Free-form error string on helper throw.';
COMMENT ON COLUMN public.ct_brain_telemetry.consumer_name IS
  'BrainOpts.consumerName — which edge function or surface invoked the brain.';

-- Hot indexes for /health queries (per-helper p50/p95, per-consumer rates,
-- recent-window scans). All cover the (created_at DESC) prefix so rolling
-- window queries can index-only-scan.
CREATE INDEX IF NOT EXISTS idx_ct_brain_telemetry_helper_time
  ON public.ct_brain_telemetry (helper_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_brain_telemetry_consumer_time
  ON public.ct_brain_telemetry (consumer_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_brain_telemetry_recent
  ON public.ct_brain_telemetry (created_at DESC);
-- Error-rate scans benefit from a partial index on the error column.
CREATE INDEX IF NOT EXISTS idx_ct_brain_telemetry_errors
  ON public.ct_brain_telemetry (created_at DESC)
  WHERE error IS NOT NULL;

-- RLS: authenticated read (for /health dashboard), service role insert only.
ALTER TABLE public.ct_brain_telemetry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_brain_telemetry_select_auth ON public.ct_brain_telemetry;
CREATE POLICY ct_brain_telemetry_select_auth
  ON public.ct_brain_telemetry
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_brain_telemetry_insert_service ON public.ct_brain_telemetry;
CREATE POLICY ct_brain_telemetry_insert_service
  ON public.ct_brain_telemetry
  FOR INSERT
  TO service_role
  WITH CHECK (true);

GRANT SELECT ON public.ct_brain_telemetry TO authenticated;
GRANT INSERT, SELECT ON public.ct_brain_telemetry TO service_role;

-- ---------------------------------------------------------------------------
-- get_brain_health(window_hours int) — /health dashboard payload.
--
-- Returns per-helper p50/p95 latency, error rate, cache-hit rate, and total
-- invocations over the rolling window. Frontend wiring is deferred (Phase 9+);
-- this RPC must exist now so terminal-me + future UI can query.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_brain_health(window_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $func$
  WITH window_rows AS (
    SELECT
      helper_name,
      consumer_name,
      latency_ms,
      output_size_bytes,
      cache_hit,
      error
    FROM public.ct_brain_telemetry
    WHERE created_at >= now() - make_interval(hours => GREATEST(window_hours, 1))
  ),
  -- Bucketing rule:
  --   error IS NULL                 → success
  --   error LIKE 'warning:%'        → success-with-warning (no-rows, etc; not a failure)
  --   error LIKE 'skipped:%'        → skipped (audience filter, organ filter, helper threw)
  --   else                          → real error (helper crashed mid-fetch in the orchestrator)
  per_helper AS (
    SELECT
      helper_name,
      COUNT(*) AS invocations,
      COUNT(*) FILTER (WHERE error IS NULL) AS successes,
      COUNT(*) FILTER (WHERE error LIKE 'warning:%') AS warnings,
      COUNT(*) FILTER (WHERE error IS NOT NULL AND error NOT LIKE 'skipped:%' AND error NOT LIKE 'warning:%') AS errors,
      COUNT(*) FILTER (WHERE error LIKE 'skipped:%') AS skipped,
      COUNT(*) FILTER (WHERE cache_hit) AS cache_hits,
      -- p50 / p95 over latency_ms for executed rows (success or warning); skipped = 0 noise.
      COALESCE(
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY latency_ms
        ) FILTER (WHERE error IS NULL OR error NOT LIKE 'skipped:%'),
        0
      ) AS p50_latency_ms,
      COALESCE(
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY latency_ms
        ) FILTER (WHERE error IS NULL OR error NOT LIKE 'skipped:%'),
        0
      ) AS p95_latency_ms,
      COALESCE(AVG(output_size_bytes) FILTER (WHERE error IS NULL), 0) AS avg_output_bytes
    FROM window_rows
    GROUP BY helper_name
  ),
  per_consumer AS (
    SELECT
      consumer_name,
      COUNT(*) AS invocations,
      COUNT(*) FILTER (WHERE error IS NOT NULL AND error NOT LIKE 'skipped:%' AND error NOT LIKE 'warning:%') AS errors,
      COUNT(*) FILTER (WHERE error LIKE 'warning:%') AS warnings
    FROM window_rows
    WHERE consumer_name IS NOT NULL
    GROUP BY consumer_name
  ),
  totals AS (
    SELECT
      COUNT(*) AS total_invocations,
      COUNT(*) FILTER (WHERE error IS NOT NULL AND error NOT LIKE 'skipped:%' AND error NOT LIKE 'warning:%') AS total_errors,
      COUNT(*) FILTER (WHERE error LIKE 'warning:%') AS total_warnings,
      COUNT(*) FILTER (WHERE cache_hit) AS total_cache_hits,
      COUNT(DISTINCT consumer_name) FILTER (WHERE consumer_name IS NOT NULL) AS distinct_consumers,
      COUNT(DISTINCT helper_name) AS distinct_helpers
    FROM window_rows
  )
  SELECT jsonb_build_object(
    'window_hours', window_hours,
    'generated_at', now(),
    'totals', (SELECT to_jsonb(t) FROM totals t),
    'helpers', COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'helper_name', helper_name,
          'invocations', invocations,
          'successes', successes,
          'warnings', warnings,
          'errors', errors,
          'skipped', skipped,
          'error_rate', CASE WHEN invocations - skipped > 0
            THEN round((errors::numeric / NULLIF(invocations - skipped, 0)::numeric) * 100, 2)
            ELSE 0 END,
          'cache_hits', cache_hits,
          'cache_hit_rate', CASE WHEN successes > 0
            THEN round((cache_hits::numeric / successes::numeric) * 100, 2)
            ELSE 0 END,
          'p50_latency_ms', round(p50_latency_ms::numeric, 1),
          'p95_latency_ms', round(p95_latency_ms::numeric, 1),
          'avg_output_bytes', round(avg_output_bytes::numeric, 0)
        )
        ORDER BY invocations DESC
      ) FROM per_helper),
      '[]'::jsonb
    ),
    'consumers', COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'consumer_name', consumer_name,
          'invocations', invocations,
          'errors', errors,
          'warnings', warnings
        )
        ORDER BY invocations DESC
      ) FROM per_consumer),
      '[]'::jsonb
    )
  );
$func$;

COMMENT ON FUNCTION public.get_brain_health(integer) IS
  'Synthesis Layer /health payload: per-helper p50/p95 latency, error rate, cache-hit rate, total invocations over window_hours rolling window.';

GRANT EXECUTE ON FUNCTION public.get_brain_health(integer) TO authenticated, service_role;
