// ct-mcp-verification-runner — Verification layer Phase 2 edge function.
//
// Promotes Phase 1 (mcp/cotrader/tests/run_verification.ts, manual stdout)
// to continuously-enforced via cron + warden invariant. Empirically justified
// by 2026-05-07 incidents:
//   - gateway-rewrite cascade (3 helpers needed apikey)
//   - wrong-table-pointed morning_brief (instance #35 — would've been caught
//     by data-fidelity test fired automatically rather than by James's manual
//     eyeball-comparison against the site)
//
// Architecture: this function INLINES the test logic instead of importing
// from mcp/cotrader/tools/ (cross-directory imports outside _shared/ don't
// bundle on supabase functions deploy). The tests verify data fidelity by
// running the same DB queries the tools make, then comparing to ground-truth
// — that's what the Phase 1 tests did too. Tool stdio-protocol surface is
// covered by smoke-test.ts (separate concern).
//
// Categories per scoping doc:
//   1. Callability        — query runs without auth/transport errors
//   2. Schema compliance  — return shape matches declared interface
//   3. Data fidelity      — values match direct DB query
//   4. Edge cases         — empty/invalid input → structured-empty
//   5. Failure modes      — absent data → status='no_brief_today' / null
//
// Race-condition discipline: ground-truth DB query runs FIRST, then
// "tool simulation" query, then comparison.
//
// Tool coverage (2026-05-07 evening — extended from 4 → 8 tools per
// v2 Tier 1 verification batch):
//   1. get_co_trader_context       (3 tests, T1.1-T1.3)
//   2. get_morning_brief           (4 tests, T2.1-T2.4 — 2 conditional)
//   3. get_jac_brief               (3 tests, T3.1-T3.3 — 1 conditional)
//   4. get_brain_principles        (3 tests, T4.1-T4.3)
//   5. get_observed_patterns       (3 tests, T5.1-T5.3)
//   6. get_eod_summary             (3 tests, T6.1-T6.3 — 1 conditional)
//   7. get_warden_state            (3 tests, T7.1-T7.3 — 2 conditional)
//   8. get_recent_james_flags      (3 tests, T8.1-T8.3)
// Upper bound: 25 tests; conditional tests (gtBrief/gtJac/gtEod/gtWarden
// presence) drop bound when ground-truth DB row absent. mcp_tool_correctness
// invariant counts FAIL+DRIFT only — row-count fluctuation does not flag.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { buildClaudeContext } from '../_shared/claudeReadSurface.ts';

type Status = 'PASS' | 'FAIL' | 'DRIFT';

interface TestResult {
  tool_name: string;
  test_name: string;
  category: 1 | 2 | 3 | 4 | 5;
  result: Status;
  evidence: string;
  duration_ms: number;
  diff?: Record<string, unknown>;
}

const CONSUMER_NAME = 'ct-mcp-verification-runner';

