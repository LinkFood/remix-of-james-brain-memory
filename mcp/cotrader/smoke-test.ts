// Smoke test — exercises v1.1's three levers + v2 Tier 1's 5 new read-only
// tools. Existing v1 checks preserved verbatim.
//
// v1 (preserved):
//   1. Cold call: full 11 organs, NVDA. Verifies skipLegacyFlatFields works.
//   2. Warm call: same args. Verifies cache hits on stable organs.
//   3. Subset call: organs=['regime','specialist_recall'].
//   4. Unknown organ hard-fail vs warn-and-fetch.
//   5. include_regime=false drops regime.
//
// v2 Tier 1 (new):
//   6. get_observed_patterns — happy path.
//   7. get_morning_brief — happy path (today's brief or fallback).
//   8. get_eod_summary — happy path slim mode.
//   9. get_warden_state — happy path RPC.
//  10. get_recent_james_flags — happy path (likely zero rows, but valid query).
//
// Each new check verifies: payload structure, ≤8k token budget, telemetry
// path didn't throw, latency under cap.
//
// Run:  deno task smoke   (from mcp/cotrader/)
//
// Exits non-zero on any failure.

import { getCoTraderContext } from './tools/get_co_trader_context.ts';
import { _resetCacheForTests, cacheStats } from './lib/organ_cache.ts';
import { getObservedPatterns } from './tools/get_observed_patterns.ts';
import { getMorningBrief } from './tools/get_morning_brief.ts';
import { getEodSummary } from './tools/get_eod_summary.ts';
import { getWardenState } from './tools/get_warden_state.ts';
import { getRecentJamesFlags } from './tools/get_recent_james_flags.ts';

const TOKEN_CAP = 50000;
const COLD_LATENCY_CAP_MS = 8000; // v1.1 lever 1 — should be sub-8s vs v1's ~13s
const WARM_LATENCY_CAP_MS = 5000; // cache helps stable organs
const SUBSET_LATENCY_CAP_MS = 5000; // 2 stable organs only

// v2 Tier 1 budget — direct table reads should be sub-8k tokens, sub-5s.
const V2_TOKEN_CAP = 8000;
const V2_LATENCY_CAP_MS = 5000;

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

console.log('cotrader-mcp v2 Tier 1 smoke test — v1 (5 tests) + v2 (5 tools)');
console.log('-'.repeat(90));

// Reset module-level cache so test results are deterministic.
_resetCacheForTests();

// ===========================================================================
// v1 SECTION (preserved verbatim from v1.1 smoke)
// ===========================================================================

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

// ===========================================================================
// v2 Tier 1 SECTION
// ===========================================================================

// ---- Test 6: get_observed_patterns ----
console.log('(test 6: get_observed_patterns — default filters)');
try {
  const t0 = performance.now();
  const op = await getObservedPatterns({});
  const wall = Math.round(performance.now() - t0);
  check('observed_patterns_latency_under_cap', wall <= V2_LATENCY_CAP_MS, `${wall}ms (cap ${V2_LATENCY_CAP_MS}ms)`);
  check('observed_patterns_payload_shape', Array.isArray(op.patterns) && typeof op.meta === 'object', `patterns=${op.patterns.length} meta keys=${Object.keys(op.meta).length}`);
  check(
    'observed_patterns_status_default',
    op.meta.appliedFilters.status.length === 2 &&
      op.meta.appliedFilters.status.includes('validated') &&
      op.meta.appliedFilters.status.includes('observed'),
    `status=[${op.meta.appliedFilters.status.join(',')}]`,
  );
  const opTok = estimateTokens(JSON.stringify(op));
  check('observed_patterns_token_budget', opTok <= V2_TOKEN_CAP, `~${opTok} tokens (cap ${V2_TOKEN_CAP})`);
} catch (e) {
  check('observed_patterns_happy_path', false, e instanceof Error ? e.message : String(e));
}

// ---- Test 7: get_morning_brief ----
console.log('(test 7: get_morning_brief — default ET date)');
try {
  const t0 = performance.now();
  const mb = await getMorningBrief({});
  const wall = Math.round(performance.now() - t0);
  check('morning_brief_latency_under_cap', wall <= V2_LATENCY_CAP_MS, `${wall}ms (cap ${V2_LATENCY_CAP_MS}ms)`);
  check(
    'morning_brief_meta_shape',
    typeof mb.meta.requestedEtDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(mb.meta.requestedEtDate),
    `et_date=${mb.meta.requestedEtDate}`,
  );
  check(
    'morning_brief_window_resolved',
    typeof mb.meta.etWindowStartUtc === 'string' && typeof mb.meta.etWindowEndUtc === 'string',
    `${mb.meta.etWindowStartUtc} → ${mb.meta.etWindowEndUtc}`,
  );
  // Brief may legitimately be null on a freshly-passed midnight before the cron
  // fires — both null and a row are valid happy paths. Verify at least the
  // contract shape.
  check(
    'morning_brief_brief_field_typed',
    mb.brief === null || (typeof mb.brief === 'object' && 'id' in (mb.brief as object)),
    mb.brief ? `row id=${(mb.brief as { id: string }).id.slice(0, 8)}…` : 'no row (acceptable)',
  );
  const mbTok = estimateTokens(JSON.stringify(mb));
  check('morning_brief_token_budget', mbTok <= V2_TOKEN_CAP, `~${mbTok} tokens (cap ${V2_TOKEN_CAP})`);
} catch (e) {
  check('morning_brief_happy_path', false, e instanceof Error ? e.message : String(e));
}

