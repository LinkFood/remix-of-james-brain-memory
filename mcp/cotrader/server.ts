// Co-Trader MCP server — v2 Tier 1, six tools, stdio transport, read-only.
//
// Boot:   deno run --allow-all mcp/cotrader/server.ts
// Verify: deno task smoke
// Register with Claude Code: see mcp/cotrader/README.md.
//
// Tools:
//   1. get_co_trader_context (v1.1 — composed brain context per ticker)
//   2. get_observed_patterns (v2 — forensic pattern catalog)
//   3. get_morning_brief (v2 — Co-Trader market brief at ct_daily_briefs)
//   4. get_jac_brief (v2 — JAC's life self-review brief; renamed from
//      get_morning_brief 2026-05-07 per Path C scoping)
//   5. get_brain_principles (v2 — distilled behavior rules from
//      jac_principles. Re-added 2026-05-07 — 5/5 audit comment claiming
//      brain_principles table missing was stale; jac_principles is the
//      canonical source and now populated.)
//   6. get_eod_summary (v2 — Co-Trader EOD session summary, slim by default)
//   7. get_warden_state (v2 — System Warden invariant snapshot via RPC)
//   8. get_recent_james_flags (v2 — flags James personally starred from /tape)
//
// 5/5 note (now stale): get_brain_principles was DROPPED per Phase A audit
// §9.1 because `brain_principles` table didn't exist. Phase A 2026-05-07
// confirmed `jac_principles` IS the canonical table (rows present;
// distill-principles cron writing). Tool re-added today, sourced from
// jac_principles. Same instance #35 lesson: verify table name before
// locking design — and the lesson reverses cleanly when the underlying
// state changes.

import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/mcp.js';
import { StdioServerTransport } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/stdio.js';
import { z } from 'npm:zod@3.25.76';

import { getCoTraderContext } from './tools/get_co_trader_context.ts';
import { getObservedPatterns } from './tools/get_observed_patterns.ts';
import { getMorningBrief } from './tools/get_morning_brief.ts';
import { getJacBrief } from './tools/get_jac_brief.ts';
import { getBrainPrinciples } from './tools/get_brain_principles.ts';
import { getEodSummary } from './tools/get_eod_summary.ts';
import { getWardenState } from './tools/get_warden_state.ts';
import { getRecentJamesFlags } from './tools/get_recent_james_flags.ts';
import { UNIVERSE } from './lib/universe.ts';

const SERVER_NAME = 'cotrader';
const SERVER_VERSION = '2.0.0';

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// ---------------------------------------------------------------------------
// Tool 1: get_co_trader_context (v1.1 — UNCHANGED, byte-identical)
// ---------------------------------------------------------------------------

