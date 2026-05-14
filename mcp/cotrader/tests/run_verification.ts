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
import { getObservedPatterns } from '../tools/get_observed_patterns.ts';
import { getEodSummary } from '../tools/get_eod_summary.ts';
import { getWardenState } from '../tools/get_warden_state.ts';
import { getRecentJamesFlags } from '../tools/get_recent_james_flags.ts';
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

// T2.6 — canonical-row semantics: when multiple rows exist for one
// session_date, returns the row with MAX(brief_version) and reports
// supersededCount in meta. Mirrors Ship 2's useMorningBrief.ts UI rule;
// must NOT diverge (cascade #48 family — bridge surface used a different
// canonical rule than the UI before Ship 5). Inserts two ephemeral rows
// at an out-of-range session_date, asserts canonical selection, cleans up.
try {
  const TEST_DATE = '2099-01-01'; // out of any real session-date range
  // Clean any stale test rows from a previous failed run
  await supabase.from('ct_daily_briefs').delete().eq('session_date', TEST_DATE);

  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  // v1 first — created_at older. Then v2 — created_at newer (matches Ship 2
  // chain semantics). The test passes if the tool returns v2's id and
  // supersededCount=1. If it ordered by created_at it would coincidentally
  // also return v2's id — so the test also asserts v1 with v2 having an
  // OLDER created_at (forces the disagreement).
  const olderTs = new Date(Date.now() - 5000).toISOString();
  const newerTs = new Date().toISOString();
  // v1 with NEWER timestamp, v2 with OLDER timestamp → forces canonical to
  // depend on brief_version, not created_at. If the tool reverted to the
  // pre-Ship-5 created_at ordering, it would return v1 and the test fails.
  const { data: v1Insert } = await supabase.from('ct_daily_briefs').insert({
    session_date: TEST_DATE,
    brief_version: 1,
    triggered_by: 'manual',
    macro_narrative: 'T2.6-canonical-test-v1',
    per_ticker: [],
    convergent_view: 'T2.6',
    expires_at: expiresAt,
    generated_by_model: 'verification-test',
    created_at: newerTs,
  }).select('id').single();
  const { data: v2Insert } = await supabase.from('ct_daily_briefs').insert({
    session_date: TEST_DATE,
    brief_version: 2,
    supersedes_id: v1Insert?.id ?? null,
    triggered_by: 'manual',
    macro_narrative: 'T2.6-canonical-test-v2',
    per_ticker: [],
    convergent_view: 'T2.6',
    expires_at: expiresAt,
    generated_by_model: 'verification-test',
    created_at: olderTs,
  }).select('id').single();

  const r = await getMorningBrief({ date: TEST_DATE });
  const returnedV2 = r.brief.brief_id === v2Insert?.id;
  const supersededCorrect = r.meta.supersededCount === 1;
  record({
    tool: 'get_morning_brief',
    name: 'canonical_row_max_brief_version',
    category: 5,
    status: returnedV2 && supersededCorrect ? 'PASS' : 'FAIL',
    evidence: `returnedV2:${returnedV2} returnedId:${r.brief.brief_id} expectedId:${v2Insert?.id} supersededCount:${r.meta.supersededCount} (expected 1)`,
  });

  // Cleanup
  await supabase.from('ct_daily_briefs').delete().eq('session_date', TEST_DATE);
} catch (e) {
  record({
    tool: 'get_morning_brief',
    name: 'canonical_row_max_brief_version',
    category: 5,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
}

// T2.7 — Ship 11 of Bundle 4: triggered_by + urgency projected on MorningBriefResponse.
// Forensic verification surface — trading-Claude needs to see whether canonical
// is breaking_news vs scheduled / urgency high vs normal, not just the
// scheduled-boolean derived in pre-Ship-11 projection.
try {
  const r = await getMorningBrief({});
  if (r.brief.status === 'populated') {
    const hasTriggeredBy = 'triggered_by' in r.brief && typeof r.brief.triggered_by === 'string';
    const hasUrgency = 'urgency' in r.brief && typeof r.brief.urgency === 'string';
    record({
      tool: 'get_morning_brief',
      name: 'triggered_by_and_urgency_projected',
      category: 3,
      status: hasTriggeredBy && hasUrgency ? 'PASS' : 'FAIL',
      evidence: `triggered_by:${r.brief.triggered_by} urgency:${r.brief.urgency}`,
    });
  } else {
    record({
      tool: 'get_morning_brief',
      name: 'triggered_by_and_urgency_projected',
      category: 3,
      status: 'DRIFT',
      evidence: 'no brief today; cannot verify field projection',
    });
  }
} catch (e) {
  record({
    tool: 'get_morning_brief',
    name: 'triggered_by_and_urgency_projected',
    category: 3,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
}

// T2.8 — Ship 11: accuracy_score + accuracy_notes projected. Ship 6's bridge
// populates the CANONICAL row only (the row whose id matches
// ct_eod_reports.morning_brief_id). Newer post-bridge rebriefs (afternoon
// breaking_news) don't get the score until next-day's bridge run. The test
// iterates dates DESC and picks the FIRST one where the CURRENT canonical
// (max brief_version) has accuracy_score populated — typically yesterday
// when today's afternoon rebriefs have moved canonical past the bridged row.
try {
  // Find dates with ANY accuracy_score-populated row, DESC
  const { data: candidates } = await supabase
    .from('ct_daily_briefs')
    .select('session_date')
    .not('accuracy_score', 'is', null)
    .order('session_date', { ascending: false })
    .limit(10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dateList = ((candidates as any[] | null) || []).map((r) => r.session_date as string);
  const uniqueDates = Array.from(new Set(dateList));

  let result: { date: string; score: unknown; notes: unknown } | null = null;
  for (const d of uniqueDates) {
    const r = await getMorningBrief({ date: d });
    if (r.brief.status === 'populated' && typeof r.brief.accuracy_score === 'number'
        && typeof r.brief.accuracy_notes === 'string' && r.brief.accuracy_notes.length > 0) {
      result = { date: d, score: r.brief.accuracy_score, notes: r.brief.accuracy_notes };
      break;
    }
  }

  if (!result) {
    record({
      tool: 'get_morning_brief',
      name: 'accuracy_score_and_notes_projected',
      category: 3,
      status: 'DRIFT',
      evidence: `no date had canonical-row with populated accuracy_score; checked ${uniqueDates.length} candidates`,
    });
  } else {
    record({
      tool: 'get_morning_brief',
      name: 'accuracy_score_and_notes_projected',
      category: 3,
      status: 'PASS',
      evidence: `date:${result.date} score:${result.score} notes_len:${(result.notes as string).length}`,
    });
  }
} catch (e) {
  record({
    tool: 'get_morning_brief',
    name: 'accuracy_score_and_notes_projected',
    category: 3,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
}

// T1.5 — Ship 11: get_co_trader_context specialist_recall organ projects
// unflagged_mode + per-read similarity_score on semantic-recall analogs.
// Note: tool returns { structured, ... }; organ data lives at
// structured.organs.specialist_recall.data — NOT directly on the response.
try {
  const r = await getCoTraderContext({ ticker: 'NVDA', organs: ['specialist_recall'] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recall = (r as any).structured?.organs?.specialist_recall?.data;
  const mode = recall?.unflagged_mode;
  const validMode = mode === 'semantic' || mode === 'chronological_fallback' || mode === 'no_history';
  // Check for similarity_score on unflagged reads (semantic path only — chronological
  // fallback leaves it null; we verify the field is PRESENT not necessarily populated).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unflaggedReads = ((recall?.reads as any[]) || []).filter((x) => x.flagged === false);
  const hasFieldOnAtLeastOne = unflaggedReads.length === 0
    ? true // vacuous — no unflagged reads to check
    : unflaggedReads.some((x) => 'similarity_score' in x);
  // Under semantic mode, at least one unflagged should have a numeric similarity_score
  const semanticEvidence = mode === 'semantic' && unflaggedReads.length > 0
    ? unflaggedReads.some((x) => typeof x.similarity_score === 'number')
    : true; // chronological_fallback or empty — null is correct, vacuous pass
  record({
    tool: 'get_co_trader_context',
    name: 'specialist_recall_unflagged_mode_and_similarity_projected',
    category: 3,
    status: validMode && hasFieldOnAtLeastOne && semanticEvidence ? 'PASS' : 'FAIL',
    evidence: `mode:${mode} unflagged_count:${unflaggedReads.length} sim_field_present:${hasFieldOnAtLeastOne} semantic_has_numeric_sim:${semanticEvidence}`,
  });
} catch (e) {
  record({
    tool: 'get_co_trader_context',
    name: 'specialist_recall_unflagged_mode_and_similarity_projected',
    category: 3,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
}

// T1.6 — Ship 13 of Bundle 5: get_co_trader_context specialist_recall organ
// projects unflagged_mode at the organMetadata layer (NOT just data layer).
// T1.5 checks data.unflagged_mode; T1.6 checks organMetadata.unflagged_mode.
// Trading-Claude reads organMetadata first as the canonical organ-state surface,
// so the field must be present there for the captain-bridge contract to be
// complete. Snake_case per codebase data-layer convention (matches as_of,
// source, window, status siblings).
try {
  const r = await getCoTraderContext({ ticker: 'NVDA', organs: ['specialist_recall'] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (r as any).structured?.organs?.specialist_recall?.organMetadata;
  const mode = meta?.unflagged_mode;
  const validMode = mode === 'semantic' || mode === 'chronological_fallback' || mode === 'no_history';
  record({
    tool: 'get_co_trader_context',
    name: 'specialist_recall_organMetadata_unflagged_mode',
    category: 2,
    status: validMode ? 'PASS' : 'FAIL',
    evidence: `organMetadata.unflagged_mode=${mode ?? 'MISSING'} (expected: semantic | chronological_fallback | no_history)`,
  });
} catch (e) {
  record({
    tool: 'get_co_trader_context',
    name: 'specialist_recall_organMetadata_unflagged_mode',
    category: 2,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
}

// T2.9 — Ship 13: brief_version projected on MorningBriefResponse + integer ≥1
// on populated rows. Ship 2's race-fence semantics mean canonical-row pick is
// MAX(brief_version); brief_version was selected by Ship 5 but never projected
// on the brief surface until Ship 13.
try {
  const r = await getMorningBrief({});
  if (r.brief.status === 'populated') {
    const v = r.brief.brief_version;
    const isIntGte1 = typeof v === 'number' && Number.isInteger(v) && v >= 1;
    record({
      tool: 'get_morning_brief',
      name: 'brief_version_projected',
      category: 3,
      status: isIntGte1 ? 'PASS' : 'FAIL',
      evidence: `brief_version=${v} (expected: integer ≥1)`,
    });
  } else {
    record({
      tool: 'get_morning_brief',
      name: 'brief_version_projected',
      category: 3,
      status: 'DRIFT',
      evidence: 'no brief today; cannot verify field projection',
    });
  }
} catch (e) {
  record({
    tool: 'get_morning_brief',
    name: 'brief_version_projected',
    category: 3,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
}

// T2.10 — Ship 13: supersedes_id projected on MorningBriefResponse. UUID
// string for v2+ rebriefs (chain back to v1); null for v1 rows and
// no_brief_today. Validates the supersession chain is reconstructible
// from a single get_morning_brief call.
try {
  const r = await getMorningBrief({});
  if (r.brief.status === 'populated') {
    const s = r.brief.supersedes_id;
    const isUuid = typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const isNull = s === null;
    record({
      tool: 'get_morning_brief',
      name: 'supersedes_id_projected',
      category: 3,
      status: isUuid || isNull ? 'PASS' : 'FAIL',
      evidence: `supersedes_id=${s === null ? 'null' : s} (expected: UUID string or null)`,
    });
  } else {
    record({
      tool: 'get_morning_brief',
      name: 'supersedes_id_projected',
      category: 3,
      status: 'DRIFT',
      evidence: 'no brief today; cannot verify field projection',
    });
  }
} catch (e) {
  record({
    tool: 'get_morning_brief',
    name: 'supersedes_id_projected',
    category: 3,
    status: 'FAIL',
    evidence: e instanceof Error ? e.message : String(e),
  });
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
// Tool 5 — get_observed_patterns
// ===========================================================================
console.log('\n[Tool: get_observed_patterns]');

// T5.1 — callability with default filters
try {
  const r = await getObservedPatterns({});
  record({
    tool: 'get_observed_patterns', name: 'callable_default_filter', category: 1,
    status: Array.isArray(r.patterns) ? 'PASS' : 'FAIL',
    evidence: `rows=${r.patterns.length} latency=${r.meta.latencyMs}ms warnings=${r.meta.warnings.length}`,
  });
} catch (e) {
  record({ tool: 'get_observed_patterns', name: 'callable_default_filter', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T5.2 — data fidelity: tool result first id matches direct DB query first id
try {
  const r = await getObservedPatterns({ limit: 5 });
  const { data } = await supabase
    .from('ct_observed_patterns')
    .select('id').in('status', ['validated', 'observed'])
    .order('last_validated_at', { ascending: false, nullsFirst: false })
    .order('captured_at', { ascending: false }).limit(1);
  const dbFirstId = data?.[0]?.id ?? null;
  const toolFirstId = r.patterns[0]?.id ?? null;
  const match = (toolFirstId === dbFirstId) || (toolFirstId === null && dbFirstId === null);
  record({
    tool: 'get_observed_patterns', name: 'data_fidelity_first_row', category: 3,
    status: match ? 'PASS' : 'DRIFT',
    evidence: `tool_id=${toolFirstId} db_id=${dbFirstId}`,
  });
} catch (e) {
  record({ tool: 'get_observed_patterns', name: 'data_fidelity_first_row', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T5.3 — default filter excludes deprecated
try {
  const r = await getObservedPatterns({});
  const noDeprecated = r.patterns.every((p) => p.status !== 'deprecated');
  record({
    tool: 'get_observed_patterns', name: 'default_filter_excludes_deprecated', category: 4,
    status: noDeprecated ? 'PASS' : 'FAIL',
    evidence: `applied_status=${r.meta.appliedFilters.status.join(',')} deprecated_in_result=${r.patterns.filter((p) => p.status === 'deprecated').length}`,
  });
} catch (e) {
  record({ tool: 'get_observed_patterns', name: 'default_filter_excludes_deprecated', category: 4, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Tool 6 — get_eod_summary
// ===========================================================================
console.log('\n[Tool: get_eod_summary]');

// T6.1 — callability with default (most-recent-available) date
try {
  const r = await getEodSummary({});
  const ok = typeof r.meta.requestedSessionDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.meta.requestedSessionDate);
  record({
    tool: 'get_eod_summary', name: 'callable_default_session', category: 1,
    status: ok ? 'PASS' : 'FAIL',
    evidence: `session=${r.meta.requestedSessionDate} summary_found=${r.meta.summaryRowFound} report_found=${r.meta.reportRowFound}`,
  });
} catch (e) {
  record({ tool: 'get_eod_summary', name: 'callable_default_session', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T6.2 — 1:1 join: when summary present, no >1 row from either table for that session
try {
  const r = await getEodSummary({});
  if (r.meta.summaryRowFound) {
    const session = r.meta.requestedSessionDate;
    const [{ count: sCount }, { count: rCount }] = await Promise.all([
      supabase.from('ct_eod_summaries').select('id', { count: 'exact', head: true }).eq('session_date', session),
      supabase.from('ct_eod_reports').select('id', { count: 'exact', head: true }).eq('session_date', session),
    ]);
    const oneToOne = (sCount ?? 0) <= 1 && (rCount ?? 0) <= 1;
    record({
      tool: 'get_eod_summary', name: 'one_to_one_join', category: 3,
      status: oneToOne ? 'PASS' : 'DRIFT',
      evidence: `session=${session} summary_rows=${sCount} report_rows=${rCount}`,
    });
  } else {
    record({
      tool: 'get_eod_summary', name: 'one_to_one_join', category: 3,
      status: 'PASS', evidence: 'no summary today; vacuous PASS',
    });
  }
} catch (e) {
  record({ tool: 'get_eod_summary', name: 'one_to_one_join', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T6.3 — absent date: payload=null + warning, no fabrication
try {
  const r = await getEodSummary({ date: '2025-01-01' });
  const isStructuredEmpty = r.payload === null && r.meta.summaryRowFound === false && r.meta.reportRowFound === false;
  record({
    tool: 'get_eod_summary', name: 'absent_date_structured_empty', category: 5,
    status: isStructuredEmpty ? 'PASS' : 'FAIL',
    evidence: `payload=${r.payload === null ? 'null' : 'present'} summary_found=${r.meta.summaryRowFound} report_found=${r.meta.reportRowFound}`,
  });
} catch (e) {
  record({ tool: 'get_eod_summary', name: 'absent_date_structured_empty', category: 5, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Tool 7 — get_warden_state
// ===========================================================================
console.log('\n[Tool: get_warden_state]');

// T7.1 — RPC callability
try {
  const r = await getWardenState({});
  record({
    tool: 'get_warden_state', name: 'rpc_callable', category: 1,
    status: r.warden !== null ? 'PASS' : 'FAIL',
    evidence: `latency=${r.meta.latencyMs}ms failure_count=${r.meta.failureCount}`,
  });
} catch (e) {
  record({ tool: 'get_warden_state', name: 'rpc_callable', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T7.2 — schema compliance: totals + by_category + failures all present
try {
  const r = await getWardenState({});
  const w = r.warden as Record<string, unknown> | null;
  const hasAll = w !== null &&
    typeof w.totals === 'object' &&
    Array.isArray(w.by_category) &&
    Array.isArray(w.failures);
  record({
    tool: 'get_warden_state', name: 'schema_compliance_three_keys', category: 2,
    status: hasAll ? 'PASS' : 'FAIL',
    evidence: w ? `keys=${Object.keys(w).join(',')}` : 'warden=null',
  });
} catch (e) {
  record({ tool: 'get_warden_state', name: 'schema_compliance_three_keys', category: 2, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T7.3 — data fidelity: totals.total_enabled equals direct count of enabled invariants
try {
  const r = await getWardenState({});
  const w = r.warden as { totals?: { total_enabled?: number } } | null;
  const wardenCount = w?.totals?.total_enabled ?? null;
  const { count: dbCount } = await supabase
    .from('ct_invariants').select('name', { count: 'exact', head: true })
    .eq('enabled', true);
  const match = wardenCount !== null && wardenCount === dbCount;
  record({
    tool: 'get_warden_state', name: 'data_fidelity_total_enabled', category: 3,
    status: match ? 'PASS' : 'DRIFT',
    evidence: `warden=${wardenCount} db=${dbCount}`,
  });
} catch (e) {
  record({ tool: 'get_warden_state', name: 'data_fidelity_total_enabled', category: 3, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// ===========================================================================
// Tool 8 — get_recent_james_flags
// ===========================================================================
console.log('\n[Tool: get_recent_james_flags]');

// T8.1 — callability with default 24h window (empty result is correct — latest james_star is 4/24)
try {
  const r = await getRecentJamesFlags({});
  record({
    tool: 'get_recent_james_flags', name: 'callable_default_window', category: 1,
    status: Array.isArray(r.flags) ? 'PASS' : 'FAIL',
    evidence: `rows=${r.flags.length} latency=${r.meta.latencyMs}ms (empty acceptable — latest 4/24)`,
  });
} catch (e) {
  record({ tool: 'get_recent_james_flags', name: 'callable_default_window', category: 1, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T8.2 — source filter applied: every returned row has source='james_star'
try {
  const r = await getRecentJamesFlags({ hours: 168 });
  const allMatch = r.flags.every((f) => f.source === 'james_star');
  record({
    tool: 'get_recent_james_flags', name: 'source_filter_applied', category: 4,
    status: allMatch ? 'PASS' : 'FAIL',
    evidence: `all_rows_james_star=${allMatch} sample=${r.flags.length}`,
  });
} catch (e) {
  record({ tool: 'get_recent_james_flags', name: 'source_filter_applied', category: 4, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
}

// T8.3 — universe-lock: returned instruments are all in 10-ticker universe
try {
  const r = await getRecentJamesFlags({ hours: 168 });
  const UNIVERSE = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM'];
  const allInUniverse = r.flags.every((f) => UNIVERSE.includes(f.instrument));
  record({
    tool: 'get_recent_james_flags', name: 'universe_lock_respected', category: 4,
    status: allInUniverse ? 'PASS' : 'DRIFT',
    evidence: r.flags.length === 0
      ? 'no_rows_to_check (vacuous PASS)'
      : `instruments=${r.flags.map((f) => f.instrument).join(',')}`,
  });
} catch (e) {
  record({ tool: 'get_recent_james_flags', name: 'universe_lock_respected', category: 4, status: 'FAIL', evidence: e instanceof Error ? e.message : String(e) });
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