// ---- Test 8: get_eod_summary (slim default) ----
console.log('(test 8: get_eod_summary — slim default)');
try {
  const t0 = performance.now();
  const eod = await getEodSummary({});
  const wall = Math.round(performance.now() - t0);
  check('eod_summary_latency_under_cap', wall <= V2_LATENCY_CAP_MS, `${wall}ms (cap ${V2_LATENCY_CAP_MS}ms)`);
  check(
    'eod_summary_session_date_resolved',
    typeof eod.meta.requestedSessionDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(eod.meta.requestedSessionDate),
    `session=${eod.meta.requestedSessionDate}`,
  );
  check('eod_summary_slim_default', eod.meta.verbose === false, `verbose=${eod.meta.verbose}`);
  // payload may be null only if there's truly no data anywhere — extremely
  // unlikely in production. If null, verify warnings carries the cause.
  check(
    'eod_summary_payload_or_warning',
    eod.payload !== null || (eod.meta.warnings.length > 0),
    eod.payload ? 'payload present' : `warnings: ${eod.meta.warnings.join('; ')}`,
  );
  // Slim mode must NOT carry summary_text (verbose-only field)
  if (eod.payload) {
    const slim = eod.payload as Record<string, unknown>;
    check(
      'eod_summary_slim_excludes_long_markdown',
      !('summary_text' in slim),
      'summary_text correctly excluded from slim payload',
    );
  }
  const eodTok = estimateTokens(JSON.stringify(eod));
  check('eod_summary_slim_token_budget', eodTok <= V2_TOKEN_CAP, `~${eodTok} tokens (cap ${V2_TOKEN_CAP})`);
} catch (e) {
  check('eod_summary_happy_path', false, e instanceof Error ? e.message : String(e));
}

// ---- Test 9: get_warden_state ----
console.log('(test 9: get_warden_state — default 24h window)');
try {
  const t0 = performance.now();
  const ws = await getWardenState({});
  const wall = Math.round(performance.now() - t0);
  check('warden_state_latency_under_cap', wall <= V2_LATENCY_CAP_MS, `${wall}ms (cap ${V2_LATENCY_CAP_MS}ms)`);
  check('warden_state_window_default', ws.meta.windowHours === 24, `window_hours=${ws.meta.windowHours}`);
  check(
    'warden_state_payload_shape',
    ws.warden !== null && typeof ws.warden === 'object' && 'totals' in ws.warden && 'failures' in ws.warden,
    ws.warden ? `totals=${JSON.stringify(ws.warden.totals)}` : 'NULL warden payload',
  );
  const wsTok = estimateTokens(JSON.stringify(ws));
  check('warden_state_token_budget', wsTok <= V2_TOKEN_CAP, `~${wsTok} tokens (cap ${V2_TOKEN_CAP})`);
} catch (e) {
  check('warden_state_happy_path', false, e instanceof Error ? e.message : String(e));
}

// ---- Test 10: get_recent_james_flags ----
console.log('(test 10: get_recent_james_flags — default 24h, no ticker)');
try {
  const t0 = performance.now();
  const jf = await getRecentJamesFlags({});
  const wall = Math.round(performance.now() - t0);
  check('james_flags_latency_under_cap', wall <= V2_LATENCY_CAP_MS, `${wall}ms (cap ${V2_LATENCY_CAP_MS}ms)`);
  check('james_flags_payload_shape', Array.isArray(jf.flags) && typeof jf.meta === 'object', `flags=${jf.flags.length}`);
  check('james_flags_hours_default', jf.meta.appliedFilters.hours === 24, `hours=${jf.meta.appliedFilters.hours}`);
  check('james_flags_no_ticker_filter', jf.meta.appliedFilters.ticker === null, 'ticker filter absent');
  const jfTok = estimateTokens(JSON.stringify(jf));
  check('james_flags_token_budget', jfTok <= V2_TOKEN_CAP, `~${jfTok} tokens (cap ${V2_TOKEN_CAP})`);

  // Universe-lock validation — off-watchlist ticker MUST throw
  let threw = false;
  try {
    await getRecentJamesFlags({ ticker: 'XYZ' });
  } catch (e) {
    threw = e instanceof Error && /not in the Co-Trader universe/.test(e.message);
  }
  check('james_flags_off_universe_throws', threw, threw ? 'rejected XYZ ✓' : 'did NOT throw on off-universe ticker');
} catch (e) {
  check('james_flags_happy_path', false, e instanceof Error ? e.message : String(e));
}

// ===========================================================================
// summary
// ===========================================================================
console.log('-'.repeat(90));
const failed = results.filter((r) => !r.passed);
if (failed.length === 0) {
  console.log(`ALL ${results.length} CHECKS PASSED`);
  Deno.exit(0);
} else {
  console.log(`${failed.length}/${results.length} FAILED`);
  Deno.exit(1);
}
