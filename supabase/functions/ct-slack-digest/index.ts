/**
 * ct-slack-digest — scheduled state-of-market Slack push.
 *
 * Cron: every 30min during market hours (0,30 13-20 * * 1-5).
 * Purpose: guaranteed baseline ping regardless of event activity.
 *
 * Verbose layout (VERBOSE_DIGEST=true, default):
 *   1. Book state          — equity vs start, open trades, today's realized P&L
 *   2. Top signals (30m)   — top 3 attention_score >= 60 rows, active combo
 *                            verdicts on SPY/QQQ/IWM, regime inversions today
 *   3. Cluster activity    — sweep + DP clusters last 30 min
 *   4. Claude's current read — heartbeat status_line + SPX thesis age
 *   5. Quiet-day fallback  — if every section empty, 1-line "quiet window"
 *
 * Collapsed layout (VERBOSE_DIGEST=false): Section 1 + quiet fallback only.
 *
 * Auth: service role only. No new UW calls.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

// ---- helpers ---------------------------------------------------------------

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtEquity(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '$—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function sectionBlock(text: string): Record<string, unknown> {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}
function headerBlock(text: string): Record<string, unknown> {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}
function divider(): Record<string, unknown> {
  return { type: 'divider' };
}

const COMBO_TICKERS = ['SPY', 'QQQ', 'IWM'];

type StackRow = {
  option_symbol: string; ticker: string; strike: number | null; expiry: string | null;
  side: string; prints_count: number; premium_total: number;
  ask_dominant_pct: number | null;
  opening_buy_count: number; opening_sell_count: number;
  is_accelerating: boolean;
};

function labelStack(r: StackRow): string {
  const side = (r.side || '').toUpperCase().startsWith('C') ? 'C' : 'P';
  const total = Math.max(1, r.opening_buy_count + r.opening_sell_count);
  const buyDom = r.opening_buy_count / total >= 0.8;
  const sellDom = r.opening_sell_count / total >= 0.8;
  const askLow = r.ask_dominant_pct != null && r.ask_dominant_pct < 30;
  if (buyDom && side === 'C') return '🟢 call accum';
  if (buyDom && side === 'P') return '🔴 put accum';
  if (sellDom && askLow && side === 'P') return '🟢 put writing';
  if (sellDom && askLow && side === 'C') return '🔴 call writing';
  if (sellDom) return '🟡 distribution';
  return '🟡 2-sided';
}

// ---- handler ---------------------------------------------------------------

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const verbose = (Deno.env.get('VERBOSE_DIGEST') ?? 'true').toLowerCase() !== 'false';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Single-user model — first profile wins.
  const { data: users } = await supabase.from('profiles').select('id').limit(1);
  const userId = users?.[0]?.id as string | undefined;
  if (!userId) {
    return new Response(JSON.stringify({ skipped: true, reason: 'no_user' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const now = new Date();
  const sessionDate = new Date(now.getTime()).toISOString().slice(0, 10);
  const cutoff30m = new Date(now.getTime() - 30 * 60_000).toISOString();
  const sessionStartIso = `${sessionDate}T00:00:00Z`;

  const etHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(now);
  const etMin = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', minute: '2-digit' }).format(now);
  const headerText = `Co-Trader Digest · ${etHour}:${etMin} ET`;

  // ==========================================================================
  // Parallel fetch — everything the digest needs in a single round-trip batch.
  // ==========================================================================
  const todayOpenIso = new Date(`${sessionDate}T13:30:00Z`).toISOString();
  const [
    flagsTodayRes,            // specialist flags written since 13:30 UTC today
    flowPulseRes,             // current market-wide directional imbalance
    topPrintRes,              // biggest scored flow print in last 30 min
    stacksRes,                // top institutional repetition patterns (6h)
    attentionRes,
    activeFlagsRes,            // combo-verdict proxy: recent SPY/QQQ/IWM flags
    regimeInversionsRes,
    sweepClustersRes,
    dpClustersRes,
    heartbeatRes,
    spxThesisRes,
  ] = await Promise.all([
    // Today's specialist flags — count + direction split + high score.
    supabase.from('ct_flags')
      .select('specialist_ticker, direction, score')
      .gte('created_at', todayOpenIso),
    // FlowPulse summary — one call to the 6h RPC, then aggregate market-wide.
    supabase.rpc('ct_flow_pulse', { p_window_min: 360, p_ticker: null }),
    // Single biggest premium print in last 30 min.
    supabase.from('ct_scored_flow')
      .select('ticker, option_symbol, classification, premium, score, event_ts')
      .gte('event_ts', cutoff30m)
      .in('classification', ['opening_buy','opening_sell'])
      .order('premium', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.rpc('ct_contract_stacking', {
      p_window_min: 360, p_min_prints: 5, p_min_premium: 500000, p_ticker: null, p_limit: 3,
    }),
    supabase.from('ct_attention_stream')
      .select('kind, id, created_at, attention_score, summary')
      .gte('created_at', cutoff30m)
      .gte('attention_score', 60)
      .order('attention_score', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(3),
    // ct_flags are the persisted combo verdicts on the watchlist. A non-neutral
    // flag touching SPY/QQQ/IWM within the last 60m IS the "active combo
    // verdict" signal (ct-gex-radar does the live compute but doesn't persist).
    supabase.from('ct_flags')
      .select('instruments, direction, conviction, glance, created_at')
      .overlaps('instruments', COMBO_TICKERS)
      .neq('direction', 'neutral')
      .gte('created_at', new Date(now.getTime() - 60 * 60_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('ct_regime_inversions')
      .select('ticker, prev_regime, new_regime, created_at')
      .eq('session_date', sessionDate)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('ct_sweep_clusters')
      .select('ticker, sweep_count, total_premium, dominant_side, created_at')
      .gte('created_at', cutoff30m)
      .order('total_premium', { ascending: false })
      .limit(5),
    supabase.from('ct_dp_clusters')
      .select('ticker, print_count, total_notional, created_at')
      .gte('created_at', cutoff30m)
      .order('total_notional', { ascending: false })
      .limit(5),
    supabase.from('ct_heartbeats')
      .select('status_line, created_at')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_theses')
      .select('instrument, direction, conviction, updated_at')
      .eq('instrument', 'SPX').maybeSingle(),
  ]);

  const flagsToday = (flagsTodayRes.data ?? []) as Array<{
    specialist_ticker: string; direction: string; score: number | null;
  }>;
  const flowPulse = (flowPulseRes.data ?? []) as Array<{
    ticker: string; calls_count: number; puts_count: number;
    calls_premium: number; puts_premium: number;
    call_put_ratio: number | null; premium_net: number;
    cp_ratio_deviation: number | null; is_unusual: boolean;
  }>;
  const topPrint = topPrintRes.data as {
    ticker: string; option_symbol: string | null; classification: string;
    premium: number | null; score: number | null; event_ts: string;
  } | null;
  const stacks = (stacksRes.data ?? []) as StackRow[];
  const attention = (attentionRes.data ?? []) as Array<{
    kind: string; id: string; attention_score: number | null; summary: string | null; created_at: string;
  }>;
  const activeFlags = (activeFlagsRes.data ?? []) as Array<{
    instruments: string[]; direction: string; conviction: number; glance: string[] | null; created_at: string;
  }>;
  const regimeInversions = (regimeInversionsRes.data ?? []) as Array<{
    ticker: string; prev_regime: string; new_regime: string; created_at: string;
  }>;
  const sweepClusters = (sweepClustersRes.data ?? []) as Array<{
    ticker: string; sweep_count: number; total_premium: number; dominant_side: string; created_at: string;
  }>;
  const dpClusters = (dpClustersRes.data ?? []) as Array<{
    ticker: string; print_count: number; total_notional: number; created_at: string;
  }>;
  const hb = heartbeatRes.data as { status_line: string | null; created_at: string } | null;
  const spxThesis = spxThesisRes.data as {
    instrument: string; direction: string; conviction: number; updated_at: string;
  } | null;

  // ==========================================================================
  // Section 1: Today's status — flags + market flow + top print
  // Replaces the old Book section (dead paper-trading cruft).
  // ==========================================================================
  const flagBull = flagsToday.filter(f => f.direction === 'bullish').length;
  const flagBear = flagsToday.filter(f => f.direction === 'bearish').length;
  const flagNeutral = flagsToday.filter(f => f.direction === 'neutral').length;
  const highestFlag = flagsToday.reduce<typeof flagsToday[0] | null>((hi, f) => {
    const s = f.score ?? 0;
    const hs = hi?.score ?? -1;
    return s > hs ? f : hi;
  }, null);

  // Market-wide FlowPulse aggregate (sum counts + premium, premium-weighted C:P).
  let mktCalls = 0, mktPuts = 0, mktCallsPrem = 0, mktPutsPrem = 0, mktNet = 0;
  const unusualTickers: string[] = [];
  for (const r of flowPulse) {
    mktCalls += r.calls_count || 0;
    mktPuts += r.puts_count || 0;
    mktCallsPrem += Number(r.calls_premium) || 0;
    mktPutsPrem += Number(r.puts_premium) || 0;
    mktNet += Number(r.premium_net) || 0;
    if (r.is_unusual) {
      const dev = r.cp_ratio_deviation ?? 0;
      unusualTickers.push(`${r.ticker} ${dev.toFixed(1)}x`);
    }
  }
  const mktCp = mktPutsPrem > 0 ? mktCallsPrem / mktPutsPrem : (mktCalls / Math.max(mktPuts, 1));
  const mktBiasLabel = mktNet > 0 ? 'bullish' : mktNet < 0 ? 'bearish' : 'flat';

  // Top print one-liner.
  const topPrintLine = topPrint && topPrint.premium != null
    ? `${topPrint.ticker} ${topPrint.classification.replace('_', ' ')} ${fmtUsd(Number(topPrint.premium))} score ${topPrint.score ?? '?'}`
    : 'none above threshold';

  const statusLines: string[] = [
    flagsToday.length > 0
      ? `*Today's flags:* ${flagsToday.length} written · ${flagBull} bullish / ${flagBear} bearish${flagNeutral ? ` / ${flagNeutral} neutral` : ''}${highestFlag ? ` · high ${highestFlag.score} ${highestFlag.specialist_ticker} ${highestFlag.direction}` : ''}`
      : `*Today's flags:* none yet`,
    flowPulse.length > 0
      ? `*Market flow:* ${mktCp.toFixed(2)}x call:put · net ${fmtUsd(mktNet)} ${mktBiasLabel}${unusualTickers.length ? ` · ⚠ unusual: ${unusualTickers.slice(0, 3).join(', ')}` : ''}`
      : `*Market flow:* no data`,
    `*Last 30m top print:* ${topPrintLine}`,
    stacks.length > 0
      ? `*Top stacks:* ${stacks.map(s => {
          const strike = s.strike != null ? `$${Math.round(s.strike)}` : '?';
          const expiry = s.expiry ? s.expiry.slice(5).replace('-', '/') : '?';
          const side = (s.side || '').toUpperCase().startsWith('C') ? 'C' : 'P';
          const premCompact = s.premium_total >= 1e6
            ? `$${(s.premium_total / 1e6).toFixed(1)}M`
            : `$${Math.round(s.premium_total / 1e3)}K`;
          const accel = s.is_accelerating ? ' ⚡' : '';
          return `${s.ticker} ${strike}${side} ${expiry} ×${s.prints_count} ${premCompact} ${labelStack(s)}${accel}`;
        }).join(' · ')}`
      : `*Top stacks:* none yet`,
  ];

  // ==========================================================================
  // Section 2: Top signals last 30 min
  // ==========================================================================
  const sigLines: string[] = [];
  if (attention.length > 0) {
    sigLines.push('*Top attention (last 30m):*');
    for (const a of attention) {
      const tagEmoji = a.kind === 'alert' ? ':rotating_light:' : a.kind === 'flag' ? ':triangular_flag_on_post:' : a.kind === 'heartbeat' ? ':heartpulse:' : ':eyes:';
      const summary = (a.summary ?? '').slice(0, 130);
      sigLines.push(`${tagEmoji} *${a.attention_score ?? '?'}* · ${a.kind} (${relTime(a.created_at)}) — ${summary}`);
    }
  }
  if (activeFlags.length > 0) {
    const tickFlags = activeFlags
      .map(f => `${(f.instruments ?? []).filter(i => COMBO_TICKERS.includes(i)).join('/')} ${f.direction} conv${f.conviction} (${relTime(f.created_at)})`)
      .filter(s => s.length > 0)
      .slice(0, 3)
      .join(' · ');
    if (tickFlags) sigLines.push(`*Active combo verdicts:* ${tickFlags}`);
  }
  if (regimeInversions.length > 0) {
    const ri = regimeInversions
      .map(r => `${r.ticker} ${r.prev_regime}→${r.new_regime} (${relTime(r.created_at)})`)
      .join(' · ');
    sigLines.push(`*Regime inversions today:* ${ri}`);
  }

  // ==========================================================================
  // Section 3: Cluster activity (last 30 min)
  // ==========================================================================
  const clusterLines: string[] = [];
  if (sweepClusters.length > 0) {
    const rows = sweepClusters.map(c => `${c.ticker} ${c.sweep_count}× ${c.dominant_side} · $${(c.total_premium / 1000).toFixed(0)}k`);
    clusterLines.push(`*Sweep clusters:* ${rows.join(' · ')}`);
  }
  if (dpClusters.length > 0) {
    const rows = dpClusters.map(c => `${c.ticker} ${c.print_count}× · $${(c.total_notional / 1_000_000).toFixed(1)}M`);
    clusterLines.push(`*DP clusters:* ${rows.join(' · ')}`);
  }

  // ==========================================================================
  // Section 4: Claude's current read
  // ==========================================================================
  const readLines: string[] = [];
  if (hb?.status_line) {
    readLines.push(`*Heartbeat (${relTime(hb.created_at)}):* ${hb.status_line.slice(0, 220)}`);
  }
  if (spxThesis) {
    readLines.push(`*SPX posture:* ${spxThesis.direction} conv${spxThesis.conviction} · held ${relTime(spxThesis.updated_at)}`);
  }

  // ==========================================================================
  // Build Block Kit payload
  // ==========================================================================
  const quietFallbackText = `Quiet 30-min window — no new signals, watchlist stable.`;
  const section2Empty = sigLines.length === 0;
  const section3Empty = clusterLines.length === 0;
  const section4Empty = readLines.length === 0;
  const allQuiet = section2Empty && section3Empty && section4Empty && flagsToday.length === 0;

  const blocks: Array<Record<string, unknown>> = [];
  let fallbackText: string;

  if (!verbose) {
    // Collapsed mode: Section 1 + quiet fallback only.
    blocks.push(headerBlock(headerText));
    blocks.push(divider());
    blocks.push(sectionBlock(statusLines.join('\n')));
    if (allQuiet) {
      blocks.push(divider());
      blocks.push(sectionBlock(`:zzz: ${quietFallbackText}`));
    }
    fallbackText = `Co-Trader digest ${etHour}:${etMin} ET · ${flagsToday.length} flags · ${mktBiasLabel}`;
  } else if (allQuiet) {
    // Verbose mode but nothing to report — single quiet line (keeps cadence
    // as signal without a bloated skeleton).
    blocks.push(headerBlock(headerText));
    blocks.push(sectionBlock(`:zzz: ${quietFallbackText}`));
    fallbackText = quietFallbackText;
  } else {
    blocks.push(headerBlock(headerText));
    blocks.push(divider());
    blocks.push(sectionBlock(`:bar_chart: *Today's status*\n${statusLines.join('\n')}`));
    if (!section2Empty) {
      blocks.push(divider());
      blocks.push(sectionBlock(`:satellite_antenna: *Signals (last 30m)*\n${sigLines.join('\n')}`));
    }
    if (!section3Empty) {
      blocks.push(divider());
      blocks.push(sectionBlock(`:ocean: *Cluster activity (last 30m)*\n${clusterLines.join('\n')}`));
    }
    if (!section4Empty) {
      blocks.push(divider());
      blocks.push(sectionBlock(`:brain: *Current read*\n${readLines.join('\n')}`));
    }
    fallbackText = `Co-Trader digest ${etHour}:${etMin} ET · ${flagsToday.length} flags · ${mktCp.toFixed(1)}x C:P ${mktBiasLabel} · ${attention.length} hot`;
  }

  await ctSlackPushDirect(supabase, userId, fallbackText, 'digest', blocks);

  return new Response(JSON.stringify({
    ok: true,
    verbose,
    quiet: allQuiet,
    sections: {
      status: statusLines.length,
      signals: sigLines.length,
      clusters: clusterLines.length,
      read: readLines.length,
    },
    blocks: blocks.length,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
