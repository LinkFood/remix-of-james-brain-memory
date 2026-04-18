/**
 * hypothesisSelect — Wave 3 of Co-Trader hypothesis engine.
 *
 * Every new alert/flag/observation must cite the governing thesis it relates
 * to (or null, if none of the open hypotheses fit). Two exports:
 *
 *   openHypothesesForTickers — pulls up to 20 open hypotheses whose tickers
 *                              overlap the incoming instruments, sorted by elo.
 *
 *   selectGoverningHypothesis — Haiku 4.5 picks which candidate (if any) the
 *                               new observation supports or contradicts. If no
 *                               candidate fits, returns { hypothesis_id: null }.
 *                               The proposer cron (separate wave) is
 *                               responsible for minting brand-new hypotheses;
 *                               the watcher never auto-creates inline.
 *
 * Design rules:
 *   - Never throw. Selector failure returns null and callers proceed with a
 *     null hypothesis_id. Losing a tag is fine; dropping an alert is not.
 *   - No candidates means no Haiku call (cost + latency win for early days
 *     when the hypothesis stack is empty).
 *   - Keep the selector prompt tight — under ~500 input tokens with 20
 *     candidates. We're running this per alert/flag/observation, not per
 *     market tick.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { callClaude, CLAUDE_MODELS, parseToolUse, ClaudeError } from './anthropic.ts';

const MAX_CANDIDATES = 20;
const SELECTOR_MAX_TOKENS = 256;

export interface HypothesisCandidate {
  id: string;
  claim: string;
  because: string[];
  tickers: string[];
}

export interface SelectorResult {
  hypothesis_id: string | null;
  polarity: 'for' | 'against' | null;
  weight: number;
  reason: string;
}

export interface ObservationForSelector {
  summary: string;
  tickers: string[];
  direction?: string;
  reasoning?: string;
}

/**
 * Pulls up to 20 open hypotheses whose tickers overlap `tickers`, elo DESC.
 * Returns [] on query error or empty ticker list.
 */
