-- ============================================================================
-- V2 Scrub Phase 0.3 — Deprecate paper-trader tables
-- ============================================================================
-- Context: Co-Trader v2 architecture retires the paper-trader stack. Historical
-- data is preserved as reference/learning substrate — no drops, no truncates.
-- This migration stamps DEPRECATED comments on each retired table and disables
-- triggers that would otherwise write new rows into the retired surface.
--
-- ct_trades is NOT deprecated — it is being repurposed in v2 (becomes
-- ct_flags). Direction/horizon/thesis fields map 1:1.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. DEPRECATED comments — paper-trader tables
-- ----------------------------------------------------------------------------

COMMENT ON TABLE public.ct_book IS
  'DEPRECATED 2026-04-23 — paper-trader architecture retired. Historical data only, no new writes.';

COMMENT ON TABLE public.ct_trade_actions IS
  'DEPRECATED 2026-04-23 — paper-trader architecture retired. Historical data only, no new writes.';

COMMENT ON TABLE public.ct_claude_generations IS
  'DEPRECATED 2026-04-23 — paper-trader architecture retired. Historical data only, no new writes.';

COMMENT ON TABLE public.ct_claude_circuit_breakers IS
  'DEPRECATED 2026-04-23 — paper-trader architecture retired. Historical data only, no new writes.';

COMMENT ON TABLE public.ct_claude_heartbeat IS
  'DEPRECATED 2026-04-23 — paper-trader architecture retired. Historical data only, no new writes.';

COMMENT ON TABLE public.ct_trade_audit IS
  'DEPRECATED 2026-04-23 — paper-trader architecture retired. Historical data only, no new writes.';

-- Re-stamp dp tables (previously deprecated in 20260423000021_dp_scrub_pass1.sql).
-- Keeping comment consistent with the v2 scrub batch.
COMMENT ON TABLE public.ct_dark_pool_prints IS
  'DEPRECATED 2026-04-23 — historical only, no new writes. Retained for lookback attribution.';

COMMENT ON TABLE public.ct_dp_clusters IS
  'DEPRECATED 2026-04-23 — historical only, no new writes. Retained for lookback attribution.';

-- ----------------------------------------------------------------------------
-- 2. ct_trades — REPURPOSED, not deprecated
-- ----------------------------------------------------------------------------

COMMENT ON TABLE public.ct_trades IS
  'REPURPOSING 2026-04-23 — becomes ct_flags in v2 architecture. Direction, horizon, thesis fields map 1:1. Do not expect new paper-trader rows.';

-- ----------------------------------------------------------------------------
-- 3. Disable triggers that would write into the retired paper-book surface
-- ----------------------------------------------------------------------------
-- ct_trades_refresh_book updates ct_book counters on every ct_trades mutation.
-- With the paper-book retired, this trigger must not fire.
-- (Created in 20260423000005_ct_book_live_counters.sql)

DROP TRIGGER IF EXISTS ct_trades_refresh_book ON public.ct_trades;
