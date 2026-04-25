/**
 * signatureMemory — pre-formatted markdown block of a ticker's accumulated
 * edge for injection into specialist prompts.
 *
 * Pulls from FOUR defensive reads, each independently try/wrapped so a
 * missing/empty downstream table simply omits its sub-section. The block is
 * shaped for Claude consumption: heading + sub-headings + bullet rows. No
 * schema is fatal — if every read fails we return a minimal stub.
 *
 * Inputs (all nullable / may not exist yet — parallel agents own them):
 *   ct_signatures   — promoted patterns + edge_score + median_days_to_realization
 *   ct_print_grades — last 7d snapshot wins/losses for this ticker
 *   ct_print_tracks — currently-WORKING (>50% to threshold) tracks
 *   ct_edge_daily   — today's by_ticker attribution slice
 *
 * Tenets: defensive (every section tolerates absence), additive (specialist
 * prompts gain a new anchor without breaking existing reasoning), grounded
 * in actual edge (no hand-tuned hints — ranking is from the data).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

const SNAPSHOT_LOOKBACK_DAYS = 7;

interface PromotedSig {
  signature_key?: string | null;
  hit_rate?: number | string | null;
  sample_count?: number | null;
  edge_score?: number | string | null;
  median_days_to_realization?: number | string | null;
}

interface OpenTrack {
  print_id?: string | null;
  ticker?: string | null;
  signature_key?: string | null;
  print_time?: string | null;
  peak_favorable_pct?: number | string | null;
  threshold_pct?: number | string | null;
  dte_bucket?: string | null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtPct(v: unknown, digits = 1): string {
  const n = num(v);
  if (n === null) return '—';
  // Stored either as decimal (0.62 = 62%) or percent (62 = 62%). Detect by
  // magnitude — anything < 1 is treated as a fraction.
  const asPct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${asPct.toFixed(digits)}%`;
}

function fmtNum(v: unknown, digits = 2): string {
  const n = num(v);
  if (n === null) return '—';
  return n.toFixed(digits);
}

function fmtSignedPct(v: unknown, digits = 1): string {
  const n = num(v);
  if (n === null) return '—';
  const asPct = Math.abs(n) <= 1 ? n * 100 : n;
  const sign = asPct >= 0 ? '+' : '';
  return `${sign}${asPct.toFixed(digits)}%`;
}

function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = String(iso);
  if (s.length < 10) return s;
  return s.slice(0, 16).replace('T', ' ');
}

async function loadPromotedSignatures(
  supabase: SupabaseClient,
  ticker: string,
  inverse = false,
  limit = 5,
): Promise<PromotedSig[]> {
  try {
    let query = supabase
      .from('ct_signatures')
      .select('signature_key, hit_rate, sample_count, edge_score, median_days_to_realization')
      .eq('ticker', ticker)
      .eq('promoted', true);
    query = inverse
      ? query.order('edge_score', { ascending: true })
      : query.order('edge_score', { ascending: false });
    const { data, error } = await query.limit(limit);
    if (error) {
      console.warn(`[signatureMemory] ${ticker} promoted ${inverse ? 'losers' : 'winners'} load failed:`, error.message);
      return [];
    }
    return (data ?? []) as PromotedSig[];
  } catch (e) {
    console.warn(`[signatureMemory] ${ticker} promoted ${inverse ? 'losers' : 'winners'} threw:`, String(e));
    return [];
  }
}

async function loadSnapshotStats(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ wins: number; losses: number; flats: number; total: number; hit_rate: number | null }> {
  try {
    const cutoff = new Date(Date.now() - SNAPSHOT_LOOKBACK_DAYS * 24 * 3600_000).toISOString();
    const { data, error } = await supabase
      .from('ct_print_grades')
      .select('grade')
      .eq('ticker', ticker)
      .gte('graded_at', cutoff);
    if (error) {
      console.warn(`[signatureMemory] ${ticker} snapshot stats load failed:`, error.message);
      return { wins: 0, losses: 0, flats: 0, total: 0, hit_rate: null };
    }
    const rows = (data ?? []) as Array<{ grade?: string | null }>;
    let wins = 0, losses = 0, flats = 0;
    for (const r of rows) {
      const g = String(r.grade ?? '').toUpperCase();
      if (g === 'WIN') wins++;
      else if (g === 'LOSS') losses++;
      else if (g === 'FLAT') flats++;
    }
    const decided = wins + losses;
    const hit_rate = decided > 0 ? wins / decided : null;
    return { wins, losses, flats, total: rows.length, hit_rate };
  } catch (e) {
    console.warn(`[signatureMemory] ${ticker} snapshot stats threw:`, String(e));
    return { wins: 0, losses: 0, flats: 0, total: 0, hit_rate: null };
  }
}

async function loadWorkingTracks(
  supabase: SupabaseClient,
  ticker: string,
  limit = 5,
): Promise<OpenTrack[]> {
  // Tracks that are still WORKING and already past 50% of their DTE threshold.
  // Schema may not exist yet (Agent A is mid-build); read defensively.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('ct_print_tracks' as never) as any)
      .select('print_id, ticker, signature_key, print_time, peak_favorable_pct, threshold_pct, dte_bucket, track_status')
      .eq('ticker', ticker)
      .eq('track_status', 'WORKING')
      .order('peak_favorable_pct', { ascending: false })
      .limit(50);
    if (error) {
      console.warn(`[signatureMemory] ${ticker} working tracks load failed:`, error.message);
      return [];
    }
    const rows = (data ?? []) as OpenTrack[];
    // Filter: peak_favorable_pct already > 50% of threshold_pct.
    const filtered = rows.filter((r) => {
      const peak = num(r.peak_favorable_pct);
      const thr = num(r.threshold_pct);
      if (peak === null || thr === null || thr === 0) return false;
      return Math.abs(peak) >= Math.abs(thr) * 0.5;
    });
    return filtered.slice(0, limit);
  } catch (e) {
    console.warn(`[signatureMemory] ${ticker} working tracks threw:`, String(e));
    return [];
  }
}

async function loadTodayByTicker(
  supabase: SupabaseClient,
  ticker: string,
): Promise<Record<string, unknown> | null> {
  try {
    // session_date in NY-tz
    const nyParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const yyyy = nyParts.find(p => p.type === 'year')?.value ?? '1970';
    const mm = nyParts.find(p => p.type === 'month')?.value ?? '01';
    const dd = nyParts.find(p => p.type === 'day')?.value ?? '01';
    const sessionDate = `${yyyy}-${mm}-${dd}`;

    const { data, error } = await supabase
      .from('ct_edge_daily')
      .select('by_ticker, regime_tag, overall_hit_rate')
      .eq('session_date', sessionDate)
      .maybeSingle();
    if (error) {
      console.warn(`[signatureMemory] ${ticker} edge_daily load failed:`, error.message);
      return null;
    }
    if (!data) return null;
    const byTicker = (data.by_ticker ?? {}) as Record<string, unknown>;
    const slice = byTicker?.[ticker];
    if (!slice) {
      return {
        regime_tag: data.regime_tag ?? null,
        overall_hit_rate: data.overall_hit_rate ?? null,
        ticker_slice: null,
      };
    }
    return {
      regime_tag: data.regime_tag ?? null,
      overall_hit_rate: data.overall_hit_rate ?? null,
      ticker_slice: slice,
    };
  } catch (e) {
    console.warn(`[signatureMemory] ${ticker} edge_daily threw:`, String(e));
    return null;
  }
}

export async function fetchSignatureEdgeForTicker(
  supabase: SupabaseClient,
  ticker: string,
): Promise<string> {
  const [winners, losers, snapshot, working, today] = await Promise.all([
    loadPromotedSignatures(supabase, ticker, false, 5),
    loadPromotedSignatures(supabase, ticker, true, 3),
    loadSnapshotStats(supabase, ticker),
    loadWorkingTracks(supabase, ticker, 5),
    loadTodayByTicker(supabase, ticker),
  ]);

  // If literally nothing is populated yet, return a stub so the prompt section
  // is still anchored — the specialist needs to know "no edge data yet" is a
  // distinct signal from "edge data unfetched".
  const everythingEmpty =
    winners.length === 0 &&
    losers.length === 0 &&
    snapshot.total === 0 &&
    working.length === 0 &&
    today === null;
  if (everythingEmpty) {
    return [
      `## Recent Edge for ${ticker}`,
      '',
      `_Signature library + grader haven't accumulated data on ${ticker} yet — this prompt section will populate as ct_signatures and ct_print_grades fill. Treat as no-prior signal._`,
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`## Recent Edge for ${ticker}`);
  lines.push('');

  if (winners.length > 0) {
    lines.push(`### Promoted winning signatures (top ${winners.length} by edge_score)`);
    for (const w of winners) {
      const key = w.signature_key ?? '?';
      const hit = fmtPct(w.hit_rate);
      const n = w.sample_count ?? '?';
      const edge = fmtNum(w.edge_score);
      const days = w.median_days_to_realization !== null && w.median_days_to_realization !== undefined
        ? `${fmtNum(w.median_days_to_realization, 1)}d median`
        : 'horizon unspec';
      lines.push(`- \`${key}\` — ${hit} hit (n=${n}) · edge ${edge} · ${days}`);
    }
    lines.push('');
  }

  if (losers.length > 0) {
    lines.push(`### Promoted losing signatures (avoid — top ${losers.length} by inverse edge)`);
    for (const l of losers) {
      const key = l.signature_key ?? '?';
      const hit = fmtPct(l.hit_rate);
      const n = l.sample_count ?? '?';
      const edge = fmtNum(l.edge_score);
      lines.push(`- \`${key}\` — ${hit} hit (n=${n}) · edge ${edge}`);
    }
    lines.push('');
  }

  if (snapshot.total > 0) {
    const hr = snapshot.hit_rate !== null ? fmtPct(snapshot.hit_rate) : '—';
    lines.push(`### Last ${SNAPSHOT_LOOKBACK_DAYS}-day snapshot stats`);
    lines.push(`- ${snapshot.wins}W / ${snapshot.losses}L / ${snapshot.flats}F across ${snapshot.total} graded prints · hit rate ${hr}`);
    lines.push('');
  }

  if (working.length > 0) {
    lines.push(`### Currently WORKING tracks for ${ticker} (>50% to threshold)`);
    for (const t of working) {
      const key = t.signature_key ?? '?';
      const peak = fmtSignedPct(t.peak_favorable_pct);
      const thr = fmtSignedPct(t.threshold_pct);
      const when = shortDateTime(t.print_time);
      lines.push(`- \`${key}\` · printed ${when} UTC · peak ${peak} (threshold ${thr})`);
    }
    lines.push('');
  }

  if (today && today.ticker_slice) {
    const slice = today.ticker_slice as Record<string, unknown>;
    const regime = today.regime_tag ?? 'untagged';
    const overall = today.overall_hit_rate !== null && today.overall_hit_rate !== undefined
      ? fmtPct(today.overall_hit_rate)
      : '—';
    const wins = slice.wins ?? slice.win_count ?? '?';
    const losses = slice.losses ?? slice.loss_count ?? '?';
    const tickerHr = slice.hit_rate ?? slice.ticker_hit_rate;
    const hr = tickerHr !== null && tickerHr !== undefined ? fmtPct(tickerHr) : '—';
    lines.push(`### Today's session attribution (${regime}, market hit rate ${overall})`);
    lines.push(`- ${ticker}: ${wins}W / ${losses}L · ticker hit rate ${hr}`);
    lines.push('');
  } else if (today) {
    const regime = today.regime_tag ?? 'untagged';
    const overall = today.overall_hit_rate !== null && today.overall_hit_rate !== undefined
      ? fmtPct(today.overall_hit_rate)
      : '—';
    lines.push(`### Today's session attribution (${regime}, market hit rate ${overall})`);
    lines.push(`- ${ticker}: no graded prints yet today.`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
