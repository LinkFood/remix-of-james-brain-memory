// Co-Trader MCP server — v1, single tool, stdio transport, read-only.
//
// Boot:   deno run --allow-all mcp/cotrader/server.ts
// Verify: deno task smoke
// Register with Claude Code: see mcp/cotrader/README.md.

import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/mcp.js';
import { StdioServerTransport } from 'npm:@modelcontextprotocol/sdk@1.29.0/server/stdio.js';
import { z } from 'npm:zod@3.25.76';

import { getCoTraderContext } from './tools/get_co_trader_context.ts';
import { UNIVERSE } from './lib/universe.ts';

const SERVER_NAME = 'cotrader';
const SERVER_VERSION = '1.0.0';

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cotrader-mcp] server v${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  console.error(`[cotrader-mcp] fatal: ${err instanceof Error ? err.message : err}`);
  Deno.exit(1);
});
