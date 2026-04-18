-- ct_replay_runs — persist ct-replay results so they survive the 150s edge
-- function timeout and enable chunked replay of full 40-tick sessions.
--
-- Before this table, a replay run's results only existed in the HTTP response
-- body. If the function timed out (40 Haiku calls × ~4s overshoots 150s), the
-- UI got nothing — even though the loop may have processed 30+ ticks of real
-- decisions. Now every replay writes a row at start, checkpoints partial
-- results every few ticks, and finalizes at the end. Chunked runs link
-- chunk rows back to a parent run so the UI can stitch them together.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_replay_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  session_date      date NOT NULL,
  max_ticks         int NOT NULL,
  chunk_index       int NOT NULL DEFAULT 0,      -- 0 for single-run; 0..N-1 for chunked
  total_chunks      int NOT NULL DEFAULT 1,      -- 1 for single-run; N for chunked
  parent_run_id     uuid REFERENCES ct_replay_runs(id) ON DELETE SET NULL, -- null for single or chunk 0; set for chunks 1..N-1
  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','timeout','error')),
  dry_run           boolean NOT NULL DEFAULT true,
  modules           text[] NOT NULL DEFAULT ARRAY['watcher_writes','cooldown','alert_book_commit']::text[],
  ticks_completed   int NOT NULL DEFAULT 0,
  actual_counts     jsonb,        -- {observations, flags, alerts, trades_committed}
  replay_counts     jsonb,        -- {observations, flags, alerts, demoted, trades_would_commit}
  per_tick          jsonb,        -- array of per-tick diff rows
  trade_decisions   jsonb,        -- array of alert-book-commit decisions
  cost_usd          numeric(10, 6),
  duration_ms       int,
  error_message     text,
  user_id           uuid,         -- optional: who fired it (null for cron/service-role)
  triggered_by      text          -- 'ui', 'cron', 'service-role'
);

CREATE INDEX IF NOT EXISTS ct_replay_runs_session_started
  ON ct_replay_runs (session_date DESC, started_at DESC);
CREATE INDEX IF NOT EXISTS ct_replay_runs_started_desc
  ON ct_replay_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS ct_replay_runs_parent
  ON ct_replay_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ct_replay_runs_status
  ON ct_replay_runs (status, started_at DESC);

ALTER TABLE ct_replay_runs ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read replay history (it's shared tooling, not
-- per-user data). Service role does inserts + checkpoint updates.
DROP POLICY IF EXISTS ct_replay_runs_read ON ct_replay_runs;
CREATE POLICY ct_replay_runs_read
  ON ct_replay_runs FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_replay_runs_svc ON ct_replay_runs;
CREATE POLICY ct_replay_runs_svc
  ON ct_replay_runs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- Trigger RPC: fire-an-empty-body replay for today. Mirrors the existing
-- _ct_post empty-body pattern — pg_cron or SQL editor can call this to
-- kick off a replay without crafting a JSON body.
CREATE OR REPLACE FUNCTION trigger_ct_replay(
  p_session_date date DEFAULT NULL,
  p_max_ticks int DEFAULT 12,
  p_chunk_index int DEFAULT 0,
  p_total_chunks int DEFAULT 1,
  p_parent_run_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_url text;
  v_key text;
  v_body jsonb;
  v_session_date date;
BEGIN
  -- Read vault secrets (same pattern as other ct-* cron triggers)
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name IN ('project_url','supabase_url')
    ORDER BY CASE name WHEN 'project_url' THEN 1 ELSE 2 END
    LIMIT 1;
  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE EXCEPTION 'trigger_ct_replay: missing vault secrets (project_url/supabase_url + service_role_key)';
  END IF;

  v_session_date := COALESCE(p_session_date, (now() AT TIME ZONE 'America/New_York')::date);

  v_body := jsonb_build_object(
    'session_date', v_session_date::text,
    'dry_run', true,
    'max_ticks', p_max_ticks,
    'chunk_index', p_chunk_index,
    'total_chunks', p_total_chunks
  );
  IF p_parent_run_id IS NOT NULL THEN
    v_body := v_body || jsonb_build_object('parent_run_id', p_parent_run_id::text);
  END IF;

  PERFORM net.http_post(
    url := v_url || '/functions/v1/ct-replay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := v_body
  );

  RETURN jsonb_build_object(
    'ok', true,
    'session_date', v_session_date,
    'chunk_index', p_chunk_index,
    'total_chunks', p_total_chunks
  );
END;
$$;

GRANT EXECUTE ON FUNCTION trigger_ct_replay(date, int, int, int, uuid) TO service_role;
