/**
 * ct-playbook-curator — weekly mining of graded trades/flags/alerts for
 * repeatable successful SETUPS. Fires Sundays 22:45 UTC (6:45pm ET Sunday).
 *
 * Cycle:
 *   1. Pull last 90 days of ct_trades (graded or closed), ct_flags,
 *      ct_alerts, plus existing ct_playbooks.
 *   2. Short-circuit with "insufficient_corpus" when there aren't enough
 *      graded items to mine patterns from.
 *   3. Call Claude Sonnet with PLAYBOOK_CURATOR_SYSTEM.
 *   4. Parse ADD/SUPERSEDE/RETIRE diffs.
 *   5. Apply the diffs: INSERT new, retire superseded, retire explicit.
 *   6. Embed new (non-retired) playbooks directly on ct_playbooks.embedding.
 *   7. Slack digest: "Playbook update: N new, M retired".
 *   8. Log Claude usage to ct_claude_usage.
 *
 * Auth: service role only (same pattern as ct-lessons-curator).
 *
 * First runs over a thin corpus will return { status: "insufficient_corpus" }
 * and gracefully write nothing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { PLAYBOOK_CURATOR_SYSTEM } from '../_shared/ctPrompts.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

// Minimum graded items (trades + flags + alerts) across the window for a
// mining run to even bother calling Claude. Below this, we return
// "insufficient_corpus" without burning tokens.
const MIN_GRADED_CORPUS = 10;

function windowBounds(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 90);
  return { start: start.toISOString(), end: end.toISOString() };
}

interface PayloadRow {
  id: string;
  [k: string]: unknown;
}

async function gatherCorpus(supabase: SupabaseClient, start: string, end: string) {
  const [trades, flags, alerts, existing] = await Promise.all([
    // ct_trades — closed or cancelled positions that carry a resolved outcome.
    // session_date filter is cheaper than created_at here (ct_trades has a
    // btree on session_date DESC).
    supabase
      .from('ct_trades')
      .select(
        'id, session_date, instrument, side, status, thesis, horizon, conviction, ' +
        'entry_price, stop_price, target_price, close_price, close_reason, ' +
        'realized_pnl_pct, realized_pnl_usd, opened_at, closed_at, flag_id'
      )
      .gte('session_date', start.slice(0, 10))
      .lte('session_date', end.slice(0, 10))
      .in('status', ['closed', 'cancelled'])
      .order('session_date', { ascending: false })
      .limit(300),
    // Graded flags — only rows with a grade_id (unresolved flags don't teach).
    supabase
      .from('ct_flags')
      .select(
        'id, instruments, direction, conviction, horizon, evidence_axes, glance, ' +
        'grade_id, full_reasoning, created_at'
      )
      .not('grade_id', 'is', null)
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
      .limit(300),
    // Graded alerts
    supabase
      .from('ct_alerts')
      .select(
        'id, instruments, direction, alert_trigger, horizon, evidence_axes, glance, ' +
        'grade_id, full_reasoning, created_at'
      )
      .not('grade_id', 'is', null)
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
      .limit(200),
    // Existing playbooks — curator needs these for SUPERSEDE/RETIRE reasoning.
    supabase
      .from('ct_playbooks')
      .select(
        'id, name, status, sample_size, historical_win_rate, avg_return_pct, ' +
        'avg_r_multiple, first_seen_at, last_confirmed_at, setup_criteria'
      )
      .order('last_confirmed_at', { ascending: false })
      .limit(100),
  ]);

  // For each graded flag/alert, we also want the grade verdict — join in a
  // second pass to keep the initial query cheap. Handle missing grade_ids
  // gracefully (shouldn't exist given the filter above, but defensive).
  const flagGradeIds = (flags.data ?? [])
    .map((f: PayloadRow) => f.grade_id as string | null)
    .filter((g): g is string => !!g);
  const alertGradeIds = (alerts.data ?? [])
    .map((a: PayloadRow) => a.grade_id as string | null)
    .filter((g): g is string => !!g);
  const gradeIds = Array.from(new Set([...flagGradeIds, ...alertGradeIds]));

  let gradesById = new Map<string, { verdict: string; actual_return_pct: number | null; actual_direction: string | null }>();
  if (gradeIds.length > 0) {
    const { data: grades } = await supabase
      .from('ct_grades')
      .select('id, verdict, actual_return_pct, actual_direction')
      .in('id', gradeIds);
    for (const g of (grades ?? []) as Array<{ id: string; verdict: string; actual_return_pct: number | null; actual_direction: string | null }>) {
      gradesById.set(g.id, {
        verdict: g.verdict,
        actual_return_pct: g.actual_return_pct,
        actual_direction: g.actual_direction,
      });
    }
  }

  const decoratedFlags = (flags.data ?? []).map((f: PayloadRow) => {
    const g = gradesById.get(f.grade_id as string);
    return { ...f, verdict: g?.verdict ?? null, actual_return_pct: g?.actual_return_pct ?? null, actual_direction: g?.actual_direction ?? null };
  });
  const decoratedAlerts = (alerts.data ?? []).map((a: PayloadRow) => {
    const g = gradesById.get(a.grade_id as string);
    return { ...a, verdict: g?.verdict ?? null, actual_return_pct: g?.actual_return_pct ?? null, actual_direction: g?.actual_direction ?? null };
  });

  return {
    graded_trades: trades.data ?? [],
    graded_flags: decoratedFlags,
    graded_alerts: decoratedAlerts,
    existing_playbooks: existing.data ?? [],
  };
}

// -----------------------------------------------------------------------------
// Diff types + application
// -----------------------------------------------------------------------------

interface PlaybookDiff {
  action: 'ADD' | 'SUPERSEDE' | 'RETIRE';
  target_playbook_id?: string | null;
  name?: string | null;
  description?: string | null;
  setup_criteria?: Record<string, unknown> | null;
  historical_win_rate?: number | null;
  sample_size?: number | null;
  avg_return_pct?: number | null;
  avg_r_multiple?: number | null;
  evidence_ids?: string[];
  retire_reason?: string | null;
}

interface CuratorOutput {
  playbooks?: PlaybookDiff[];
  summary?: string;
  status?: 'ok' | 'insufficient_corpus';
}

function parseCuratorJson(raw: string): CuratorOutput | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object') return obj as CuratorOutput;
  } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]) as CuratorOutput; } catch { /* ignore */ }
  }
  return null;
}

