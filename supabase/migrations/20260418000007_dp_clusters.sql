-- ct_dp_clusters — always-on flag pattern for dark pool blocks.
--
-- When a ticker sees 3+ dark-pool prints with notional >= $1M in a 10-minute
-- rolling window, surface it as a "DP CLUSTER" flag. Pure internal scan of
-- ct_dark_pool_prints — no new UW calls. Dedupe per-ticker on a 15-min
-- cooldown (blocks arrive slower and chunkier than sweeps, so the cooldown
-- is more generous than the sweep-cluster's 10-min window).
--
-- Attention score:  count >= 5 → 85   count >= 4 → 75   count >= 3 → 65
-- Slack push:       score >= 75       (count >= 4 prints)
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_dp_clusters (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                 text NOT NULL,
  window_start           timestamptz NOT NULL,
  window_end             timestamptz NOT NULL,
  print_count            int NOT NULL,
  total_notional         numeric NOT NULL,
  largest_single_notional numeric NOT NULL,
  attention_score        int NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  session_date           date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date
);

CREATE INDEX IF NOT EXISTS ct_dp_clusters_created
  ON ct_dp_clusters (created_at DESC);
CREATE INDEX IF NOT EXISTS ct_dp_clusters_ticker_created
  ON ct_dp_clusters (ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS ct_dp_clusters_attention
  ON ct_dp_clusters (attention_score DESC);

-- RLS
ALTER TABLE ct_dp_clusters ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_dp_clusters_read
  ON ct_dp_clusters FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_dp_clusters_svc
  ON ct_dp_clusters FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Trigger RPC — mirrors ct_sweep_cluster pattern.
CREATE OR REPLACE FUNCTION public.trigger_ct_dp_cluster()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-dp-cluster'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_dp_cluster() TO authenticated, service_role;

-- pg_cron: every minute during weekday market hours (13:00-20:59 UTC = 9am-4:59pm ET).
-- Same cadence as ct-sweep-cluster. Scan is cheap (10-min window over
-- ct_dark_pool_prints, indexed on executed_at / ingested_at).
SELECT cron.schedule(
  'ct-dp-cluster',
  '* 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-dp-cluster',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
