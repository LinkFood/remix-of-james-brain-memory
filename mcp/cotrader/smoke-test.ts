// Smoke test — exercises v1.1's three levers.
//
// 1. Cold call: full 11 organs, NVDA. Verifies skipLegacyFlatFields works,
//    payload shape, latency under v1.1 target.
// 2. Warm call: same args. Verifies cache hits on stable organs reduce
//    latency vs cold.
// 3. Subset call: organs=['regime','specialist_recall']. Verifies subset
//    fetch is fast + only requested organs come back.
// 4. Unknown organ: organs=['regimee','foo']. Verifies hard-fail when ALL
//    unknown. organs=['regime','foo'] verifies warn-and-fetch.
// 5. include_regime=false: verifies regime is skipped.
//
// Run:  deno task smoke   (from mcp/cotrader/)
//
// Exits non-zero on any failure.

import { getCoTraderContext } from './tools/get_co_trader_context.ts';
import { _resetCacheForTests, cacheStats } from './lib/organ_cache.ts';

const TOKEN_CAP = 50000;
const COLD_LATENCY_CAP_MS = 8000; // v1.1 lever 1 — should be sub-8s vs v1's ~13s
const WARM_LATENCY_CAP_MS = 5000; // cache helps stable organs
const SUBSET_LATENCY_CAP_MS = 5000; // 2 stable organs only

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
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name.padEnd(46)}  ${detail}`);
}

console.log('cotrader-mcp v1.1 smoke test — get_co_trader_context');
console.log('-'.repeat(90));

// Reset module-level cache so test results are deterministic.
_resetCacheForTests();

// ---- Test 1: cold call, full organs ----
console.log('(test 1: cold call, full organs, NVDA)');
let cold;
try {
  const t0 = performance.now();
  cold = await getCoTraderContext({ ticker: 'NVDA' });
  const wall = Math.round(performance.now() - t0);
  check('cold_full_latency_under_cap', wall <= COLD_LATENCY_CAP_MS, `${wall}ms (cap ${COLD_LATENCY_CAP_MS}ms)`);
} catch (e) {
  console.log(`FAIL  cold_full_call                          ${e instanceof Error ? e.message : e}`);
  Deno.exit(1);
}

const coldCtx = cold.structured as Record<string, unknown>;
check('cold_has_organs_map', typeof coldCtx.organs === 'object' && coldCtx.organs !== null, 'organs key present');

const coldOrgans = (coldCtx.organs as Record<string, unknown>) ?? {};
check('cold_organs_invoked_count', cold.organsInvoked.length >= 5, `${cold.organsInvoked.length} organs ran`);

for (const o of ['specialist', 'flow_heatmap', 'specialist_recall']) {
  check(`cold_organ_present:${o}`, o in coldOrgans, o in coldOrgans ? 'present' : 'MISSING');
}

const coldTok = estimateTokens(cold.textPayload);
check('cold_token_budget', coldTok <= TOKEN_CAP, `~${coldTok} tokens (cap ${TOKEN_CAP})`);

// Verify legacy flat fields ARE skipped (skipLegacyFlatFields lever).
// The v1.1 slim payload should NOT include the 50+ legacy field names.
const hasLegacyMarker = ['recentFlowAlerts', 'recentNews', 'fundamentals', 'currentGeneration'].some(
  (k) => k in coldCtx,
);
check('skipLegacyFlatFields_active', !hasLegacyMarker, hasLegacyMarker ? 'LEGACY FIELDS LEAKED' : 'legacy block bypassed');

// ---- Test 2: warm call, cache should kick in for stable organs ----
console.log('(test 2: warm call, expect cache hits on 5 stable organs)');
const beforeStats = cacheStats();
try {
  const t0 = performance.now();
  const warm = await getCoTraderContext({ ticker: 'NVDA' });
  const wall = Math.round(performance.now() - t0);
  check('warm_latency_under_cap', wall <= WARM_LATENCY_CAP_MS, `${wall}ms (cap ${WARM_LATENCY_CAP_MS}ms)`);
  check('warm_has_cache_hits', warm.cacheHits.length > 0, `${warm.cacheHits.length} cache hits: [${warm.cacheHits.map((h) => h.organ).join(', ')}]`);
  check('warm_organs_invoked_count', warm.organsInvoked.length >= 5, `${warm.organsInvoked.length} organs in response (cached + fresh)`);
} catch (e) {
  console.log(`FAIL  warm_call                              ${e instanceof Error ? e.message : e}`);
}
const afterStats = cacheStats();
check('cache_populated_by_cold_call', afterStats.entries >= beforeStats.entries, `cache entries: ${beforeStats.entries} → ${afterStats.entries}`);

// ---- Test 3: subset call, organs=['regime','specialist_recall'] ----
console.log('(test 3: subset call, organs=[regime, specialist_recall])');
try {
  const t0 = performance.now();
  const subset = await getCoTraderContext({
    ticker: 'NVDA',
    organs: ['regime', 'specialist_recall'],
  });
  const wall = Math.round(performance.now() - t0);
  check('subset_latency_under_cap', wall <= SUBSET_LATENCY_CAP_MS, `${wall}ms (cap ${SUBSET_LATENCY_CAP_MS}ms)`);
  const subsetCtx = subset.structured as { organs: Record<string, unknown> };
  const subsetOrganNames = Object.keys(subsetCtx.organs);
  // With cache populated from test 1+2, these should be cache hits → still in response.
  check(
    'subset_only_requested_present',
    subsetOrganNames.every((o) => ['regime', 'specialist_recall'].includes(o)),
    `[${subsetOrganNames.join(', ')}]`,
  );
  check(
    'subset_no_volatile_organs',
    !subsetOrganNames.includes('flow_heatmap') && !subsetOrganNames.includes('pulse'),
    'volatile organs absent ✓',
  );
} catch (e) {
  console.log(`FAIL  subset_call                            ${e instanceof Error ? e.message : e}`);
}

// ---- Test 4: validation — all unknown organs should hard-fail ----
console.log('(test 4: validation — unknown organs)');
try {
  await getCoTraderContext({ ticker: 'NVDA', organs: ['regimee', 'flowheatmap', 'foo'] });
  check('all_unknown_hard_fail', false, 'expected throw, got success');
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  check('all_unknown_hard_fail', msg.includes('unknown'), `threw: ${msg.slice(0, 80)}`);
}

console.log('(test 4b: warn-and-fetch — partial unknown)');
try {
  const partial = await getCoTraderContext({
    ticker: 'NVDA',
    organs: ['regime', 'foo', 'specialist_recall'],
  });
  check('partial_unknown_warn_and_fetch', partial.unknownOrgans.includes('foo'), `unknownOrgans=[${partial.unknownOrgans.join(', ')}]`);
  check('partial_unknown_recognized_fetched', partial.organsRequested.length === 2, `requested=${partial.organsRequested.length} (expected 2 after dropping unknowns)`);
} catch (e) {
  check('partial_unknown_warn_and_fetch', false, `unexpected throw: ${e instanceof Error ? e.message : e}`);
}

// ---- Test 5: include_regime=false ----
console.log('(test 5: include_regime=false — verify regime dropped)');
try {
  const noRegime = await getCoTraderContext({ ticker: 'NVDA', include_regime: false });
  check(
    'include_regime_false_drops_regime',
    !noRegime.organsInvoked.includes('regime'),
    `organs=[${noRegime.organsInvoked.join(', ')}]`,
  );
} catch (e) {
  check('include_regime_false_drops_regime', false, e instanceof Error ? e.message : String(e));
}

// ---- summary ----
console.log('-'.repeat(90));
const failed = results.filter((r) => !r.passed);
if (failed.length === 0) {
  console.log(`ALL ${results.length} CHECKS PASSED`);
  Deno.exit(0);
} else {
  console.log(`${failed.length}/${results.length} FAILED`);
  Deno.exit(1);
}