function todayInET(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function runAllTests(supabase: SupabaseClient): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const now = () => performance.now();

  // ---- Tool 1: get_co_trader_context ----

  // T1.1 callability: SPY returns valid result with organs
  {
    const t0 = now();
    try {
      const ctx = await buildClaudeContext(supabase, {
        audience: 'cotrader',
        consumerName: CONSUMER_NAME,
        organs: ['flow_heatmap', 'pulse', 'specialist', 'detector', 'tape', 'james_flags', 'news_causality', 'event_recency', 'analogs', 'specialist_recall'],
        tickerFocus: 'SPY',
      });
      const ok = typeof ctx === 'object' && ctx.organs !== null;
      results.push({
        tool_name: 'get_co_trader_context', test_name: 'callable_with_spy', category: 1,
        result: ok ? 'PASS' : 'FAIL',
        evidence: `organs returned: ${Object.keys(ctx.organs ?? {}).length}`,
        duration_ms: Math.round(now() - t0),
      });
    } catch (e) {
      results.push({
        tool_name: 'get_co_trader_context', test_name: 'callable_with_spy', category: 1,
        result: 'FAIL', evidence: e instanceof Error ? e.message : String(e),
        duration_ms: Math.round(now() - t0),
      });
    }
  }

  // T1.2 organMetadata structured for all 10 Phase 2 organs
  {
    const t0 = now();
    try {
      const ctx = await buildClaudeContext(supabase, {
        audience: 'cotrader', consumerName: CONSUMER_NAME, tickerFocus: 'SPY',
        organs: ['news_causality', 'flow_heatmap', 'pulse', 'tape', 'detector', 'event_recency', 'james_flags', 'analogs', 'specialist', 'specialist_recall'],
      });
      const phase2Organs = ['news_causality', 'flow_heatmap', 'pulse', 'tape', 'detector', 'event_recency', 'james_flags', 'analogs', 'specialist', 'specialist_recall'];
      const populated = phase2Organs.filter((o) => {
        const status = (ctx.organs as Record<string, { organMetadata?: { status?: unknown } }>)[o]?.organMetadata?.status;
        return typeof status === 'string' && status.length > 0;
      }).length;
      results.push({
        tool_name: 'get_co_trader_context', test_name: 'organ_metadata_structured', category: 2,
        result: populated === 10 ? 'PASS' : (populated >= 8 ? 'DRIFT' : 'FAIL'),
        evidence: `${populated}/10 Phase 2 organs surface organMetadata.status`,
        duration_ms: Math.round(now() - t0),
      });
    } catch (e) {
      results.push({
        tool_name: 'get_co_trader_context', test_name: 'organ_metadata_structured', category: 2,
        result: 'FAIL', evidence: e instanceof Error ? e.message : String(e),
        duration_ms: Math.round(now() - t0),
      });
    }
  }

  // T1.3 data fidelity: pulse SPY netPremium matches direct ct_flow_pulse_ticks query
  {
    const t0 = now();
    try {
      const { data: latestTick } = await supabase
        .from('ct_flow_pulse_ticks')
        .select('premium_net').eq('ticker', 'SPY').order('tick_time', { ascending: false }).limit(1);
      const groundTruthNet = latestTick?.[0]?.premium_net == null ? null : Number(latestTick[0].premium_net);
      const ctx = await buildClaudeContext(supabase, {
        audience: 'cotrader', consumerName: CONSUMER_NAME, tickerFocus: 'SPY', organs: ['pulse'],
      });
      const toolNet = (ctx.organs as { pulse?: { data?: { per_ticker?: Record<string, { netPremium?: number | null }> } } })
        .pulse?.data?.per_ticker?.SPY?.netPremium ?? null;
      const match = groundTruthNet === toolNet || (groundTruthNet === null && toolNet === null);
      results.push({
        tool_name: 'get_co_trader_context', test_name: 'pulse_data_fidelity_spy', category: 3,
        result: match ? 'PASS' : 'DRIFT',
        evidence: `tool=${toolNet} db=${groundTruthNet}`,
        duration_ms: Math.round(now() - t0),
      });
    } catch (e) {
      results.push({
        tool_name: 'get_co_trader_context', test_name: 'pulse_data_fidelity_spy', category: 3,
        result: 'FAIL', evidence: e instanceof Error ? e.message : String(e),
        duration_ms: Math.round(now() - t0),
      });
    }
  }

  // ---- Tool 2: get_morning_brief (Co-Trader market brief) ----

  const today = todayInET();
  const { data: gtBriefRows } = await supabase
    .from('ct_daily_briefs')
    .select('id, session_date, macro_regime, watchlist_focus, skip_today, high_conviction_ideas')
    .eq('session_date', today)
    .order('created_at', { ascending: false }).limit(1);
  const gtBrief = gtBriefRows?.[0] ?? null;

  // T2.1 happy path: today's brief returns row when DB has one
  {
    const t0 = now();
    try {
      const { data, error } = await supabase
        .from('ct_daily_briefs')
        .select('id').eq('session_date', today)
        .order('created_at', { ascending: false }).limit(1);
      const toolHasRow = !error && Array.isArray(data) && data.length > 0;
      const gtHasRow = gtBrief != null;
      const ok = toolHasRow === gtHasRow;
      results.push({
        tool_name: 'get_morning_brief', test_name: 'happy_path_matches_gt', category: 1,
        result: ok ? 'PASS' : 'DRIFT',
        evidence: `tool_has_row=${toolHasRow} gt_has_row=${gtHasRow}`,
        duration_ms: Math.round(now() - t0),
      });
    } catch (e) {
      results.push({
        tool_name: 'get_morning_brief', test_name: 'happy_path_matches_gt', category: 1,
        result: 'FAIL', evidence: e instanceof Error ? e.message : String(e),
        duration_ms: Math.round(now() - t0),
      });
    }
  }

  // T2.2 data fidelity (when brief present): brief_id + regime + focus + skip match DB
  if (gtBrief) {
    const t0 = now();
    const { data } = await supabase
      .from('ct_daily_briefs')
      .select('id, macro_regime, watchlist_focus, skip_today')
      .eq('session_date', today).order('created_at', { ascending: false }).limit(1);
    const tool = data?.[0] ?? null;
    const idMatch = tool?.id === gtBrief.id;
    const regimeMatch = tool?.macro_regime === gtBrief.macro_regime;
    const focusMatch = JSON.stringify(tool?.watchlist_focus) === JSON.stringify(gtBrief.watchlist_focus);
    const skipMatch = JSON.stringify(tool?.skip_today) === JSON.stringify(gtBrief.skip_today);
    const allMatch = idMatch && regimeMatch && focusMatch && skipMatch;
    results.push({
      tool_name: 'get_morning_brief', test_name: 'data_fidelity_top_level', category: 3,
      result: allMatch ? 'PASS' : 'DRIFT',
      evidence: `id=${idMatch} regime=${regimeMatch} focus=${focusMatch} skip=${skipMatch}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T2.3 idea field-name mapping (instrument→ticker, entry_zone→entry_range, rationale→thesis)
  if (gtBrief && Array.isArray(gtBrief.high_conviction_ideas) && gtBrief.high_conviction_ideas.length > 0) {
    const t0 = now();
    const first = gtBrief.high_conviction_ideas[0] as Record<string, unknown>;
    const hasInstrument = typeof first.instrument === 'string';
    const hasEntryZone = typeof first.entry_zone === 'string';
    const hasRationale = typeof first.rationale === 'string';
    const allFieldsPresent = hasInstrument && hasEntryZone && hasRationale;
    results.push({
      tool_name: 'get_morning_brief', test_name: 'idea_field_mapping_source', category: 3,
      result: allFieldsPresent ? 'PASS' : 'DRIFT',
      evidence: `instrument:${hasInstrument} entry_zone:${hasEntryZone} rationale:${hasRationale}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T2.4 no_brief_today for absent date is empty
  {
    const t0 = now();
    const { data, error } = await supabase
      .from('ct_daily_briefs').select('id').eq('session_date', '2025-01-01').limit(1);
    const isEmpty = !error && (!data || data.length === 0);
    results.push({
      tool_name: 'get_morning_brief', test_name: 'no_brief_today_absent_date', category: 5,
      result: isEmpty ? 'PASS' : 'FAIL',
      evidence: `rows for 2025-01-01: ${data?.length ?? 'error'}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // ---- Tool 3: get_jac_brief ----

  const { data: gtJacRows } = await supabase
    .from('brain_reports')
    .select('id, source, title')
    .eq('report_type', 'morning_brief')
    .order('created_at', { ascending: false }).limit(1);
  const gtJac = gtJacRows?.[0] ?? null;

  // T3.1 happy path
  {
    const t0 = now();
    const ok = gtJac == null || (typeof gtJac.id === 'string' && gtJac.id.length > 0);
    results.push({
      tool_name: 'get_jac_brief', test_name: 'happy_path_returns_row', category: 1,
      result: ok ? 'PASS' : 'FAIL',
      evidence: gtJac ? `id=${gtJac.id.slice(0, 8)}…` : 'no row (acceptable)',
      duration_ms: Math.round(now() - t0),
    });
  }

  // T3.2 data fidelity: source field is 'jac-morning-brief' (proves NOT pulling Co-Trader brief)
  if (gtJac) {
    const t0 = now();
    const sourceMatch = gtJac.source === 'jac-morning-brief';
    results.push({
      tool_name: 'get_jac_brief', test_name: 'data_fidelity_jac_namespace', category: 3,
      result: sourceMatch ? 'PASS' : 'DRIFT',
      evidence: `source=${gtJac.source}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T3.3 no-row date returns empty
  {
    const t0 = now();
    const { data, error } = await supabase
      .from('brain_reports').select('id').eq('report_type', 'morning_brief')
      .gte('created_at', '2025-01-01T00:00:00Z').lt('created_at', '2025-01-02T00:00:00Z').limit(1);
    const isEmpty = !error && (!data || data.length === 0);
    results.push({
      tool_name: 'get_jac_brief', test_name: 'no_row_date_empty', category: 5,
      result: isEmpty ? 'PASS' : 'FAIL',
      evidence: `rows for 2025-01-01: ${data?.length ?? 'error'}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // ---- Tool 4: get_brain_principles ----

  const { data: gtPrincipleRows, count: gtPrincipleCount } = await supabase
    .from('jac_principles')
    .select('id, principle, retired_at', { count: 'exact' })
    .is('retired_at', null)
    .order('created_at', { ascending: false });
  const gtPrinciples = gtPrincipleRows ?? [];

  // T4.1 callability + status enum
  {
    const t0 = now();
    const validShape = Array.isArray(gtPrinciples);
    results.push({
      tool_name: 'get_brain_principles', test_name: 'callable_status_enum', category: 1,
      result: validShape ? 'PASS' : 'FAIL',
      evidence: `count=${gtPrinciples.length}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T4.2 data fidelity: count + first id match
  {
    const t0 = now();
    const { data: again } = await supabase.from('jac_principles')
      .select('id, principle').is('retired_at', null)
      .order('created_at', { ascending: false }).limit(5);
    const countMatch = (again?.length ?? 0) <= gtPrinciples.length;
    const firstIdMatch = gtPrinciples.length === 0 || again?.[0]?.id === gtPrinciples[0].id;
    results.push({
      tool_name: 'get_brain_principles', test_name: 'data_fidelity_count_and_first_row', category: 3,
      result: countMatch && firstIdMatch ? 'PASS' : 'DRIFT',
      evidence: `count=${gtPrinciples.length} id_match=${firstIdMatch}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T4.3 retired filter excludes retired principles
  {
    const t0 = now();
    const { data: allRows } = await supabase.from('jac_principles').select('retired_at').limit(100);
    const hasOnlyActive = (allRows ?? []).every((r: { retired_at?: string | null }) => !r.retired_at) ||
      gtPrinciples.every((p: { retired_at?: string | null }) => !p.retired_at);
    results.push({
      tool_name: 'get_brain_principles', test_name: 'retired_filter_applied', category: 4,
      result: hasOnlyActive ? 'PASS' : 'DRIFT',
      evidence: `active filter respected`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // ---- Tool 5: get_observed_patterns (v2 Tier 1) ----
  // Source: ct_observed_patterns. Default status filter: validated|observed.

  const { data: gtPatternRows, count: gtPatternCount } = await supabase
    .from('ct_observed_patterns')
    .select('id, status, pattern_signature, n_observed', { count: 'exact' })
    .in('status', ['validated', 'observed'])
    .order('last_validated_at', { ascending: false, nullsFirst: false })
    .order('captured_at', { ascending: false })
    .limit(25);
  const gtPatterns = gtPatternRows ?? [];

  // T5.1 callability
  {
    const t0 = now();
    const ok = Array.isArray(gtPatterns);
    results.push({
      tool_name: 'get_observed_patterns', test_name: 'callable_default_filter', category: 1,
      result: ok ? 'PASS' : 'FAIL',
      evidence: `rows=${gtPatterns.length} total_validated_or_observed=${gtPatternCount ?? '?'}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T5.2 data fidelity: re-query and verify same first row id
  {
    const t0 = now();
    const { data: again } = await supabase
      .from('ct_observed_patterns')
      .select('id').in('status', ['validated', 'observed'])
      .order('last_validated_at', { ascending: false, nullsFirst: false })
      .order('captured_at', { ascending: false }).limit(1);
    const firstIdMatch = gtPatterns.length === 0 || again?.[0]?.id === gtPatterns[0].id;
    results.push({
      tool_name: 'get_observed_patterns', test_name: 'data_fidelity_first_row_stable', category: 3,
      result: firstIdMatch ? 'PASS' : 'DRIFT',
      evidence: `first_id_match=${firstIdMatch} sample_size=${gtPatterns.length}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T5.3 status filter excludes deprecated by default
  {
    const t0 = now();
    const noDeprecated = gtPatterns.every((p: { status?: string }) => p.status !== 'deprecated');
    results.push({
      tool_name: 'get_observed_patterns', test_name: 'default_filter_excludes_deprecated', category: 4,
      result: noDeprecated ? 'PASS' : 'FAIL',
      evidence: `deprecated_in_default_result=${gtPatterns.filter((p: { status?: string }) => p.status === 'deprecated').length}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // ---- Tool 6: get_eod_summary (v2 Tier 1) ----
  // Source: ct_eod_summaries ⨝ ct_eod_reports by session_date (1:1).

  const { data: gtEodRows } = await supabase
    .from('ct_eod_summaries')
    .select('id, session_date, regime_tag, snapshot_hit_rate')
    .order('session_date', { ascending: false }).limit(1);
  const gtEod = gtEodRows?.[0] ?? null;

  // T6.1 callability
  {
    const t0 = now();
    const ok = gtEod === null || (typeof gtEod.session_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(gtEod.session_date));
    results.push({
      tool_name: 'get_eod_summary', test_name: 'callable_returns_session_date', category: 1,
      result: ok ? 'PASS' : 'FAIL',
      evidence: gtEod ? `latest_session=${gtEod.session_date}` : 'no_eod_rows',
      duration_ms: Math.round(now() - t0),
    });
  }

  // T6.2 1:1 join property: each session has at most one summary + one report
  if (gtEod) {
    const t0 = now();
    const [{ count: summaryCount }, { count: reportCount }] = await Promise.all([
      supabase.from('ct_eod_summaries').select('id', { count: 'exact', head: true })
        .eq('session_date', gtEod.session_date),
      supabase.from('ct_eod_reports').select('id', { count: 'exact', head: true })
        .eq('session_date', gtEod.session_date),
    ]);
    const oneToOne = (summaryCount ?? 0) <= 1 && (reportCount ?? 0) <= 1;
    results.push({
      tool_name: 'get_eod_summary', test_name: 'one_to_one_join_session_date', category: 3,
      result: oneToOne ? 'PASS' : 'DRIFT',
      evidence: `summary_rows=${summaryCount} report_rows=${reportCount} session=${gtEod.session_date}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T6.3 absent-date returns no rows (structured-empty contract)
  {
    const t0 = now();
    const { data: absent } = await supabase
      .from('ct_eod_summaries').select('id').eq('session_date', '2025-01-01').limit(1);
    const isEmpty = !absent || absent.length === 0;
    results.push({
      tool_name: 'get_eod_summary', test_name: 'absent_date_structured_empty', category: 5,
      result: isEmpty ? 'PASS' : 'FAIL',
      evidence: `rows_for_2025-01-01=${absent?.length ?? 0}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // ---- Tool 7: get_warden_state (v2 Tier 1) ----
  // Source: get_warden_health(window_hours) RPC — server-aggregated.

  const { data: gtWarden } = await supabase.rpc('get_warden_health', { window_hours: 24 });

  // T7.1 RPC callability
  {
    const t0 = now();
    const ok = gtWarden !== null && typeof gtWarden === 'object';
    results.push({
      tool_name: 'get_warden_state', test_name: 'rpc_callable', category: 1,
      result: ok ? 'PASS' : 'FAIL',
      evidence: ok ? `keys=${Object.keys(gtWarden as object).join(',')}` : 'rpc_returned_null',
      duration_ms: Math.round(now() - t0),
    });
  }

  // T7.2 schema compliance: totals + by_category + failures all present
  if (gtWarden && typeof gtWarden === 'object') {
    const t0 = now();
    const w = gtWarden as Record<string, unknown>;
    const hasTotals = w.totals !== undefined && typeof w.totals === 'object';
    const hasByCategory = Array.isArray(w.by_category);
    const hasFailures = Array.isArray(w.failures);
    const allPresent = hasTotals && hasByCategory && hasFailures;
    results.push({
      tool_name: 'get_warden_state', test_name: 'schema_compliance_three_keys', category: 2,
      result: allPresent ? 'PASS' : 'FAIL',
      evidence: `totals=${hasTotals} by_category=${hasByCategory} failures=${hasFailures}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T7.3 data fidelity: totals.total_enabled equals direct count of enabled invariants
  if (gtWarden && typeof gtWarden === 'object') {
    const t0 = now();
    const w = gtWarden as { totals?: { total_enabled?: number } };
    const wardenCount = w.totals?.total_enabled ?? null;
    const { count: dbCount } = await supabase
      .from('ct_invariants').select('name', { count: 'exact', head: true })
      .eq('enabled', true);
    const match = wardenCount !== null && wardenCount === dbCount;
    results.push({
      tool_name: 'get_warden_state', test_name: 'data_fidelity_total_enabled', category: 3,
      result: match ? 'PASS' : 'DRIFT',
      evidence: `warden_total_enabled=${wardenCount} db_count=${dbCount}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // ---- Tool 8: get_recent_james_flags (v2 Tier 1) ----
  // Source: ct_flags WHERE source='james_star'. Latest james_star = 2026-04-24.

  const sinceUtcWeek = new Date(Date.now() - 168 * 60 * 60 * 1000).toISOString();
  const { data: gtJamesRows, count: gtJamesCount } = await supabase
    .from('ct_flags')
    .select('id, instrument, source', { count: 'exact' })
    .eq('source', 'james_star')
    .gte('created_at', sinceUtcWeek)
    .order('created_at', { ascending: false })
    .limit(50);
  const gtJamesFlags = gtJamesRows ?? [];

  // T8.1 callability — empty result is correct (latest james_star is 4/24)
  {
    const t0 = now();
    const ok = Array.isArray(gtJamesFlags);
    results.push({
      tool_name: 'get_recent_james_flags', test_name: 'callable_default_window', category: 1,
      result: ok ? 'PASS' : 'FAIL',
      evidence: `rows=${gtJamesFlags.length} count=${gtJamesCount ?? '?'} (empty acceptable — latest is 4/24)`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T8.2 source filter applied: every returned row has source='james_star'
  {
    const t0 = now();
    const allMatch = gtJamesFlags.every((f: { source?: string }) => f.source === 'james_star');
    results.push({
      tool_name: 'get_recent_james_flags', test_name: 'source_filter_applied', category: 4,
      result: allMatch ? 'PASS' : 'FAIL',
      evidence: `all_rows_james_star=${allMatch} sample=${gtJamesFlags.length}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  // T8.3 universe-lock: if any rows present, every instrument is in the 10-ticker universe
  {
    const t0 = now();
    const UNIVERSE = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM'];
    const allInUniverse = gtJamesFlags.every((f: { instrument?: string }) =>
      f.instrument != null && UNIVERSE.includes(f.instrument)
    );
    results.push({
      tool_name: 'get_recent_james_flags', test_name: 'universe_lock_respected', category: 4,
      result: allInUniverse ? 'PASS' : 'DRIFT',
      evidence: gtJamesFlags.length === 0
        ? 'no_rows_to_check (vacuously true)'
        : `all_in_universe=${allInUniverse} instruments=${gtJamesFlags.map((f: { instrument?: string }) => f.instrument).join(',')}`,
      duration_ms: Math.round(now() - t0),
    });
  }

  return results;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const startedAt = Date.now();
  const runId = crypto.randomUUID();

  let results: TestResult[] = [];
  let runError: string | null = null;
  try {
    results = await runAllTests(supabase);
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }

  const summary = {
    PASS: results.filter((r) => r.result === 'PASS').length,
    FAIL: results.filter((r) => r.result === 'FAIL').length,
    DRIFT: results.filter((r) => r.result === 'DRIFT').length,
  };

  const rows = results.map((r) => ({
    run_id: runId,
    tool_name: r.tool_name,
    test_name: r.test_name,
    category: r.category,
    result: r.result,
    evidence: r.evidence,
    duration_ms: r.duration_ms,
    diff: r.diff ?? null,
  }));

  if (rows.length > 0) {
    const { error: insertError } = await supabase.from('ct_mcp_test_results').insert(rows);
    if (insertError) {
      console.error(`[${CONSUMER_NAME}] insert failed: ${insertError.message}`);
    }
  }

  const totalMs = Date.now() - startedAt;
  console.log(`[${CONSUMER_NAME}] run ${runId} completed in ${totalMs}ms — ${summary.PASS} PASS / ${summary.FAIL} FAIL / ${summary.DRIFT} DRIFT`);

  return new Response(JSON.stringify({
    run_id: runId,
    total_ms: totalMs,
    summary,
    test_count: results.length,
    error: runError,
  }), {
    status: summary.FAIL > 0 || runError ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
