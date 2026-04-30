# UW Caller-Tagging Audit — LB8 CUT 5

**Date:** 2026-04-30
**Scope:** Visibility audit. No code changes here — Saturday will tag whatever this report flags.

## Method

Grep over `supabase/functions/**/index.ts` for either UW client import:

- `_shared/uwClient.ts` (HTTP path: `uwGet`, `uwBudgetOk`, `uwBudgetTier`, `getOptionContractLatestMid`, etc.)
- `_shared/uwMcpClient.ts` (MCP path: `mcpCallToolAsData`, `mcpCallTool`, etc.)

Then check whether the same file calls **either** of the caller-tagging helpers:

- `setUwCaller(...)` — tags rows in `ct_uw_usage` for HTTP-path calls
- `setMcpCaller(...)` — tags rows for MCP-path calls

A function is "untagged" if it imports a UW client but never calls either tagging helper.

## Result

**Untagged callers: 0**

| Client surface | Importing fns | Untagged |
|----------------|---------------|----------|
| `_shared/uwClient.ts`     | 28 | 0 |
| `_shared/uwMcpClient.ts`  | 21 | 0 |

Every Co-Trader edge function that touches Unusual Whales currently identifies itself in `ct_uw_usage`. No fan-out tagging work needed Saturday — attribution analytics already cover the full caller surface.

## Caller surface (for reference)

### `_shared/uwClient.ts` importers (28)

```
ct-analyst-ingester
ct-contract-poller
ct-earnings-sync
ct-eod-positioning
ct-event-calendar-ingester
ct-flow-ingester
ct-fundamentals-sync
ct-gex-radar
ct-heatmap-snapshot
ct-historical-quote-backfill
ct-insider-ingester
ct-iv-shift-watch
ct-linkgex-deep
ct-net-prem-cumulative
ct-news-ingester
ct-oi-backfill-historical
ct-oi-snapshot
ct-political-ingester
ct-premarket-scan
ct-price-live-poll
ct-price-tick-capture
ct-sector-tide-ingester
ct-short-interest-ingester
ct-skew-ingester
ct-spy-capture
ct-tape-backfill
ct-uw-endpoint-health-check
ct-watcher
```

### `_shared/uwMcpClient.ts` importers (21)

```
ct-analyst-ingester
ct-central-bank-ingester
ct-correlations-ingester
ct-flow-ingester
ct-indicator-events-ingester
ct-insider-ingester
ct-institutional-ingester
ct-interval-flow-ingester
ct-mcp-shape-probe
ct-oi-backfill-historical
ct-oi-snapshot
ct-options-screener-ingester
ct-political-ingester
ct-prediction-markets-ingester
ct-prediction-smart-money-ingester
ct-price-backfill
ct-seasonality-ingester
ct-technicals-ingester
ct-uw-mcp-scout
ct-vix-capture
ct-yield-curve-ingester
```

## Follow-ups (defer to Saturday or later)

1. **Forward-looking guardrail:** add a pre-deploy lint that rejects any `index.ts` importing one of the UW clients but missing the matching `setXCaller(...)` call. Cheap shell script in CI; structural prevention per JAC tenet 13.

2. **Caller-name normalization:** spot-check `ct_uw_usage.caller` for typos / drift from filename. If any caller tag deviates from its function-directory name, fix at source.

3. **MCP vs HTTP attribution overlap:** functions that import both clients (e.g. `ct-flow-ingester`, `ct-oi-snapshot`) should set both tags so the per-tool breakdown stays accurate regardless of which path each tool routes through.

(All three are housekeeping; none block live ops.)
