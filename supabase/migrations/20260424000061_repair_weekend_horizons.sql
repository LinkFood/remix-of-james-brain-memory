-- One-off data repair: 32 of today's flags have horizon_ts that fall in the
-- weekend window (Fri 21:00 UTC → Mon 13:30 UTC) because the specialist runner
-- did `now() + horizon_hours` instead of using trading hours. Recompute each
-- as `add_trading_hours(created_at, horizon_hours)` so they land at the
-- specialist's true intent — N trading hours after creation.
--
-- This fix is bounded: only flags with horizon_ts in the weekend window get
-- updated. Active-only — graded flags are immutable. Safe to re-run; the
-- WHERE clause excludes already-correct rows.

WITH repaired AS (
  UPDATE public.ct_flags
  SET horizon_ts = public.add_trading_hours(created_at, horizon_hours)
  WHERE status = 'active'
    AND horizon_ts > '2026-04-24T21:00:00+00:00'::timestamptz
    AND horizon_ts < '2026-04-27T13:30:00+00:00'::timestamptz
  RETURNING id, specialist_ticker, horizon_ts
)
SELECT count(*) AS repaired_count FROM repaired;