/**
 * Apply a single diff row. Returns a classification of what happened so the
 * outer loop can aggregate counts + embed newly inserted rows.
 */
async function applyDiff(
  supabase: SupabaseClient,
  diff: PlaybookDiff,
): Promise<{ outcome: 'added' | 'superseded' | 'retired' | 'skipped' | 'failed'; newId?: string; reason?: string }> {
  const action = (diff.action ?? '').toUpperCase();

  if (action === 'RETIRE') {
    if (!diff.target_playbook_id) return { outcome: 'failed', reason: 'RETIRE missing target_playbook_id' };
    const { error } = await supabase
      .from('ct_playbooks')
      .update({ status: 'retired' })
      .eq('id', diff.target_playbook_id);
    if (error) return { outcome: 'failed', reason: error.message };
    return { outcome: 'retired' };
  }

  if (action === 'ADD' || action === 'SUPERSEDE') {
    if (!diff.name || !diff.description) return { outcome: 'failed', reason: 'ADD/SUPERSEDE missing name or description' };
    if (action === 'SUPERSEDE' && !diff.target_playbook_id) {
      return { outcome: 'failed', reason: 'SUPERSEDE missing target_playbook_id' };
    }

    // Dedupe: strip evidence_ids to a clean string[], validate setup_criteria
    // is an object, clamp win rate into [0,1].
    const evidenceIds = Array.isArray(diff.evidence_ids)
      ? diff.evidence_ids.filter((e): e is string => typeof e === 'string')
      : [];
    const setupCriteria = (diff.setup_criteria && typeof diff.setup_criteria === 'object')
      ? diff.setup_criteria
      : {};
    const winRate = typeof diff.historical_win_rate === 'number'
      ? Math.max(0, Math.min(1, diff.historical_win_rate))
      : null;

    const { data, error } = await supabase.from('ct_playbooks').insert({
      name: diff.name,
      description: diff.description,
      setup_criteria: setupCriteria,
      historical_win_rate: winRate,
      sample_size: typeof diff.sample_size === 'number' ? Math.max(0, Math.floor(diff.sample_size)) : 0,
      avg_return_pct: typeof diff.avg_return_pct === 'number' ? diff.avg_return_pct : null,
      avg_r_multiple: typeof diff.avg_r_multiple === 'number' ? diff.avg_r_multiple : null,
      evidence_ids: evidenceIds,
      status: 'active',
      // first_seen_at defaults to now() on insert; curator can't retro-date
      // the "first seen" without racing existing rows — that's fine, the
      // weekly cadence means first_seen_at is accurate within 7 days.
      last_confirmed_at: new Date().toISOString(),
    }).select('id').maybeSingle();

    if (error || !data) {
      return { outcome: 'failed', reason: error?.message ?? 'insert returned no row' };
    }

    // For SUPERSEDE, retire the target after the new row lands
    if (action === 'SUPERSEDE' && diff.target_playbook_id) {
      const { error: retireErr } = await supabase
        .from('ct_playbooks')
        .update({ status: 'retired' })
        .eq('id', diff.target_playbook_id);
      if (retireErr) {
        console.warn(`[ct-playbook-curator] SUPERSEDE retire of ${diff.target_playbook_id} failed:`, retireErr.message);
      }
      return { outcome: 'superseded', newId: data.id as string };
    }

    return { outcome: 'added', newId: data.id as string };
  }

  return { outcome: 'skipped', reason: `unknown action: ${diff.action}` };
}