export async function openHypothesesForTickers(
  supabase: SupabaseClient,
  tickers: string[],
): Promise<HypothesisCandidate[]> {
  const cleanTickers = (tickers ?? []).filter(t => typeof t === 'string' && t.length > 0);
  if (cleanTickers.length === 0) return [];

  try {
    const { data, error } = await supabase
      .from('ct_hypotheses')
      .select('id, claim, because, tickers')
      .eq('status', 'open')
      .overlaps('tickers', cleanTickers)
      .order('elo', { ascending: false })
      .limit(MAX_CANDIDATES);

    if (error) {
      console.warn('[hypothesisSelect] open query failed:', error.message);
      return [];
    }
    if (!data) return [];

    return (data as Array<Record<string, unknown>>).map(r => ({
      id: String(r.id),
      claim: String(r.claim ?? ''),
      because: Array.isArray(r.because) ? (r.because as unknown[]).map(x => String(x)) : [],
      tickers: Array.isArray(r.tickers) ? (r.tickers as unknown[]).map(x => String(x)) : [],
    }));
  } catch (e) {
    console.warn('[hypothesisSelect] open query threw:', e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Claude Haiku picks which (if any) of the candidates the observation
 * supports / contradicts. Returns { hypothesis_id: null } on any failure
 * or when no candidate is a clear match.
 */
export async function selectGoverningHypothesis(
  _supabase: SupabaseClient,
  observation: ObservationForSelector,
  candidates: HypothesisCandidate[],
): Promise<SelectorResult> {
  const nullResult: SelectorResult = {
    hypothesis_id: null,
    polarity: null,
    weight: 0,
    reason: 'no candidates',
  };

  if (!candidates || candidates.length === 0) return nullResult;

  const cleanSummary = (observation.summary ?? '').slice(0, 400);
  if (!cleanSummary) return nullResult;

  // Compact candidate list — id + claim only by default, because[0] if short.
  const candidateLines = candidates.map((c, i) => {
    const firstBecause = c.because[0] ? ` (because: ${String(c.because[0]).slice(0, 80)})` : '';
    return `${i + 1}. [${c.id}] ${c.claim.slice(0, 140)}${firstBecause}`;
  }).join('\n');

  const userMsg = [
    `New watcher event on ${observation.tickers.join(', ') || '(no tickers)'}:`,
    cleanSummary,
    observation.direction ? `Direction: ${observation.direction}` : '',
    '',
    `Open hypotheses whose tickers overlap this event:`,
    candidateLines,
    '',
    'Which one does this event most clearly bear on? If the event is neutral, tangential, or no candidate is a strong match, return null_id.',
  ].filter(Boolean).join('\n');

  const tool = {
    name: 'select_hypothesis',
    description: 'Pick the governing hypothesis for this observation (or null).',
    input_schema: {
      type: 'object',
      properties: {
        hypothesis_id: {
          type: ['string', 'null'],
          description: 'Exact id from the candidate list, or null if no match.',
        },
        polarity: {
          type: 'string',
          enum: ['for', 'against'],
          description: 'Does this event support (for) or contradict (against) the picked hypothesis?',
        },
        weight: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How strong is the signal? 0.2=weak, 0.5=normal, 0.8=strong.',
        },
        reason: {
          type: 'string',
          description: 'One short sentence of why this picks (or why null).',
        },
      },
      required: ['hypothesis_id', 'polarity', 'weight', 'reason'],
    },
  };

  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      max_tokens: SELECTOR_MAX_TOKENS,
      temperature: 0,
      system: 'You route trading observations to their governing hypothesis. Be strict — only pick a hypothesis if the event would meaningfully update a rational trader\'s belief in that claim. Otherwise return hypothesis_id:null.',
      messages: [{ role: 'user', content: userMsg }],
      tools: [tool],
      tool_choice: { type: 'tool', name: 'select_hypothesis' },
    });

    const toolUse = parseToolUse(res);
    if (!toolUse || toolUse.name !== 'select_hypothesis') {
      console.warn('[hypothesisSelect] selector returned no tool_use');
      return nullResult;
    }

    const input = toolUse.input as Record<string, unknown>;
    const rawId = input.hypothesis_id;
    const candidateIds = new Set(candidates.map(c => c.id));
    const hypothesis_id = (typeof rawId === 'string' && candidateIds.has(rawId)) ? rawId : null;

    const polarity = input.polarity === 'against' ? 'against' : (input.polarity === 'for' ? 'for' : null);
    const rawWeight = Number(input.weight);
    const weight = Number.isFinite(rawWeight) ? Math.max(0, Math.min(1, rawWeight)) : 0.5;
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 300) : '';

    if (hypothesis_id === null) {
      return { hypothesis_id: null, polarity: null, weight: 0, reason: reason || 'no match' };
    }

    return {
      hypothesis_id,
      polarity: polarity ?? 'for',
      weight,
      reason,
    };
  } catch (e) {
    if (e instanceof ClaudeError) {
      console.warn(`[hypothesisSelect] Claude error ${e.status}:`, e.message);
    } else {
      console.warn('[hypothesisSelect] selector threw:', e instanceof Error ? e.message : e);
    }
    return nullResult;
  }
}

/**
 * Convenience: insert a ct_hypothesis_evidence row. Never throws.
 */
export async function recordHypothesisEvidence(
  supabase: SupabaseClient,
  params: {
    hypothesis_id: string;
    evidence_type: 'observation' | 'alert' | 'flag' | 'grade' | 'news' | 'flow' | 'gex' | 'regime' | 'catalyst' | 'manual';
    source_id: string | null;
    polarity: 'for' | 'against';
    weight: number;
    summary: string;
    added_by?: 'claude' | 'james' | 'cron';
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('ct_hypothesis_evidence').insert({
      hypothesis_id: params.hypothesis_id,
      evidence_type: params.evidence_type,
      source_id: params.source_id,
      polarity: params.polarity,
      weight: params.weight,
      summary: params.summary.slice(0, 500),
      added_by: params.added_by ?? 'cron',
    });
    if (error) {
      console.warn('[hypothesisSelect] evidence insert failed:', error.message);
    }
  } catch (e) {
    console.warn('[hypothesisSelect] evidence insert threw:', e instanceof Error ? e.message : e);
  }
}
