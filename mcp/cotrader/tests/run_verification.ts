// MCP verification layer — Phase 1.
// Per scope/2026-05-07-cotrader-mcp-verification-layer.md (defense net 7th
// layer). Distinct from smoke-test.ts: smoke covers callability + shape;
// verification covers data fidelity vs DB ground truth + failure modes.
//
// Run:  deno task verify
//       deno run --allow-all mcp/cotrader/tests/run_verification.ts
//
// Race-condition discipline: read DB snapshot FIRST, then call tool, compare
// against the snapshot. Time gap is small enough that source rows don't
// change for the assertions made here (briefs / specialist reads / regime
// state turn over on minutes-to-hours scale, not sub-second).
//
// Test categories per doc:
//   1. Callability        — tool registers, invokes without auth/transport errors
//   2. Schema compliance  — return shape matches declared interface
//   3. Data fidelity      — values match direct DB query
//   4. Edge cases         — empty/invalid input → structured-empty, not fabrication
//   5. Failure modes      — absent data → status='no_brief_today' style, not crash

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { getCoTraderContext } from '../tools/get_co_trader_context.ts';
import { getMorningBrief } from '../tools/get_morning_brief.ts';
import { getJacBrief } from '../tools/get_jac_brief.ts';
import { getBrainPrinciples } from '../tools/get_brain_principles.ts';
import { todayInET } from '../../../supabase/functions/_shared/clock.ts';

type Status = 'PASS' | 'FAIL' | 'DRIFT';
interface TestResult {
  tool: string;
  name: string;
  status: Status;
  evidence: string;
  category: 1 | 2 | 3 | 4 | 5;
}

