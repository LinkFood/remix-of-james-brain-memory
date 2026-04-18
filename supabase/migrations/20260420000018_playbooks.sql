-- ct_playbooks — curated, repeated, graded setup signatures.
--
-- A playbook is a "setup that Claude has won on N+ times with W+ win rate."
-- NOT every winning trade is a playbook — only REPEATABLE patterns. Mined
-- weekly from graded ct_trades + ct_flags + ct_alerts over a 90-day window
-- by ct-playbook-curator (Claude Sonnet), which emits ADD/SUPERSEDE/RETIRE
-- diffs against this table.
--
-- The watcher fetches top-5 ACTIVE playbooks (sorted by win_rate × sample_size)
-- and injects them as `active_playbooks` in the user payload. When current
-- tape matches a playbook's setup_criteria, the prompt weights heavily toward
-- that direction.
--
-- setup_criteria shape (machine-readable; see PLAYBOOK_CURATOR_SYSTEM prompt):
--   {
--     "regime": "gamma_positive" | "gamma_negative" | "pin" | "vol_expansion" | ...,
--     "session": "monday_open" | "power_hour" | "first_hour" | "midday" | ...,
--     "evidence_axes": ["A","B","C"],          -- required axes present
--     "catalyst": "earnings" | "fed" | "none" | ...,     -- optional
--     "iv_tier": "low" | "mid" | "high",                 -- optional
--     "instruments": ["SPY","QQQ"] | ["*"],               -- "*" = any
--     "direction": "bullish" | "bearish" | "neutral",
--     "extras": { /* any freeform qualifiers */ }
--   }
--
-- evidence_ids: uuids of the specific ct_trades / ct_flags / ct_alerts that
-- established the pattern. Provenance. Audit trail.
--
-- status lifecycle:
--   active  — watcher may cite this. Fresh confirmation recently.
--   dormant — not seen in weeks but not disproven; hidden from watcher,
--             promoted back to active if the pattern re-emerges.
--   retired — explicitly killed by curator (win rate decayed below threshold,
--             or James hit the retire button). Never shown again.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_playbooks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  description           text NOT NULL,
  setup_criteria        jsonb NOT NULL DEFAULT '{}'::jsonb,
  historical_win_rate   numeric,                    -- 0.0 to 1.0
  sample_size           int NOT NULL DEFAULT 0,
  avg_return_pct        numeric,
  avg_r_multiple        numeric,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at     timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','dormant','retired')),
  evidence_ids          uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  embedding             extensions.vector(512),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Unique by name so SUPERSEDE/RETIRE operations can target by name.
CREATE UNIQUE INDEX IF NOT EXISTS ct_playbooks_name_idx
  ON ct_playbooks (name);

CREATE INDEX IF NOT EXISTS ct_playbooks_status_idx
  ON ct_playbooks (status, last_confirmed_at DESC);

-- Watcher sort: win_rate × sample_size desc among active rows.
CREATE INDEX IF NOT EXISTS ct_playbooks_active_quality_idx
  ON ct_playbooks ((historical_win_rate * sample_size) DESC)
  WHERE status = 'active';

-- IVFFlat on embedding for future semantic similarity ("is this setup close
-- to any playbook I've seen?"). lists=50 — this table stays small (expect
-- <1K rows ever); bump if it grows. Partial index: only non-retired rows,
-- per the brief (embedding only on non-retired playbooks).
CREATE INDEX IF NOT EXISTS ct_playbooks_ivfflat
  ON ct_playbooks
  USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 50);

ALTER TABLE ct_playbooks ENABLE ROW LEVEL SECURITY;

-- Auth reads (single-user trust model, consistent with other ct_* tables)
CREATE POLICY ct_playbooks_authenticated_read
  ON ct_playbooks FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users can flip status (UI retire button writes directly
-- via supabase-js; service role bypass isn't required for this action).
CREATE POLICY ct_playbooks_authenticated_retire
  ON ct_playbooks FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Service role full access (curator inserts + retires)
CREATE POLICY ct_playbooks_service_role_all
  ON ct_playbooks FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Weekly pg_cron schedule — Sunday 22:45 UTC (6:45pm ET Sunday EDT).
-- Vault-powered auth via decrypted_secrets pattern (CLAUDE.md convention).
-- One Sonnet call/week ~ $0.10 — negligible.
-- ============================================================================
SELECT cron.schedule(
  'ct-playbook-curator',
  '45 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-playbook-curator',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
