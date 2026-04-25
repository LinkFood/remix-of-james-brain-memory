-- Drop the one-shot peek helper now that tier-eval verification completed.
DROP FUNCTION IF EXISTS public.tmp_peek_net_response(bigint);