server.registerTool(
  'get_co_trader_context',
  {
    description:
      'Returns the composed Co-Trader brain context for a single watchlist ticker. ' +
      'Surfaces regime classification + analogs, last 5 specialist reads (flagged + ' +
      'unflagged-conv-≥50), recent flow alerts, flow heatmap stacks, James-flagged ' +
      'signals, news causality, event recency, observed-pattern detectors, pulse ' +
      'state, and tape narration — the same composed payload Co-Trader specialists ' +
      'and the tape-reader read internally. READ-ONLY. Universe is locked to: ' +
      UNIVERSE.join(', ') + '. ' +
      'For fast quick-lookups, scope via the optional organs[] param (e.g., ' +
      'organs=["regime","specialist_recall"] is a sub-second response).',
    inputSchema: {
      ticker: z
        .string()
        .describe(
          'Ticker symbol. Must be one of the 10 watchlist names: ' +
            UNIVERSE.join(', ') +
            '. Case-insensitive.',
        ),
      include_regime: z
        .boolean()
        .optional()
        .describe(
          'Include the Pulse v2 regime organ. Default true. Set false for cheap ' +
            'quick-lookups — skips one Voyage embed (~$0.0000016) and the ' +
            'analogs HNSW lookup.',
        ),
      organs: z
        .array(z.string())
        .optional()
        .describe(
          'Optional subset of organs to fetch (default: all 11). Valid names: ' +
            'flow_heatmap, pulse, specialist, detector, tape, james_flags, ' +
            'news_causality, event_recency, analogs, specialist_recall, regime. ' +
            'Unknown names are warned and ignored unless ALL are unknown ' +
            '(then the call fails). Stable organs (regime, event_recency, analogs, ' +
            'specialist_recall, james_flags) are 5-min in-process cached.',
        ),
    },
  },
  async (args: { ticker: string; include_regime?: boolean; organs?: string[] }) => {
    const t0 = Date.now();
    try {
      const result = await getCoTraderContext({
        ticker: args.ticker,
        include_regime: args.include_regime,
        organs: args.organs,
      });
      const totalMs = Date.now() - t0;
      // stderr — MCP protocol owns stdout
      console.error(
        `[cotrader-mcp] tool=get_co_trader_context ticker=${args.ticker.toUpperCase()} ` +
          `include_regime=${args.include_regime ?? true} ` +
          `requested=${result.organsRequested.length} ` +
          `cache_hits=${result.cacheHits.length} ` +
          `organs_invoked=${result.organsInvoked.length} ` +
          `unknown_organs=${result.unknownOrgans.length} ` +
          `build_ms=${result.latencyMs} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: result.textPayload }],
        structuredContent: result.structured as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR ticker=${args.ticker} msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 2: get_observed_patterns
// ---------------------------------------------------------------------------

server.registerTool(
  'get_observed_patterns',
  {
    description:
      "Returns the forensic platform's catalog of statistically-confirmed " +
      'patterns over Co-Trader flag history (e.g. "puts -21pp baseline_delta at ' +
      'n=431"). Each row carries pattern_signature (JSONB key axis/instrument/' +
      'side/detector_id/etc.), n_observed, hit_rate_blended, baseline_delta, ' +
      'recommended_action, and status. Use when the user asks about validated ' +
      'patterns, the observed-pattern catalog, what the corpus has shown, or what ' +
      'the system has statistically learned about flag outcomes. Default status ' +
      'filter is validated+observed (excludes deprecated). READ-ONLY.',
    inputSchema: {
      ticker: z
        .string()
        .optional()
        .describe(
          'Optional ticker filter. Matches pattern_signature->>instrument via ' +
            'JSONB containment. Off-watchlist tickers return empty without ' +
            "throwing (pattern signatures don't always carry an instrument key).",
        ),
      status: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'Status filter: validated | observed | deprecated. Accepts a single ' +
            'string, comma-separated string, or array. Default: ["validated", "observed"].',
        ),
      min_n: z
        .number()
        .optional()
        .describe(
          'Optional minimum n_observed (sample size) filter. Drops patterns ' +
            'with fewer settled observations.',
        ),
      limit: z
        .number()
        .optional()
        .describe('Max rows to return. Default 25, hard cap 50.'),
    },
  },
  async (args) => {
    const t0 = Date.now();
    try {
      const result = await getObservedPatterns(args);
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_observed_patterns ticker=${result.meta.appliedFilters.ticker ?? 'all'} ` +
          `status=[${result.meta.appliedFilters.status.join(',')}] ` +
          `rows=${result.meta.rowCount} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_observed_patterns msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 3: get_morning_brief
// ---------------------------------------------------------------------------

server.registerTool(
  'get_morning_brief',
  {
    description:
      "Returns the Co-Trader market brief for a given ET session date (default: " +
      "today). The brief is the captain workflow's market-context entry point " +
      'compiled by the ct-daily-brief cron at ~11:00 UTC weekdays — macro_regime, ' +
      'macro_narrative, overnight_action, breaking_events, watchlist_focus + ' +
      'skip_today, high_conviction_ideas (with entry_range/stop/target/thesis), ' +
      'and per_ticker_reads (stance/tape_view/event_reminders/alignment). ' +
      'Use when the user asks about the morning brief, today\'s market setup, ' +
      'high-conviction ideas, or watchlist focus for the session. Source table: ' +
      'ct_daily_briefs. Distinct from get_jac_brief (life-management). ' +
      'EXPLICIT ABSENCE: returns status="no_brief_today" with structured-empty ' +
      'fields when no brief exists for the requested date — does NOT silently ' +
      'fall back to yesterday. READ-ONLY.',
    inputSchema: {
      date: z
        .string()
        .optional()
        .describe(
          'Optional ET session date (YYYY-MM-DD). Default: today ET. If no ' +
            'brief exists for the requested date, returns structured-empty ' +
            '(status=no_brief_today) — never silently returns a different date.',
        ),
    },
  },
  async (args: { date?: string }) => {
    const t0 = Date.now();
    try {
      const result = await getMorningBrief(args);
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_morning_brief et_date=${result.meta.requestedEtDate} ` +
          `status=${result.brief.status} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_morning_brief msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 4: get_jac_brief (renamed from get_morning_brief 2026-05-07 per Path C)
// ---------------------------------------------------------------------------

server.registerTool(
  'get_jac_brief',
  {
    description:
      "Returns JAC's life-management self-review brief for a given ET date " +
      "(default: today's brief if it has fired, else yesterday). Compiled by " +
      "the jac-morning-brief cron at ~10:00 UTC daily — today's schedule, " +
      "overdue items, brain activity reflections, heads-up items. Source " +
      'table: brain_reports filtered to report_type=morning_brief. Distinct ' +
      'from get_morning_brief (Co-Trader market brief at ct_daily_briefs). ' +
      'Use when the user asks about their personal schedule per JAC, overdue ' +
      'items, or "what did JAC reflect on this morning." Returns single row ' +
      'with title, summary, body_markdown, structured metadata. READ-ONLY. ' +
      'Note: brief content may include personal scheduling context — treat ' +
      'MCP transcripts as private journal.',
    inputSchema: {
      date: z
        .string()
        .optional()
        .describe(
          'Optional ET session date (YYYY-MM-DD). Default: today ET if a brief ' +
            'has likely fired (>= 6 AM ET), else yesterday ET.',
        ),
    },
  },
  async (args: { date?: string }) => {
    const t0 = Date.now();
    try {
      const result = await getJacBrief(args);
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_jac_brief et_date=${result.meta.requestedEtDate} ` +
          `found=${result.meta.rowCount} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_jac_brief msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: get_brain_principles
// ---------------------------------------------------------------------------

server.registerTool(
  'get_brain_principles',
  {
    description:
      "Returns the captain's distilled behavior principles from " +
      '`jac_principles` — codified failure modes and decision rules learned ' +
      'from prior session reflections, written by the distill-principles ' +
      'cron. Filters to active principles (retired_at IS NULL). Use when ' +
      "evaluating whether a current setup pattern matches a previously- " +
      "codified failure mode (e.g., 'do any of my principles flag this ' +
      "GOOGL conviction idea?'). " +
      'EXPLICIT ABSENCE: returns status="no_principles_yet" with empty ' +
      'principles[] when no active rows exist — does NOT fabricate. ' +
      'Doc field source_pattern returns null per Path C contract — DB has ' +
      'no descriptive failure-mode text field; surface ' +
      'source_reflection_ids array for callers wanting depth. READ-ONLY.',
    inputSchema: {},
  },
  async () => {
    const t0 = Date.now();
    try {
      const result = await getBrainPrinciples({});
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_brain_principles status=${result.brief.status} ` +
          `count=${result.brief.total_count} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_brain_principles msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: get_eod_summary
// ---------------------------------------------------------------------------

server.registerTool(
  'get_eod_summary',
  {
    description:
      "Returns Co-Trader's end-of-day session summary for a given trading " +
      'session (default: most-recent completed session per market clock). ' +
      'Combines ct_eod_reports (per-ticker close, regime shift, tomorrow watchlist, ' +
      "lessons) with ct_eod_summaries (regime tag, snapshot hit-rate, today's " +
      'realized tracks). Use when the user asks how a session graded out, what ' +
      "the EOD report said, today's specialist scorecard, or tomorrow's watchlist. " +
      'DEFAULT MODE IS SLIM (~3k tokens). Pass verbose: true for the full ' +
      'long-form markdown narrative + every JSONB block (~12k tokens). READ-ONLY.',
    inputSchema: {
      date: z
        .string()
        .optional()
        .describe(
          'Optional ET session date (YYYY-MM-DD). Default: last completed ' +
            "trading session per marketClock — yesterday's during RTH, today's " +
            'after the close.',
        ),
      verbose: z
        .boolean()
        .optional()
        .describe(
          'Set true to include the full long-form summary_text markdown plus ' +
            'every JSONB recap block (specialist_stats, ticker_stats, ' +
            'edge_attribution, flow_recap, etc.). Default false (slim ~3k tokens).',
        ),
    },
  },
  async (args: { date?: string; verbose?: boolean }) => {
    const t0 = Date.now();
    try {
      const result = await getEodSummary(args);
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_eod_summary session=${result.meta.requestedSessionDate} ` +
          `verbose=${result.meta.verbose} summary=${result.meta.summaryRowFound} ` +
          `report=${result.meta.reportRowFound} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_eod_summary msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 5: get_warden_state
// ---------------------------------------------------------------------------

server.registerTool(
  'get_warden_state',
  {
    description:
      "Returns the System Warden's current invariant snapshot — totals + " +
      'by-category breakdown + sorted failures[] each carrying severity, ' +
      'runbook_path, last_value, and last_run_at. Backed by the canonical ' +
      'public.get_warden_health(window_hours) RPC, server-aggregated in one ' +
      'round-trip. Use when the user asks "is the system healthy right now," ' +
      "what's failing, is the warden green, or whether any warden alarms have " +
      'fired. NOT per-ticker — system health is global. READ-ONLY.',
    inputSchema: {
      window_hours: z
        .number()
        .optional()
        .describe(
          'Look-back window for the failures[] roll-up. Default 24, min 1, ' +
            'max 720 (30 days). Lets the user widen the window to see ' +
            'historical state changes.',
        ),
    },
  },
  async (args: { window_hours?: number }) => {
    const t0 = Date.now();
    try {
      const result = await getWardenState(args);
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_warden_state window_h=${result.meta.windowHours} ` +
          `failures=${result.meta.failureCount} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_warden_state msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool 6: get_recent_james_flags
// ---------------------------------------------------------------------------

server.registerTool(
  'get_recent_james_flags',
  {
    description:
      'Returns flags James has personally starred from the /tape UI within the ' +
      'last `hours` hours (default 24, max 168). These are James\'s hand-labeled ' +
      'signals (source=james_star) — distinct from the system\'s auto-generated ' +
      'detector flags. Use when the user asks "what did I flag yesterday," "what ' +
      'was I tracking this week," or "show me my own marks." Off-watchlist ' +
      'tickers rejected (universe is locked: ' + UNIVERSE.join(', ') + '). ' +
      'READ-ONLY. Returns rows with instrument, side, score, thesis, ' +
      'invalidation, horizon, status, and timestamps.',
    inputSchema: {
      hours: z
        .number()
        .optional()
        .describe('Lookback window in hours. Default 24, max 168 (1 week).'),
      ticker: z
        .string()
        .optional()
        .describe(
          'Optional ticker filter. Must be in the locked 10-name universe. ' +
            'Off-watchlist arg throws.',
        ),
      limit: z
        .number()
        .optional()
        .describe('Max rows to return. Default 50, hard cap 200.'),
    },
  },
  async (args: { hours?: number; ticker?: string; limit?: number }) => {
    const t0 = Date.now();
    try {
      const result = await getRecentJamesFlags(args);
      const totalMs = Date.now() - t0;
      console.error(
        `[cotrader-mcp] tool=get_recent_james_flags hours=${result.meta.appliedFilters.hours} ` +
          `ticker=${result.meta.appliedFilters.ticker ?? 'all'} ` +
          `rows=${result.meta.rowCount} total_ms=${totalMs}`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cotrader-mcp] ERROR get_recent_james_flags msg=${msg}`);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cotrader-mcp] server v${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  console.error(`[cotrader-mcp] fatal: ${err instanceof Error ? err.message : err}`);
  Deno.exit(1);
});
