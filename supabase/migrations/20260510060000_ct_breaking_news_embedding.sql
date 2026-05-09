-- ============================================================================
-- Phase 2 (Section B gap, breaking news): close the embedding-gate gap on
-- ct_breaking_news (1.2k rows, 0% embedded pre-ship).
--
-- Two producers (ct-news-sweep, ct-tavily-news-watcher) both insert without
-- embedding. Streamlined approach: cron-only drainer (no producer edits)
-- accepts ~5-min embed latency in exchange for not touching two distinct
-- code paths. Acceptable for breaking-news semantic recall — captain looks
-- back at "5 most-similar prior news days" not "5 most-similar inserts in
-- the last minute." Future write-time-embed is a 1-PR optimization if
-- latency becomes load-bearing.
--
-- Pattern mirrors Phase 1 (20260510050000):
--   - inline embedding extensions.vector(512) + rich_text columns
--   - HNSW COSINE index
--   - match_ct_breaking_news_by_similarity RPC (two-level query)
--   - warden invariant breaking_news_embedding_backlog_5m
-- ============================================================================
SET search_path = public, extensions;

ALTER TABLE public.ct_breaking_news
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(512),
  ADD COLUMN IF NOT EXISTS rich_text text;

COMMENT ON COLUMN public.ct_breaking_news.embedding IS
  'Voyage 3-lite 512-dim embedding of rich_text. Semantic-recall substrate for /alpha News Causality Graph (Phase 5).';
COMMENT ON COLUMN public.ct_breaking_news.rich_text IS
  'What got embedded: "BREAKING_NEWS | sev:N sent:X cat:Y tickers:[...] macro:bool\n<headline>\n<summary>". Cluster axis is severity/sentiment/category, not just headline prose.';

CREATE INDEX IF NOT EXISTS ct_breaking_news_embedding_hnsw
  ON public.ct_breaking_news
  USING hnsw (embedding extensions.vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION public.match_ct_breaking_news_by_similarity(
  query_embedding   extensions.vector(512),
  match_threshold   numeric DEFAULT 0.5,
  match_count       int     DEFAULT 5,
  exclude_after_ts  timestamptz DEFAULT NULL,
  ticker_filter     text DEFAULT NULL,           -- NULL = any ticker; specific = filter
  min_severity      int  DEFAULT NULL            -- NULL = any severity; int = sev >= N
)
RETURNS TABLE (
  id              uuid,
  ingested_at     timestamptz,
  published_at    timestamptz,
  source          text,
  headline        text,
  summary         text,
  severity        int,
  sentiment       text,
  category        text,
  tickers_affected text[],
  macro_wide      boolean,
  url             text,
  rich_text       text,
  similarity      numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    id, ingested_at, published_at, source, headline, summary, severity,
    sentiment, category, tickers_affected, macro_wide, url, rich_text,
    similarity
  FROM (
    SELECT
      n.id, n.ingested_at, n.published_at, n.source, n.headline, n.summary,
      n.severity, n.sentiment, n.category, n.tickers_affected, n.macro_wide,
      n.url, n.rich_text,
      1 - (n.embedding <=> query_embedding) AS similarity
    FROM public.ct_breaking_news n
    WHERE n.embedding IS NOT NULL
      AND (exclude_after_ts IS NULL OR n.ingested_at < exclude_after_ts)
      AND (ticker_filter IS NULL OR n.tickers_affected @> ARRAY[ticker_filter])
      AND (min_severity IS NULL OR n.severity >= min_severity)
    ORDER BY n.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 3, 12)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.match_ct_breaking_news_by_similarity(
  extensions.vector(512), numeric, int, timestamptz, text, int
) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_ct_breaking_news_by_similarity IS
  'Cosine-similarity search over ct_breaking_news.embedding. Used by /alpha News Causality Graph (Phase 5). ticker_filter narrows to news mentioning a specific ticker; min_severity gates editorial relevance.';

-- Warden invariant — catches drainer failures (Voyage outage, cron drift)
-- 5-min latency tolerance: rows older than 10 min with NULL embedding =
-- backlog. Allows 2 cron cycles slack.
INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'breaking_news_embedding_backlog_10m',
  'embedding_gate',
  'Count of ct_breaking_news rows older than 10 min with NULL embedding. Catches cron-drainer failures or Voyage outages. Expected 0 - 5 (allows 2 cron cycles slack + ingestion bursts).',
  'SELECT count(*)::numeric AS metric_value, ''rows ''||count(*)||'' un-embedded older than 10m'' AS message FROM public.ct_breaking_news WHERE ingested_at < now() - interval ''10 minutes'' AND ingested_at >= now() - interval ''24 hours'' AND embedding IS NULL',
  0,
  5,
  'warn',
  'docs/runbooks/embedding_gate.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();
