# Runbook — specialist per-ticker silent freeze

**Triggered by:** `specialist_oldest_ticker_freshness_rth` (critical) or `specialist_parse_fail_rate_24h` (warn).

**First fired:** N/A — born from 2026-05-05 NVDA freeze (silent since 2026-05-01T18:48:32, ~96h dark, no alert).

## Symptom shape

A single ticker stops writing to `ct_specialist_reads` while the other 9 keep flowing. The pre-existing `specialist_reads_today` and `specialist_reads_per_ticker_today_rth` invariants count `DISTINCT ticker` and pass at threshold ≥7 — they only catch ≥4 simultaneous freezes.

## Diagnosis (do this in order)

### 1. Confirm which ticker(s) are stale

```bash
SR=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_specialist_reads?select=ticker,updated_at&order=updated_at.desc&limit=200" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" \
  | python3 -c "
import json, sys
from collections import defaultdict
rows=json.load(sys.stdin)
last={}
for r in rows:
  last.setdefault(r['ticker'], r['updated_at'])
for t, ts in sorted(last.items(), key=lambda x: x[1]):
  print(f'{t:6} {ts}')"
```

The OLDEST `updated_at` in that list is the stale ticker. Watchlist: NVDA AAPL MSFT GOOGL AMZN META TSLA QQQ SPY IWM.

### 2. Check the wakeup log for that ticker (live diagnostic)

```bash
TICKER=NVDA
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_specialist_wakeup_log?ticker=eq.$TICKER&order=wakeup_at.desc&limit=20&select=wakeup_at,reason,skip_reason,parse_ok,current_read_present,current_read_failure,claude_output_preview,error" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" | python3 -m json.tool
```

Read the rows. Three meaningful columns:

- **`parse_ok=false`** → Claude returned malformed JSON (rare, more likely a Claude/Anthropic upstream issue or a prompt overflow). Check `claude_output_preview`.
- **`parse_ok=true, current_read_present=false`** → THE NVDA SILENT-FREEZE CLASS. Claude returned valid JSON but the `current_read` field failed strict guards. Read `current_read_failure`:
  - `missing` — Claude omitted the field entirely
  - `not_object` — Claude returned a string/array instead of an object
  - `invalid_lean:<value>` — `direction_lean` not in `{bullish, bearish, neutral, mixed}` (e.g., `"bull"`, `"long"`, `"positive"`)
  - `invalid_conviction:<value>` — non-numeric conviction
  - `empty_text` — `read_text` was blank
- **`skip_reason='no_events'`** for many runs → the ticker's wakeup_threshold is rejecting all candidates. Check `ct_config.specialist.<TICKER>.wakeup_threshold`.

### 3. If `current_read_failure` is `invalid_lean:<x>`

Claude is consistently returning an out-of-allowed-set value for that ticker. The `_shared/specialistRunner.ts` parse function (lines 498-528) only accepts `{bullish, bearish, neutral, mixed}` exactly. Causes:

- The ticker's `ct_specialist_prompts` row has been edited and the new prompt elicits different vocabulary
- A specific recent read in the bias-audit baseline is poisoning the output (Claude pattern-matches to its own past style)
- A Claude model upgrade changed default vocabulary

Fix: either widen the allowed set in `parseClaudeJson` (synonyms map), OR strengthen the prompt's required-output section to explicitly enumerate the allowed enum.

Note that the Fix-D fallback (commit `<sha>`) writes a placeholder to `ct_specialist_reads` with `direction_lean='mixed', conviction=0, read_text='[parse_fail: ...] <claude output>'` so the freshness invariant doesn't re-fire while you investigate. The fallback also tags the read as `flagged=false` so it doesn't enter the Specialist Recall property's hit-rate accounting (C1 stays clean).

### 4. If the wakeup log has NO recent rows for the stale ticker

The cron isn't firing OR the function is erroring before the log write. Two paths:

- Check `pg_cron.job_run_details` (need a SQL RPC; closest available: `SELECT * FROM cron.job_run_details WHERE jobname LIKE 'ct-specialist-<ticker>%' ORDER BY end_time DESC LIMIT 10`)
- Manual fire via `pg_cron`-style net.http_post inside a one-shot DO block (the per-function HMAC-gated `/functions/v1/<fn>` path won't accept the CLI-fetched service-role key — see `feedback_service_role_key_rotation.md`)

## Why this runbook exists

Born from the 2026-05-05 audit that traced NVDA's 4-day silent freeze to:

1. `writeSpecialistRead()` only `console.warn`'d on error (invisible at the data layer)
2. `runSpecialistWakeup()` returned `ok:true` with `skip_reason='passed'` even when current_read parse failed (no row written, but cron sees HTTP 200)
3. Warden's `count(DISTINCT ticker)` invariants miss single-ticker death

The `ct_specialist_wakeup_log` table + Fix-D placeholder write + these two new invariants close the class. Do NOT roll back without a replacement observability layer.
