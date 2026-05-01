-- Synthesis Layer Phase 8 follow-up: get_brain_health() bucketing.
--
-- Original RPC counted any non-null `error` outside `skipped:%` as a real
-- error. Helpers populate `meta.warning` for benign no-data states (e.g.
-- james_flags returning 0 rows on a quiet day, analogs returning no
-- embedding for a session with no contracts). The orchestrator stores
-- those as `warning:<text>` in the error column. They are NOT failures
-- and must not show up in /health error_rate.
--
-- New buckets:
--   error IS NULL          → success
--   error LIKE 'warning:%' → success-with-warning (counted separately)
--   error LIKE 'skipped:%' → skipped
--   else                   → real error (helper crashed mid-fetch)

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
  per_helper AS (
    SELECT
      helper_name,
      COUNT(*) AS invocations,
      COUNT(*) FILTER (WHERE error IS NULL) AS successes,
      COUNT(*) FILTER (WHERE error LIKE 'warning:%') AS warnings,
      COUNT(*) FILTER (WHERE error IS NOT NULL AND error NOT LIKE 'skipped:%' AND error NOT LIKE 'warning:%') AS errors,
      COUNT(*) FILTER (WHERE error LIKE 'skipped:%') AS skipped,
      COUNT(*) FILTER (WHERE cache_hit) AS cache_hits,
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

GRANT EXECUTE ON FUNCTION public.get_brain_health(integer) TO authenticated, service_role;
