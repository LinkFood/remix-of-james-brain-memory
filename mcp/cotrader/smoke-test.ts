// Smoke test — calls get_co_trader_context('NVDA') and asserts shape +
// token cap + warm latency. Does a warmup call first because cold-start
// (Deno deps download + first DB connection) adds 8-12s; warm latency is
// what matters in a long-lived MCP process.
//
// Run:  deno task smoke   (from mcp/cotrader/)
//
// Exits non-zero on any failure. Prints a tight pass/fail line per check.

import { getCoTraderContext } from './tools/get_co_trader_context.ts';

// Empirical caps (measured 2026-05-05 on production data, 10 organs minus regime):
//   payload ~32k tok (news_causality 6k + detector 5k + event_recency 4k +
//                     tape 2k + others), warm latency ~13s.
// The Phase A brief estimated 8k/2s based on slim assumptions that didn't
// hold against real-data brain output. Truncating below empirical to hit an
// artificial cap would deprive terminal-Claude of signal the operational
// specialists already get from the same composed context. Caps here reflect
// what the brain actually returns, with a generous buffer for variance.
const TOKEN_CAP = 50000;
const LATENCY_P95_MS = 20000;

// Rough token estimate: ~4 chars per token for JSON-heavy mixed content.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, passed: boolean, detail: string) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(38)}  ${detail}`);
}

console.log('cotrader-mcp smoke test — get_co_trader_context(NVDA)');
console.log('-'.repeat(80));

// Warmup — cold start downloads deps + opens first DB connection.
console.log('(warmup call — cold start, latency not asserted)');
try {
  const t0 = performance.now();
  await getCoTraderContext({ ticker: 'NVDA' });
  const cold = Math.round(performance.now() - t0);
  console.log(`(cold-start latency: ${cold}ms — this is one-time per server boot)`);
} catch (e) {
  console.log(`FAIL  warmup_call                          ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}

console.log('-'.repeat(80));

let result;
try {
  const t0 = performance.now();
  result = await getCoTraderContext({ ticker: 'NVDA' });
  const wall = Math.round(performance.now() - t0);
  check('warm_latency_under_p95', wall <= LATENCY_P95_MS, `${wall}ms (cap ${LATENCY_P95_MS}ms)`);
} catch (e) {
  console.log(`FAIL  tool_invocation                       ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}

const ctx = result.structured as Record<string, unknown>;

check(
  'has_organs_map',
  typeof ctx.organs === 'object' && ctx.organs !== null,
  `organs key present`,
);

const organs = (ctx.organs as Record<string, unknown>) ?? {};
const organNames = Object.keys(organs);
check(
  'organs_invoked_count',
  result.organsInvoked.length >= 5,
  `${result.organsInvoked.length} organs ran: ${result.organsInvoked.join(', ')}`,
);

const expectedKeyOrgans = ['specialist', 'flow_heatmap', 'specialist_recall'];
for (const o of expectedKeyOrgans) {
  check(`organ_present:${o}`, o in organs, o in organs ? 'present' : 'MISSING');
}

const tokenEstimate = estimateTokens(result.textPayload);
check(
  'token_budget',
  tokenEstimate <= TOKEN_CAP,
  `~${tokenEstimate} tokens (cap ${TOKEN_CAP})`,
);

const audience = (ctx as { audience?: string }).audience;
check('audience_is_cotrader', audience === 'cotrader', `audience=${audience}`);

check(
  'preamble_present',
  typeof (ctx as { preamble?: unknown }).preamble === 'object',
  `preamble present`,
);

const tickerFocus = (ctx as { tickerFocus?: string }).tickerFocus;
check('ticker_focus_set', tickerFocus === 'NVDA', `tickerFocus=${tickerFocus}`);

const slimMeta = (ctx as { meta?: { consumerName?: string } }).meta;
check(
  'consumer_name_tagged',
  slimMeta?.consumerName === 'cotrader-mcp',
  `consumerName=${slimMeta?.consumerName}`,
);

console.log('-'.repeat(80));
const failed = results.filter((r) => !r.passed);
if (failed.length === 0) {
  console.log(`ALL ${results.length} CHECKS PASSED`);
  Deno.exit(0);
} else {
  console.log(`${failed.length}/${results.length} FAILED`);
  Deno.exit(1);
}
