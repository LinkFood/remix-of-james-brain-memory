/**
 * Memory recall for the co-trader watcher.
 *
 * Assembles per-instrument context that Claude uses for historical
 * self-awareness. See docs/quant-pivot/memory_recall.md for the design.
 *
 * Called once per cron cycle — cheap in the early days when the corpus
 * is thin, richer as flags and observations accumulate.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { voyageEmbed } from './ctEmbed.ts';

export interface ThesisRow {
  instrument: string;
  direction: string;
  conviction: number;
  up_case: string;
  down_case: string;
  watching: string | null;
  rationale: string | null;
  updated_at: string;
}

export interface RecentItem {
  type: 'observation' | 'flag' | 'alert';
  id: string;
  glance: string[] | null;
  direction: string | null;
  conviction: number | null;
  created_at: string;
}

export interface SimilarPastSetup {
  type: string;
  id: string;
  instrument: string;
  claimed_direction: string | null;
  conviction: number | null;
  verdict: string | null;
  actual_return_pct: number | null;
  created_at: string;
  distance: number;
}

export interface Lesson {
  id: string;
  lesson: string;
  instruments: string[] | null;
  created_at: string;
}

export interface PerInstrumentMemory {
  thesis: ThesisRow | null;
  recent: RecentItem[];
  similar_past_setups: SimilarPastSetup[];
  similar_summary: string;
  lessons: Lesson[];
}

export interface MemoryBundle {
  [instrument: string]: PerInstrumentMemory;
}

/**
 * Build a short descriptor for embedding-based similarity search.
 * Deterministic template fill from live state — cheap, no extra Claude call.
 */
export function buildQueryDescriptor(
  instrument: string,
  liveState: Record<string, unknown>
): string {
  // Extract what we can from UW spot_gex response shape.
  // This is heuristic — schema details vary; safe access.
  const sg = liveState?.spot_gex as Record<string, unknown> | undefined;
  const data = (sg?.data as Array<Record<string, unknown>> | undefined) ?? [];
  const first = data[0] ?? {};
  const price = (first.price as string | undefined) ?? 'unknown';

  const ov = liveState?.options_volume as Record<string, unknown> | undefined;
  const ovData = (ov?.data as Array<Record<string, unknown>> | undefined) ?? [];
  const latest = ovData[0] ?? {};
  const pc = (latest.avg_30_day_put_call_ratio as string | undefined) ?? 'unknown';
  const todayPc = (latest.put_call_ratio as string | undefined) ?? 'unknown';

  return `${instrument} price ${price} put_call ${todayPc} (30d avg ${pc})`;
}

/**
 * Get the current thesis for an instrument, if any.
 */
async function getCurrentThesis(
  supabase: SupabaseClient,
  instrument: string
): Promise<ThesisRow | null> {
  const { data, error } = await supabase
    .from('ct_theses')
    .select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at')
    .eq('instrument', instrument)
    .maybeSingle();
  if (error) {
    console.warn(`[memoryRecall] thesis fetch failed for ${instrument}:`, error.message);
    return null;
  }
  return data as ThesisRow | null;
}

/**
 * Last N observations/flags/alerts for this instrument (4h window).
 */
