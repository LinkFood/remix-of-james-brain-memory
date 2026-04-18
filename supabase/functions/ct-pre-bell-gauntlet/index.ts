/**
 * ct-pre-bell-gauntlet — 9:25 AM ET weekday pre-market commitment.
 *
 * Claude looks at overnight context (news, flow, futures read, GEX at open)
 * and commits to three specific predictions for today's session:
 *   1. SPY direction at 10:00 AM ET (up ≥+0.15%, down ≤−0.15%, or flat)
 *   2. One ticker outside SPY/QQQ/IWM that'll print unusual options flow today
 *      (>$5M premium in a single contract)
 *   3. One sector ETF that'll underperform SPY by close (>0.5% delta)
 *
 * Locked before the bell. No hindsight edits. Grader picks these up at
 * 10am, mid-session, and close — pure calibration signal.
 *
 * Cron: 25 13 * * 1-5 (EDT). Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';

const SYSTEM_PROMPT = `You are the pre-bell gauntlet. 9:25 AM ET on a trading day. Your job: three committed predictions for today's session. No hedging. No "could go either way." Commit.

You will be graded. Each prediction has a clear right/wrong resolution. The calibration signal from these is more valuable than any mid-day flag because there's no hindsight contamination.

Return EXACTLY this JSON shape — no prose before or after:
{
  "spy_10am": {
    "direction": "up" | "down" | "flat",
    "threshold": "up ≥+0.15% | down ≤-0.15% | flat = within ±0.15%",
    "rationale": "one sentence — the specific signal driving this call",
    "confidence": 1-5
  },
  "unusual_flow": {
    "ticker": "e.g. NVDA (must be OUTSIDE SPY/QQQ/IWM)",
    "prediction": "will print a >\$5M premium contract today",
    "most_likely_side": "call" | "put",
    "rationale": "one sentence — news flow, gamma pin, catalyst, etc",
    "confidence": 1-5
  },
  "lagging_sector": {
    "sector_etf": "one ETF symbol — XLF, XLE, XLK, XLV, XLY, XLP, XLI, XLU, XLB, XLRE, XLC",
    "prediction": "will underperform SPY by >0.5% by close",
    "rationale": "one sentence — sector-specific reason",
    "confidence": 1-5
  }
}

Confidence rubric: 1 = tossup / gut. 3 = lean with a specific signal. 5 = high-conviction multi-signal. Never pick 5 unless you'd bet real money.

Pick specific, falsifiable predictions. "SPY will move" is not a call. "SPY up ≥+0.15% by 10am" is.`;

interface ContextBundle {
  overnight_news: unknown[];
  open_theses: unknown[];
  recent_flags: unknown[];
  recent_grades: unknown[];
  latest_heartbeat: unknown;
  latest_self_corrections: unknown[];
}

async function gatherContext(supabase: ReturnType<typeof createClient>): Promise<ContextBundle> {
  const since12h = new Date(Date.now() - 12 * 3600_000).toISOString();
  const since72h = new Date(Date.now() - 72 * 3600_000).toISOString();

  const [news, theses, flags, grades, heartbeat, corrections] = await Promise.all([
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('created_at', since12h).gte('significance', 3).order('significance', { ascending: false }).limit(15),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_flags').select('instruments, direction, conviction, horizon, glance, created_at').gte('created_at', since12h).order('created_at', { ascending: false }).limit(10),
    supabase.from('ct_grades').select('instrument, claimed_direction, verdict, actual_return_pct, graded_at').gte('graded_at', since72h).order('graded_at', { ascending: false }).limit(20),
    supabase.from('ct_heartbeats').select('status_line, watching, current_reads, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_self_regrades').select('subject_type, what_i_got_wrong, how_id_rewrite, regraded_at').gte('regraded_at', since72h).order('regraded_at', { ascending: false }).limit(5),
  ]);

  return {
    overnight_news: news.data ?? [],
    open_theses: theses.data ?? [],
    recent_flags: flags.data ?? [],
    recent_grades: grades.data ?? [],
    latest_heartbeat: heartbeat.data ?? null,
    latest_self_corrections: corrections.data ?? [],
  };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const sessionDate = new Date().toISOString().slice(0, 10);

  // Idempotent — bail if already committed today (avoid double-fires)
  const { data: existing } = await supabase
    .from('ct_pre_bell_predictions')
    .select('id, prediction_slot')
    .eq('session_date', sessionDate)
    .limit(1);
  if (existing && existing.length > 0) {
    return new Response(JSON.stringify({ skipped: true, reason: 'already_committed_today', session_date: sessionDate }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const ctx = await gatherContext(supabase);
  const userMessage = JSON.stringify({
    session_date: sessionDate,
    ...ctx,
    note: 'Based on the overnight context above, commit to three predictions per the system schema. Return ONLY the JSON.',
  });

  let claudeText = '';
  const claudeCallStart = Date.now();
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1200,
      temperature: 0.3,
    });
    claudeText = parseTextContent(res);
    logClaudeUsage(supabase, {
      source: 'ct-pre-bell-gauntlet',
      model: CLAUDE_MODELS.sonnet,
      usage: res.usage,
      duration_ms: Date.now() - claudeCallStart,
      metadata: { session_date: sessionDate },
    });
  } catch (e) {
    const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Strip fences + parse
  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: Record<string, { rationale?: string; confidence?: number; [k: string]: unknown }>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(JSON.stringify({ error: 'claude returned invalid json', raw: claudeText.slice(0, 500) }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Snapshot reference prices for accurate grading. SPY for spy_10am;
  // sector ETF + SPY for lagging_sector. Prices at 9:25 ET are within
  // ~0.1% of the open — close enough for direction grading.
  const spyRef = await getCurrentPrice('SPY');
  const sectorTicker = typeof (parsed.lagging_sector as { sector_etf?: string })?.sector_etf === 'string'
    ? (parsed.lagging_sector as { sector_etf: string }).sector_etf
    : null;
  const sectorRef = sectorTicker ? await getCurrentPrice(sectorTicker) : null;

  const committedAt = new Date().toISOString();
  const rows = (['spy_10am', 'unusual_flow', 'lagging_sector'] as const)
    .map(slot => {
      const p = parsed[slot];
      if (!p || typeof p !== 'object') return null;
      const { rationale, confidence, ...rest } = p;
      const predictionBody: Record<string, unknown> = { ...rest };
      if (slot === 'spy_10am') predictionBody.reference_price = spyRef;
      if (slot === 'lagging_sector') {
        predictionBody.reference_spy = spyRef;
        predictionBody.reference_sector = sectorRef;
      }
      return {
        session_date: sessionDate,
        prediction_slot: slot,
        prediction: predictionBody,
        rationale: typeof rationale === 'string' ? rationale : '',
        confidence: typeof confidence === 'number' ? Math.min(5, Math.max(1, Math.round(confidence))) : 3,
        committed_at: committedAt,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: 'no valid prediction slots in claude output', raw: claudeText.slice(0, 500) }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { error: insErr } = await supabase.from('ct_pre_bell_predictions').insert(rows);
  if (insErr) {
    return new Response(JSON.stringify({ error: `insert failed: ${insErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    session_date: sessionDate,
    committed: rows.length,
    slots: rows.map(r => r.prediction_slot),
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
