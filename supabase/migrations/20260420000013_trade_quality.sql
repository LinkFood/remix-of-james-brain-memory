-- Trade quality self-rating — Claude grades each trade SETUP at commit (1-10,
-- outcome-blind) and re-rates EXECUTION at close (1-10, outcome-informed).
--
-- Why the split:
--   Professional traders separate PROCESS from OUTCOME. A bad trade that
--   happened to pay is still a bad trade. A good trade that lost money is
--   still a good trade. By capturing both ratings, we get a durable
--   "process vs. outcome" record Claude can reflect on (pre == post means
--   the setup played as expected; post << pre means the outcome taught
--   humility; post >> pre means Claude under-rated his own setup).
--
--   The DELTA (post - pre) is the learning signal. Generated column so it's
--   always in sync and can't drift.
--
-- Both columns are nullable by design:
--   - pre_trade_quality NULL → trade predates this feature (backfill later if
--     we want, but there's no evidence trail to grade fairly in retrospect)
--   - post_trade_quality NULL → trade is still open OR closed but the
--     fire-and-forget Haiku call hasn't landed yet.
--
-- CHECK constraints enforce the 1-10 range. Quality ratings outside 1-10
-- are a bug in the grader, not a valid value — we want the write to fail
-- loudly.

SET search_path = public, extensions;

ALTER TABLE ct_trades
  ADD COLUMN IF NOT EXISTS pre_trade_quality             int
    CHECK (pre_trade_quality BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS pre_trade_quality_reasoning   text,
  ADD COLUMN IF NOT EXISTS post_trade_quality            int
    CHECK (post_trade_quality BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS post_trade_quality_reasoning  text,
  ADD COLUMN IF NOT EXISTS quality_delta                 int
    GENERATED ALWAYS AS (post_trade_quality - pre_trade_quality) STORED;

-- Best trades index: "show me the 20 best-executed trades of all time."
CREATE INDEX IF NOT EXISTS ct_trades_post_quality_desc
  ON ct_trades (post_trade_quality DESC NULLS LAST)
  WHERE post_trade_quality IS NOT NULL;

-- Learning-signal index: "show me where pre and post diverge most —
-- humility-taught trades AND undersold-setup trades."
CREATE INDEX IF NOT EXISTS ct_trades_quality_delta_desc
  ON ct_trades (quality_delta DESC NULLS LAST)
  WHERE quality_delta IS NOT NULL;

-- The journal-column update guard from migration 20260419000015 needs to
-- learn about the new columns. Authenticated users (RLS path) can update
-- pre/post reasoning if they want to annotate, but they should NOT be able
-- to fudge the integer rating — those are set by the grader only. The
-- simplest rule: treat ALL quality columns as service-role-only (so the
-- existing guard already rejects any authenticated touch to them, because
-- any change to an unlisted column is a guard breach by the original
-- design — see `if NEW.x IS DISTINCT FROM OLD.x` on every non-journal col).
-- We therefore do NOT extend the guard's pass-through list: anything
-- Claude writes goes via service_role (which bypasses RLS + the trigger).

COMMENT ON COLUMN ct_trades.pre_trade_quality IS
  'Claude''s 1-10 self-rating of the trade SETUP at commit time, outcome-blind. Set by the PRE_TRADE_QUALITY Haiku call fired fire-and-forget after each commit.';
COMMENT ON COLUMN ct_trades.pre_trade_quality_reasoning IS
  '1-2 sentence rationale accompanying pre_trade_quality. Never nulled when the rating is set.';
COMMENT ON COLUMN ct_trades.post_trade_quality IS
  'Claude''s 1-10 re-rating of EXECUTION after the trade closes. Outcome-informed — not just "was it a winner?" but "did the setup play as expected?"';
COMMENT ON COLUMN ct_trades.post_trade_quality_reasoning IS
  '1-2 sentence rationale for post_trade_quality. If post differs from pre, this should explicitly explain the delta.';
COMMENT ON COLUMN ct_trades.quality_delta IS
  'Generated column: post_trade_quality - pre_trade_quality. NULL until both sides are rated. Positive = outcome was cleaner than the setup implied (Claude under-rated). Negative = outcome taught humility (Claude over-rated).';

-- Aggregate rollup view — one row per session_date, for the mini-stat on
-- /book. AVG skips NULLs so days without completed ratings still show what
-- data we have. We count only trades where BOTH pre and post are set
-- ("graded_count") for the delta average, since an unpaired pre or post
-- can't contribute to a delta.
CREATE OR REPLACE VIEW ct_trade_quality_rollup AS
SELECT
  session_date,
  COUNT(*)                             AS trades_count,
  COUNT(pre_trade_quality)             AS pre_rated_count,
  COUNT(post_trade_quality)            AS post_rated_count,
  COUNT(quality_delta)                 AS graded_count,
  ROUND(AVG(pre_trade_quality)::numeric,  2) AS avg_pre_quality,
  ROUND(AVG(post_trade_quality)::numeric, 2) AS avg_post_quality,
  ROUND(AVG(quality_delta)::numeric,      2) AS avg_delta
FROM ct_trades
GROUP BY session_date;

COMMENT ON VIEW ct_trade_quality_rollup IS
  'Per-session rollup of pre/post/delta quality ratings. Used by Book.tsx for the "this week avg quality" mini-stat. Averages skip NULLs — graded_count reflects the n that contributed to avg_delta.';

-- RLS — the view inherits ct_trades RLS automatically since it''s a plain
-- SELECT view. authenticated + service_role both get their existing access.
GRANT SELECT ON ct_trade_quality_rollup TO authenticated, service_role;