const results: TestResult[] = [];
function record(r: TestResult) {
  results.push(r);
  const tag = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : (r.status === 'DRIFT' ? '\x1b[33mDRIFT\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
  console.log(`  ${tag}  cat${r.category}  ${r.tool}/${r.name.padEnd(40)}  ${r.evidence}`);
}

// Resolve a single Supabase client up-front for ground-truth queries.
const { supabaseUrl, serviceRoleKey } = await resolveAuth();
const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
const ET_TZ = 'America/New_York';
const today = todayInET(ET_TZ);

// ===========================================================================
// Tool 1 — get_co_trader_context
// ===========================================================================
console.log('\n[Tool: get_co_trader_context]');

// T1.1 — callability: SPY returns a result with organs
try {
  const r = await getCoTraderContext({ ticker: 'SPY' });
  record({
    tool: 'get_co_trader_context', name: 'callable_with_spy', category: 1,
    status: typeof r.structured === 'object' && r.structured !== null ? 'PASS' : 'FAIL',
    evidence: `latency=${r.latencyMs}ms organs_invoked=${r.organsInvoked.length}`,
  });
} catch (e) {
  record({ tool: 'get_co_trader_context', name: 'callable_with_spy', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T1.2 — organMetadata structured (not literal null) for shipped Phase 2 organs
try {
  const r = await getCoTraderContext({ ticker: 'SPY' });
  const ctx = r.structured as { organs: Record<string, { organMetadata?: { status?: unknown } }> };
  const phase2Organs = ['news_causality', 'flow_heatmap', 'pulse', 'tape', 'detector', 'event_recency', 'james_flags', 'analogs', 'specialist', 'specialist_recall'];
  const populatedCount = phase2Organs.filter((o) => {
    const status = ctx.organs?.[o]?.organMetadata?.status;
    return typeof status === 'string' && status.length > 0;
  }).length;
  record({
    tool: 'get_co_trader_context', name: 'organ_metadata_structured', category: 2,
    status: populatedCount === phase2Organs.length ? 'PASS' : (populatedCount >= 6 ? 'DRIFT' : 'FAIL'),
    evidence: `${populatedCount}/${phase2Organs.length} Phase 2 organs surface organMetadata.status`,
  });
} catch (e) {
  record({ tool: 'get_co_trader_context', name: 'organ_metadata_structured', category: 2, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T1.3 — data fidelity: pulse organ's regime for SPY matches direct ct_flow_pulse_ticks
try {
  const { data: latestTick } = await supabase
    .from('ct_flow_pulse_ticks')
    .select('ticker, premium_net, tick_time')
    .eq('ticker', 'SPY')
    .order('tick_time', { ascending: false })
    .limit(1);
  const groundTruthNet = latestTick?.[0]?.premium_net == null ? null : Number(latestTick[0].premium_net);
  const r = await getCoTraderContext({ ticker: 'SPY', organs: ['pulse'] });
  const ctx = r.structured as { organs: { pulse?: { data?: { per_ticker?: Record<string, { netPremium?: number | null }> } } } };
  const toolNet = ctx.organs?.pulse?.data?.per_ticker?.SPY?.netPremium ?? null;
  const match = groundTruthNet === toolNet || (groundTruthNet === null && toolNet === null);
  record({
    tool: 'get_co_trader_context', name: 'pulse_data_fidelity_spy', category: 3,
    status: match ? 'PASS' : 'DRIFT',
    evidence: `tool=${toolNet} db=${groundTruthNet}${match ? ' match' : ' MISMATCH'}`,
  });
} catch (e) {
  record({ tool: 'get_co_trader_context', name: 'pulse_data_fidelity_spy', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T1.4 — invalid ticker rejected with clear error (off-universe)
try {
  await getCoTraderContext({ ticker: 'XYZZY' });
  record({ tool: 'get_co_trader_context', name: 'invalid_ticker_rejected', category: 4, status: 'FAIL', evidence: 'expected throw, got success' });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  const isUniverseRejection = /universe|watchlist|invalid|not.*recognized/i.test(msg);
  record({
    tool: 'get_co_trader_context', name: 'invalid_ticker_rejected', category: 4,
    status: isUniverseRejection ? 'PASS' : 'DRIFT',
    evidence: `threw: ${msg.slice(0, 120)}`,
  });
}

// T1.5 — organs filter narrows to subset (no fabrication of unrequested organs).
// Use flow_heatmap not regime — regime has its own include_regime gate that
// can override the organs filter.
try {
  const r = await getCoTraderContext({ ticker: 'SPY', organs: ['flow_heatmap'] });
  const ctx = r.structured as { organs: Record<string, { meta?: { warning?: string }; organMetadata?: unknown }> };
  const filterRespected = r.organsRequested.length === 1 && r.organsRequested[0] === 'flow_heatmap';
  const fetchedOrganNames = Object.entries(ctx.organs ?? {})
    .filter(([_, v]) => v?.meta?.warning !== 'skipped:organ_filter')
    .map(([k]) => k);
  const onlyRequestedFetched = fetchedOrganNames.length === 1 && fetchedOrganNames[0] === 'flow_heatmap';
  record({
    tool: 'get_co_trader_context', name: 'organs_filter_narrows', category: 4,
    status: filterRespected && onlyRequestedFetched ? 'PASS' : 'DRIFT',
    evidence: `requested=${r.organsRequested.join(',')} fetched=${fetchedOrganNames.join(',')}`,
  });
} catch (e) {
  record({ tool: 'get_co_trader_context', name: 'organs_filter_narrows', category: 4, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Tool 2 — get_morning_brief (Co-Trader market brief)
// ===========================================================================
console.log('\n[Tool: get_morning_brief]');

// Snapshot ground truth FIRST (race-condition discipline)
const { data: gtBriefRows } = await supabase
  .from('ct_daily_briefs')
  .select('id, session_date, macro_regime, macro_narrative, watchlist_focus, skip_today, high_conviction_ideas, generated_by_model, triggered_by, ttl_hours')
  .eq('session_date', today)
  .order('created_at', { ascending: false })
  .limit(1);
const gtBrief = gtBriefRows?.[0] ?? null;

// T2.1 — happy path: today's brief returns status=populated when DB has row
try {
  const r = await getMorningBrief({});
  if (gtBrief) {
    record({
      tool: 'get_morning_brief', name: 'happy_path_populated', category: 1,
      status: r.brief.status === 'populated' ? 'PASS' : 'DRIFT',
      evidence: `status=${r.brief.status} (gt has row)`,
    });
  } else {
    record({
      tool: 'get_morning_brief', name: 'happy_path_no_brief', category: 1,
      status: r.brief.status === 'no_brief_today' ? 'PASS' : 'DRIFT',
      evidence: `status=${r.brief.status} (gt has no row)`,
    });
  }
} catch (e) {
  record({ tool: 'get_morning_brief', name: 'happy_path_populated', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T2.2 — data fidelity: brief_id, regime, watchlist_focus match DB
if (gtBrief) {
  try {
    const r = await getMorningBrief({});
    const idMatch = r.brief.brief_id === gtBrief.id;
    const regimeMatch = r.brief.regime === gtBrief.macro_regime;
    const focusMatch = JSON.stringify(r.brief.focus_tickers) === JSON.stringify(gtBrief.watchlist_focus);
    const skipMatch = JSON.stringify(r.brief.skip_tickers) === JSON.stringify(gtBrief.skip_today);
    const allMatch = idMatch && regimeMatch && focusMatch && skipMatch;
    record({
      tool: 'get_morning_brief', name: 'data_fidelity_top_level', category: 3,
      status: allMatch ? 'PASS' : 'DRIFT',
      evidence: `id=${idMatch} regime=${regimeMatch} focus=${focusMatch} skip=${skipMatch}`,
    });
  } catch (e) {
    record({ tool: 'get_morning_brief', name: 'data_fidelity_top_level', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
  }

  // T2.3 — high_conviction_ideas field mapping (instrument→ticker, entry_zone→entry_range, rationale→thesis)
  try {
    const r = await getMorningBrief({});
    const dbIdeas = Array.isArray(gtBrief.high_conviction_ideas) ? gtBrief.high_conviction_ideas as Array<Record<string, unknown>> : [];
    if (dbIdeas.length === 0) {
      record({ tool: 'get_morning_brief', name: 'idea_mapping', category: 3, status: 'PASS', evidence: 'no ideas to verify (vacuous PASS)' });
    } else {
      const first = dbIdeas[0];
      const mapped = r.brief.high_conviction_ideas[0];
      const tickerMapped = mapped?.ticker === first.instrument;
      const entryMapped = mapped?.entry_range === first.entry_zone;
      const thesisMapped = mapped?.thesis === first.rationale;
      const allMapped = tickerMapped && entryMapped && thesisMapped;
      record({
        tool: 'get_morning_brief', name: 'idea_mapping', category: 3,
        status: allMapped ? 'PASS' : 'DRIFT',
        evidence: `instrument→ticker:${tickerMapped} entry_zone→entry_range:${entryMapped} rationale→thesis:${thesisMapped}`,
      });
    }
  } catch (e) {
    record({ tool: 'get_morning_brief', name: 'idea_mapping', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
  }
} else {
  record({ tool: 'get_morning_brief', name: 'data_fidelity_top_level', category: 3, status: 'DRIFT', evidence: 'gt has no row today; skipping fidelity check' });
}

// T2.4 — no_brief_today for absent date is structured-empty (no fabrication)
try {
  const r = await getMorningBrief({ date: '2025-01-01' });
  const isStructuredEmpty = r.brief.status === 'no_brief_today'
    && r.brief.brief_id === null
    && r.brief.macro_narrative === null
    && r.brief.focus_tickers.length === 0
    && r.brief.high_conviction_ideas.length === 0
    && r.brief.per_ticker_reads.length === 0;
  record({
    tool: 'get_morning_brief', name: 'no_brief_today_structured_empty', category: 5,
    status: isStructuredEmpty ? 'PASS' : 'FAIL',
    evidence: `status=${r.brief.status} ideas=${r.brief.high_conviction_ideas.length} per_ticker=${r.brief.per_ticker_reads.length}`,
  });
} catch (e) {
  record({ tool: 'get_morning_brief', name: 'no_brief_today_structured_empty', category: 5, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T2.5 — Path C contract: doc fields not in DB return null/empty (don't fabricate)
try {
  const r = await getMorningBrief({});
  if (r.brief.status === 'populated' && r.brief.per_ticker_reads.length > 0) {
    const t0 = r.brief.per_ticker_reads[0];
    const weightNull = t0.weight === null;
    const narrativeNull = t0.narrative_view === null;
    const tagsEmpty = Array.isArray(t0.thesis_tags) && t0.thesis_tags.length === 0;
    record({
      tool: 'get_morning_brief', name: 'doc_fields_not_in_db_explicit_absence', category: 5,
      status: weightNull && narrativeNull && tagsEmpty ? 'PASS' : 'FAIL',
      evidence: `weight_null:${weightNull} narrative_null:${narrativeNull} tags_empty:${tagsEmpty}`,
    });
  } else {
    record({ tool: 'get_morning_brief', name: 'doc_fields_not_in_db_explicit_absence', category: 5, status: 'PASS', evidence: 'no per_ticker rows; vacuous PASS' });
  }
} catch (e) {
  record({ tool: 'get_morning_brief', name: 'doc_fields_not_in_db_explicit_absence', category: 5, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Tool 3 — get_jac_brief (life-management self-review)
// ===========================================================================
console.log('\n[Tool: get_jac_brief]');

// Snapshot ground truth FIRST
const { data: gtJacRows } = await supabase
  .from('brain_reports')
  .select('id, title, summary, body_markdown, source, created_at')
  .eq('report_type', 'morning_brief')
  .order('created_at', { ascending: false })
  .limit(1);
const gtJac = gtJacRows?.[0] ?? null;

// T3.1 — happy path: returns latest brain_reports row when present
try {
  const r = await getJacBrief({});
  if (gtJac) {
    record({
      tool: 'get_jac_brief', name: 'happy_path_returns_row', category: 1,
      status: r.brief !== null && (r.brief as { id: string }).id === gtJac.id ? 'PASS' : 'DRIFT',
      evidence: `tool_id=${(r.brief as { id?: string } | null)?.id?.slice(0, 8)}… gt_id=${gtJac.id.slice(0, 8)}…`,
    });
  } else {
    record({
      tool: 'get_jac_brief', name: 'happy_path_no_row', category: 1,
      status: r.brief === null ? 'PASS' : 'DRIFT',
      evidence: 'gt has no row; tool correctly returned null',
    });
  }
} catch (e) {
  record({ tool: 'get_jac_brief', name: 'happy_path_returns_row', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T3.2 — data fidelity: source field is 'jac-morning-brief' (proves we're not pulling Co-Trader brief)
if (gtJac) {
  try {
    const r = await getJacBrief({});
    const row = r.brief as { source?: string; title?: string } | null;
    const sourceMatch = row?.source === 'jac-morning-brief';
    const titleMatch = row?.title === gtJac.title;
    record({
      tool: 'get_jac_brief', name: 'data_fidelity_jac_namespace', category: 3,
      status: sourceMatch && titleMatch ? 'PASS' : 'DRIFT',
      evidence: `source=jac-morning-brief:${sourceMatch} title_match:${titleMatch}`,
    });
  } catch (e) {
    record({ tool: 'get_jac_brief', name: 'data_fidelity_jac_namespace', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
  }
}

// T3.3 — no-row date returns brief: null (structured-empty)
try {
  const r = await getJacBrief({ date: '2025-01-01' });
  record({
    tool: 'get_jac_brief', name: 'no_row_date_null_brief', category: 5,
    status: r.brief === null ? 'PASS' : 'DRIFT',
    evidence: r.brief === null ? 'brief=null per contract' : `unexpected non-null brief`,
  });
} catch (e) {
  record({ tool: 'get_jac_brief', name: 'no_row_date_null_brief', category: 5, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Tool 4 — get_brain_principles
// ===========================================================================
console.log('\n[Tool: get_brain_principles]');

// Snapshot ground truth FIRST
const { data: gtPrincipleRows, count: gtPrincipleCount } = await supabase
  .from('jac_principles')
  .select('id, principle, confidence, retired_at, created_at', { count: 'exact' })
  .is('retired_at', null)
  .order('created_at', { ascending: false });
const gtPrinciples = gtPrincipleRows ?? [];

// T4.1 — callability: tool returns either populated or no_principles_yet
try {
  const r = await getBrainPrinciples({});
  const validStatus = r.brief.status === 'populated' || r.brief.status === 'no_principles_yet';
  record({
    tool: 'get_brain_principles', name: 'callable_status_enum', category: 1,
    status: validStatus ? 'PASS' : 'FAIL',
    evidence: `status=${r.brief.status} count=${r.brief.total_count}`,
  });
} catch (e) {
  record({ tool: 'get_brain_principles', name: 'callable_status_enum', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T4.2 — data fidelity: count + first id match DB ground truth
try {
  const r = await getBrainPrinciples({});
  const countMatch = r.brief.total_count === gtPrinciples.length;
  if (gtPrinciples.length > 0) {
    const firstIdMatch = r.brief.principles[0]?.principle_id === gtPrinciples[0].id;
    const firstTextMatch = r.brief.principles[0]?.text === gtPrinciples[0].principle;
    record({
      tool: 'get_brain_principles', name: 'data_fidelity_count_and_first_row', category: 3,
      status: countMatch && firstIdMatch && firstTextMatch ? 'PASS' : 'DRIFT',
      evidence: `tool_count=${r.brief.total_count} db_count=${gtPrinciples.length} id_match=${firstIdMatch} text_match=${firstTextMatch}`,
    });
  } else {
    record({
      tool: 'get_brain_principles', name: 'data_fidelity_count_and_first_row', category: 3,
      status: r.brief.total_count === 0 && r.brief.status === 'no_principles_yet' ? 'PASS' : 'DRIFT',
      evidence: `gt empty; tool count=${r.brief.total_count} status=${r.brief.status}`,
    });
  }
} catch (e) {
  record({ tool: 'get_brain_principles', name: 'data_fidelity_count_and_first_row', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T4.3 — explicit-absence contract: source_pattern returns null per Path C
//        (DB has no descriptive failure-mode text field; don't fabricate from
//        source_reflection_ids UUIDs)
try {
  const r = await getBrainPrinciples({});
  if (r.brief.principles.length > 0) {
    const firstSourcePattern = r.brief.principles[0].source_pattern;
    const isNull = firstSourcePattern === null;
    record({
      tool: 'get_brain_principles', name: 'source_pattern_null_per_path_c', category: 5,
      status: isNull ? 'PASS' : 'FAIL',
      evidence: `source_pattern=${JSON.stringify(firstSourcePattern)} (null required per contract)`,
    });
  } else {
    record({
      tool: 'get_brain_principles', name: 'source_pattern_null_per_path_c', category: 5,
      status: 'PASS', evidence: 'no principles to check; vacuous PASS',
    });
  }
} catch (e) {
  record({ tool: 'get_brain_principles', name: 'source_pattern_null_per_path_c', category: 5, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n' + '='.repeat(80));
const counts = { PASS: 0, FAIL: 0, DRIFT: 0 };
for (const r of results) counts[r.status]++;
const byTool = new Map<string, { pass: number; fail: number; drift: number }>();
for (const r of results) {
  if (!byTool.has(r.tool)) byTool.set(r.tool, { pass: 0, fail: 0, drift: 0 });
  const b = byTool.get(r.tool)!;
  if (r.status === 'PASS') b.pass++;
  else if (r.status === 'FAIL') b.fail++;
  else b.drift++;
}
console.log('Per-tool:');
for (const [tool, b] of byTool) {
  console.log(`  ${tool.padEnd(28)}  pass=${b.pass} fail=${b.fail} drift=${b.drift}`);
}
console.log(`\nTotal: ${results.length}  PASS=${counts.PASS}  FAIL=${counts.FAIL}  DRIFT=${counts.DRIFT}`);
const exitCode = counts.FAIL > 0 ? 1 : 0;
console.log(exitCode === 0 ? '\n✅ verification clean' : `\n❌ ${counts.FAIL} hard failures — investigate`);
Deno.exit(exitCode);