/**
 * Embed a freshly-inserted playbook. Writes to ct_playbooks.embedding directly
 * (not ct_embeddings — per the brief, the playbook row holds its own embedding
 * for IVFFlat similarity). Non-retired only (caller filters).
 */
async function embedPlaybook(
  supabase: SupabaseClient,
  playbookId: string,
  name: string,
  description: string,
  setupCriteria: Record<string, unknown>,
): Promise<void> {
  try {
    const text = `PLAYBOOK ${name} | ${description} | criteria: ${JSON.stringify(setupCriteria)}`;
    const vec = await voyageEmbed(text, 'document');
    // pgvector accepts array-cast-to-string in pg-rest.
    const { error } = await supabase
      .from('ct_playbooks')
      .update({ embedding: vec as unknown as string })
      .eq('id', playbookId);
    if (error) console.warn(`[ct-playbook-curator] embedding persist failed for ${playbookId}:`, error.message);
  } catch (e) {
    console.warn(`[ct-playbook-curator] voyage embed threw for ${playbookId}:`, e instanceof Error ? e.message : e);
  }
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
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
  const startedAt = Date.now();

  try {
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const { start, end } = windowBounds();
    const corpus = await gatherCorpus(supabase, start, end);
    const totalGraded = corpus.graded_trades.length + corpus.graded_flags.length + corpus.graded_alerts.length;

    // Insufficient-corpus short-circuit. Skip the Claude call entirely —
    // first runs will hit this path and that's fine.
    if (totalGraded < MIN_GRADED_CORPUS) {
      return new Response(JSON.stringify({
        success: true,
        status: 'insufficient_corpus',
        counts: {
          trades: corpus.graded_trades.length,
          flags: corpus.graded_flags.length,
          alerts: corpus.graded_alerts.length,
          existing_playbooks: corpus.existing_playbooks.length,
        },
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const userMessage = JSON.stringify({ window: { start, end }, ...corpus });

    let claudeText = '';
    const claudeCallStart = Date.now();
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: PLAYBOOK_CURATOR_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 4000,
        temperature: 0.2,
      });
      claudeText = parseTextContent(res);
      logClaudeUsage(supabase, {
        source: 'ct-playbook-curator',
        model: CLAUDE_MODELS.sonnet,
        usage: res.usage,
        duration_ms: Date.now() - claudeCallStart,
        metadata: { user_id: userId, window: { start, end }, corpus_size: totalGraded },
      });
    } catch (e) {
      console.error('[ct-playbook-curator] Claude failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = parseCuratorJson(claudeText);
    if (!parsed) {
      return new Response(JSON.stringify({
        error: 'curator output unparsable',
        raw: claudeText.slice(0, 500),
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Curator signaled thin corpus — respect it, don't try to apply.
    if (parsed.status === 'insufficient_corpus') {
      return new Response(JSON.stringify({
        success: true,
        status: 'insufficient_corpus',
        summary: parsed.summary ?? null,
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const diffs = Array.isArray(parsed.playbooks) ? parsed.playbooks : [];

    // Cap ADDs at 5 per the prompt, but allow unlimited RETIRE/SUPERSEDE.
    let addCount = 0;
    const filtered: PlaybookDiff[] = [];
    for (const d of diffs) {
      if (d?.action === 'ADD') {
        if (addCount >= 5) continue;
        addCount++;
      }
      filtered.push(d);
    }

    const embedQueue: Array<{ id: string; name: string; description: string; criteria: Record<string, unknown> }> = [];
    let added = 0, superseded = 0, retired = 0, failed = 0, skipped = 0;

    for (const d of filtered) {
      const result = await applyDiff(supabase, d);
      switch (result.outcome) {
        case 'added':
          added++;
          if (result.newId && d.name && d.description) {
            embedQueue.push({
              id: result.newId,
              name: d.name,
              description: d.description,
              criteria: (d.setup_criteria ?? {}) as Record<string, unknown>,
            });
          }
          break;
        case 'superseded':
          superseded++;
          if (result.newId && d.name && d.description) {
            embedQueue.push({
              id: result.newId,
              name: d.name,
              description: d.description,
              criteria: (d.setup_criteria ?? {}) as Record<string, unknown>,
            });
          }
          break;
        case 'retired':
          retired++;
          break;
        case 'skipped':
          skipped++;
          if (result.reason) console.warn(`[ct-playbook-curator] skipped: ${result.reason}`);
          break;
        case 'failed':
          failed++;
          if (result.reason) console.warn(`[ct-playbook-curator] failed: ${result.reason}`);
          break;
      }
    }

    // Embed the new rows. Non-retired by construction (added/superseded are
    // active). Sequential to keep Voyage QPS predictable (weekly cron; latency
    // is not critical).
    for (const row of embedQueue) {
      await embedPlaybook(supabase, row.id, row.name, row.description, row.criteria);
    }

    // Slack digest — only push when there's something to say. Retirements
    // alone still count as news.
    if (userId && (added + superseded + retired) > 0) {
      const parts: string[] = [];
      if (added > 0) parts.push(`${added} new`);
      if (superseded > 0) parts.push(`${superseded} superseded`);
      if (retired > 0) parts.push(`${retired} retired`);
      const text = `Playbook update: ${parts.join(', ')}${parsed.summary ? ` — ${parsed.summary}` : ''}`;
      await ctSlackPushDirect(supabase, userId, text, 'ct-playbook-curator');
    }

    return new Response(JSON.stringify({
      success: true,
      status: 'ok',
      added,
      superseded,
      retired,
      failed,
      skipped,
      summary: parsed.summary ?? null,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-playbook-curator] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
