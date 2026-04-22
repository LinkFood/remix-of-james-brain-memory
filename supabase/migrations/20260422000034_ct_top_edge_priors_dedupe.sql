-- Fix function overloading regression. Migration 28 created the 4-arg
-- ct_top_edge_priors; migration 32 added a 5-arg version (with p_instrument).
-- PostgREST can't resolve calls with partial args now — edgePriors.ts was
-- silently failing and returning [] on every watcher + generator tick.
-- Drop the old one explicitly.

DROP FUNCTION IF EXISTS public.ct_top_edge_priors(INT, INT, NUMERIC, INT);

-- Sanity: only the 5-arg form should remain. Re-grant to be safe.
GRANT EXECUTE ON FUNCTION public.ct_top_edge_priors(INT, INT, NUMERIC, INT, TEXT)
  TO authenticated, service_role;
