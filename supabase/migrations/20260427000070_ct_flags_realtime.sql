-- Enable Supabase Realtime on ct_flags so /tape can render alarm glow + banner
-- live when ct-signature-watcher inserts a tiered alarm row
-- (source='signature_alarm', tags including 'gold'/'silver'/'bronze').
--
-- Defensive: only ALTER if the publication exists (matches pattern in
-- 20260424000066_net_premium_series_rpc.sql) so this is a no-op in
-- environments without the supabase_realtime publication.
DO $body$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Idempotent: skip if ct_flags is already in the publication.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'ct_flags'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.ct_flags;
    END IF;
  END IF;
END
$body$;
