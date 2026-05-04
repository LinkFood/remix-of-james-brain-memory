-- Drop the orphan 2-arg ct_net_premium_series overload that broke the live
-- Flow Butterfly chart on 2026-05-04 RTH.
--
-- Background: 20260428160000_net_premium_series_p_until.sql added p_until and
-- recreated the function with 3 args, but used CREATE OR REPLACE without first
-- dropping the existing 2-arg signature. Since (TEXT, TIMESTAMPTZ) and
-- (TEXT, TIMESTAMPTZ, TIMESTAMPTZ) are distinct identities, both registered
-- as separate functions. PostgREST returned PGRST203 "could not choose the
-- best candidate function" when the live hook called with only p_since →
-- useNetPremiumSeries flipped isError, butterfly chart blanked.
--
-- Companion migration handled this for ct_net_premium_expiry_split correctly
-- (DROP FUNCTION IF EXISTS at line 92). This is the missed mirror for the
-- series RPC.
--
-- Class-killer: any future RPC signature extension MUST drop prior overloads
-- explicitly. CREATE OR REPLACE is identity-scoped, not name-scoped.

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS public.ct_net_premium_series(TEXT, TIMESTAMPTZ);
