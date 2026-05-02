# 2026-05-02 — `ct-oi-backfill-historical` Parameterization Gap

**Decision class:** Future-improvement / methodology finding
**Urgency:** Low — surfaced as side-finding during LB6 archival audit, not currently blocking anything
**Source context:** `docs/decisions/2026-05-02-punchlist-staleness-archive.md#item-5`

---

## What was found

Phase A audit on the (since-archived) LB6 backfill found that `supabase/functions/ct-oi-backfill-historical/index.ts` does NOT support per-day or per-ticker-day backfills. The function:

- Hardcodes target sessions to `today` and `yesterday` from `new Date()` at invocation time.
- Accepts only `{ limit?, tickers? }` in the request body.
- Has no `session_date`, `start_date`, `end_date`, or per-ticker-day parameter.

Any caller passing `{"ticker": "X", "session_date": "Y"}` would get the request silently ignored — the function would fan out a sweep across `tickers` (if provided) but only against today + yesterday, not the requested historical date.

## Why this matters (latent risk)

The LB6 punchlist proposed firing this function with explicit historical session_dates. Had the original premise been correct (a real OI gap requiring backfill), executing the documented body shape would have:

1. Returned HTTP 200 — function ran successfully against today/yesterday.
2. Reported "rows written" — but for today/yesterday, NOT the requested historical session.
3. The intended backfill of older gaps would NOT have happened.
4. The caller would have believed the backfill succeeded, with no signal of the actual silent miss.

This is the same shape as the v1 specialist scoreboard silent failure (HTTP 200 + zero-effective-work + no signal). It's structurally protected against by the new `cron_zero_row_upsert_silent_failure_class` warden invariant **only for crons** registered in `ct_growth_crons` — but ad-hoc invocations bypass that scope.

## Proposed future improvement (NOT urgent)

Parameterize `ct-oi-backfill-historical` to accept either:

- `{ session_date: "YYYY-MM-DD", tickers?: string[] }` — backfill one historical session for given tickers, OR
- `{ start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD", tickers?: string[] }` — date range,

and return per-(ticker, session_date) row-write counts so the caller can verify the backfill actually targeted what was requested.

Plus a structural guard: if a `session_date` is provided but the function determines no UW endpoint supports historical OI for that date (e.g., older than UW's retention), reject the request with HTTP 400 instead of silently falling back to today/yesterday.

## When to do this

- Defer until a real historical gap re-surfaces. Right now there's none.
- If/when the OvernightPositioning panel ever fails to render for a watchlist ticker on a confirmed-data-missing day, this is the prerequisite work before any backfill.
- Estimated cost: ~30 min refactor of the edge function + small migration if a UW endpoint differs across backfill modes.

## Methodology lesson

When a punchlist item proposes invoking an existing function with parameters the function may not support, **Phase A must read the function's body parser** before any execution. The pattern that surfaced this was Track 3's audit-first discipline catching the gap before UW spend.

This pattern (silent parameter ignore on edge function) is the same shape as the silent atomic-rollback on database upserts. Both are instances of "HTTP 200 + zero effective work + no caller signal" — the third silent-failure mode the System Warden was built to address. Applying that lens at the body-parser layer of every callable function would catch this class structurally before it shows up in production.

## Related

- `docs/runbooks/silent_failures.md` — the broader pattern
- `docs/runbooks/punchlist_staleness.md` — the audit cadence that surfaced this
- `docs/decisions/2026-05-02-punchlist-staleness-archive.md#item-5` — the LB6 archival that triggered this finding
- `supabase/functions/ct-oi-backfill-historical/index.ts` — the function to parameterize
- `supabase/migrations/20260430183000_top_oi_shifts_per_ticker_quota.sql` — the actual fix that resolved LB6's original symptom (per-ticker LIMIT)
