-- ct_sweep_clusters — always-on flag pattern.
--
-- When a ticker sees 3+ unusual-options sweeps > $500k in a 5-minute rolling
-- window, surface it as a "SWEEP CLUSTER" flag. Purely internal scan of
-- ct_flow_alerts — no new UW calls. Dedupe per-ticker on a 10-min cooldown
-- so we don't spam the strip when a ticker stays hot.
--
-- Attention score:  count >= 5 → 85   count >= 4 → 75   count >= 3 → 65
-- Slack push:       score >= 75       (count >= 4 sweeps)
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_sweep_clusters (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                 text NOT NULL,
  window_start           timestamptz NOT NULL,
  window_end             timestamptz NOT NULL,
  sweep_count            int NOT NULL,
  total_premium          numeric NOT NULL,
  dominant_side          text NOT NULL CHECK (dominant_side IN ('call','put','mixed')),
  largest_single_premium numeric NOT NULL,
  call_count             int NOT NULL DEFAULT 0,
  put_count              int NOT NULL DEFAULT 0,
  attention_score        int NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_sweep_clusters_created
  ON ct_sweep_clusters (created_at DESC);
CREATE INDEX IF NOT EXISTS ct_sweep_clusters_ticker_created
  ON ct_sweep_clusters (ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS ct_sweep_clusters_attention
  ON ct_sweep_clusters (attention_score DESC);

-- RLS
ALTER TABLE ct_sweep_clusters ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_sweep_clusters_read
  ON ct_sweep_clusters FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_sweep_clusters_svc
  ON ct_sweep_clusters FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Trigger RPC — mirrors ct_book pattern.
CREATE OR REPLACE FUNCTION public.trigger_ct_sweep_cluster()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-sweep-cluster'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_sweep_cluster() TO authenticated, service_role;

-- pg_cron: every minute during weekday market hours (13:00-20:59 UTC = 9am-4:59pm ET).
-- Scan is cheap (5-min window over ct_flow_alerts, indexed on executed_at DESC).
SELECT cron.schedule(
  'ct-sweep-cluster',
  '* 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-sweep-cluster',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