async function getRecentItems(
  supabase: SupabaseClient,
  instrument: string,
  limit = 4
): Promise<RecentItem[]> {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  const [obs, flags, alerts] = await Promise.all([
    supabase
      .from('ct_observations')
      .select('id, glance, direction, created_at')
      .contains('instruments', [instrument])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('ct_flags')
      .select('id, glance, direction, conviction, created_at')
      .contains('instruments', [instrument])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('ct_alerts')
      .select('id, glance, direction, conviction, created_at')
      .contains('instruments', [instrument])
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const items: RecentItem[] = [];
  for (const row of (obs.data ?? [])) {
    items.push({ type: 'observation', id: row.id, glance: row.glance, direction: row.direction, conviction: null, created_at: row.created_at });
  }
  for (const row of (flags.data ?? [])) {
    items.push({ type: 'flag', id: row.id, glance: row.glance, direction: row.direction, conviction: row.conviction, created_at: row.created_at });
  }
  for (const row of (alerts.data ?? [])) {
    items.push({ type: 'alert', id: row.id, glance: row.glance, direction: row.direction, conviction: row.conviction, created_at: row.created_at });
  }

  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items.slice(0, limit);
}

/**
 * Similarity search via ct_embeddings. Returns top-k nearest
 * observations/flags/alerts for this instrument, with grade attached.
 *
 * During early days (empty corpus) this returns []. That's fine.
 */
async function getSimilarPastSetups(
  supabase: SupabaseClient,
  instrument: string,
  queryText: string,
  k = 5
): Promise<SimilarPastSetup[]> {
  // Skip cost if we know the corpus is effectively empty.
  const { count } = await supabase
    .from('ct_embeddings')
    .select('*', { count: 'estimated', head: true })
    .eq('metadata->>instrument', instrument);
  if (!count || count < 3) return [];

  let queryEmb: number[];
  try {
    queryEmb = await voyageEmbed(queryText, 'query');
  } catch (e) {
    console.warn(`[memoryRecall] query embed failed for ${instrument}:`, e instanceof Error ? e.message : e);
    return [];
  }

  const { data, error } = await supabase.rpc('ct_similar_items', {
    p_instrument: instrument,
    p_query_embedding: queryEmb as unknown as string,
    p_limit: k,
  });

  if (error) {
    console.warn(`[memoryRecall] ct_similar_items RPC failed for ${instrument}:`, error.message);
    return [];
  }

  return (data as SimilarPastSetup[]) ?? [];
}

/**
 * Recent self-corrections — hindsight analysis the self-grader already wrote.
 * Pulling the most recent across the book (not per-instrument) so Claude sees
 * its most recent "what I got wrong / how I'd rewrite" on every tick.
 * This is the chess-engine feedback loop: self-grader writes hindsight,
 * watcher reads it next cycle.
 */
export interface SelfCorrection {
  subject_type: string;
  subject_id: string;
  what_i_got_wrong: string | null;
  how_id_rewrite: string | null;
  grader_verdict: string | null;
  regraded_at: string;
}

export async function getRecentSelfCorrections(
  supabase: SupabaseClient,
  limit = 5
): Promise<SelfCorrection[]> {
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ct_self_regrades')
    .select('subject_type, subject_id, what_i_got_wrong, how_id_rewrite, grader_verdict, regraded_at')
    .gte('regraded_at', cutoff)
    .order('regraded_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[memoryRecall] self-corrections fetch failed:', error.message);
    return [];
  }
  return (data as SelfCorrection[]) ?? [];
}

/**
 * Structural biases the weekly bias-booth extracted. Injected globally so
 * Claude sees its own identity-level patterns before every call — not
 * per-instrument tactical rules (those are ct_lessons), but "what am I
 * systematically wrong about across the book."
 */
export interface ActiveBias {
  id: string;
  pattern: string;
  instruments: string[] | null;
  severity: number;
}

export async function getActiveBiases(
  supabase: SupabaseClient,
  limit = 3
): Promise<ActiveBias[]> {
  const { data, error } = await supabase
    .from('ct_biases')
    .select('id, pattern, instruments, severity')
    .eq('active', true)
    .order('severity', { ascending: false })
    .order('last_confirmed', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[memoryRecall] active biases fetch failed:', error.message);
    return [];
  }
  return (data as ActiveBias[]) ?? [];
}

/**
 * Relevant lessons for this instrument — embedding-nearest if we have
 * any active lessons, else skip. Early days returns [].
 */
async function getRelevantLessons(
  supabase: SupabaseClient,
  instrument: string,
  limit = 3
): Promise<Lesson[]> {
  const { data, error } = await supabase
    .from('ct_lessons')
    .select('id, lesson, instruments, created_at')
    .eq('active', true)
    .or(`instruments.cs.{${instrument}},instruments.is.null`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn(`[memoryRecall] lessons fetch failed for ${instrument}:`, error.message);
    return [];
  }
  return (data as Lesson[]) ?? [];
}

/**
 * Summarize the similarity result in plain English for the Claude prompt.
 */
function summarizeSimilar(items: SimilarPastSetup[]): string {
  if (items.length === 0) return 'No prior graded setups in corpus yet.';
  const graded = items.filter(i => i.verdict);
  if (graded.length === 0) return `${items.length} similar past setups found, none graded yet.`;
  const right = graded.filter(i => i.verdict === 'right').length;
  const wrong = graded.filter(i => i.verdict === 'wrong').length;
  return `${graded.length} graded similar setups: ${right} right, ${wrong} wrong, ${graded.length - right - wrong} ambiguous/partial.`;
}

/**
 * Main entry: build a memory bundle for every instrument in scope.
 * Pass the current live UW state (per-ticker) for query-descriptor generation.
 */
export async function buildMemoryBundle(
  supabase: SupabaseClient,
  instruments: readonly string[],
  liveStateByInstrument: Record<string, Record<string, unknown>>
): Promise<MemoryBundle> {
  const bundle: MemoryBundle = {};

  await Promise.all(instruments.map(async (instrument) => {
    const liveState = liveStateByInstrument[instrument] ?? {};
    const queryText = buildQueryDescriptor(instrument, liveState);

    const [thesis, recent, similar, lessons] = await Promise.all([
      getCurrentThesis(supabase, instrument),
      getRecentItems(supabase, instrument, 3),
      getSimilarPastSetups(supabase, instrument, queryText, 5),
      getRelevantLessons(supabase, instrument, 3),
    ]);

    bundle[instrument] = {
      thesis,
      recent,
      similar_past_setups: similar,
      similar_summary: summarizeSimilar(similar),
      lessons,
    };
  }));

  return bundle;
}
