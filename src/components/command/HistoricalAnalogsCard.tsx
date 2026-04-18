/**
 * HistoricalAnalogsCard — "today's tape matches these past sessions"
 *
 * Calls ct-session-analog in 'search' mode with through=now and renders the
 * top-N matches + an aggregate outcome line as a directional forecast.
 *
 * Placed on CommandStation near ColdOpen / EventFeed (see CommandStation.tsx).
 *
 * Gracefully handles:
 *   - Empty / warming-up corpus (< 3 past embeddings) → "warming up" copy
 *   - Thin-sample corpus (< 20) → renders DCD cross-facet narrative hits
 *     under a separate "cross-facet" block when available
 *   - No EOD outcomes yet (e.g. still building the first few days) → shows
 *     the match list without the aggregate line.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { History, ArrowUpRight, ArrowDownRight, Minus, Sparkles } from 'lucide-react';

// ---------- API types ----------
interface AnalogMatch {
  session_date: string;
  through_utc: string;
  similarity: number;
  state_features: Record<string, unknown>;
  state_summary_excerpt: string;
  eod_return_pct: number | null;
  eod_summary: string | null;
  lessons_applicable: string[];
}

interface CrossFacetHit {
  snippet: string;
  title: string;
  type: string;
  score: number;
  effective_date: string | null;
  metadata: Record<string, unknown>;
}

interface AnalogsResponse {
  success: boolean;
  mode: 'search';
  session_date: string;
  through_utc: string;
  corpus_count: number;
  warming_up: boolean;
  thin_sample: boolean;
  query_summary: string;
  state_features: Record<string, unknown>;
  matches: AnalogMatch[];
  aggregate: {
    count: number;
    avg_eod_return_pct: number | null;
    bullish_count: number;
    bearish_count: number;
  };
  cross_facet: {
    queried: boolean;
    reason: string | null;
    hits: CrossFacetHit[];
  };
}

// ---------- Hook ----------
function useHistoricalAnalogs() {
  return useQuery<AnalogsResponse>({
    queryKey: ['historical-analogs', 'today'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('ct-session-analog', {
        body: { mode: 'search', limit: 5 },
      });
      if (error) throw error;
      return data as AnalogsResponse;
    },
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,   // sample slowly — analogs don't flip every tick
    refetchIntervalInBackground: false,
    retry: 1,
  });
}

// ---------- Helpers ----------
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function pctColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'text-muted-foreground';
  if (n > 0.1) return 'text-emerald-400';
  if (n < -0.1) return 'text-red-400';
  return 'text-muted-foreground';
}

function PctIcon({ n }: { n: number | null | undefined }) {
  if (n === null || n === undefined || !Number.isFinite(n)) return <Minus className="w-3 h-3" />;
  if (n > 0.1) return <ArrowUpRight className="w-3 h-3" />;
  if (n < -0.1) return <ArrowDownRight className="w-3 h-3" />;
  return <Minus className="w-3 h-3" />;
}

function fmtSim(sim: number): string {
  return `${(sim * 100).toFixed(0)}%`;
}

// ---------- Component ----------
export function HistoricalAnalogsCard() {
  const { data, isLoading, error } = useHistoricalAnalogs();

  const aggregateLine = useMemo(() => {
    if (!data) return null;
    const { aggregate } = data;
    if (aggregate.count === 0) return null;
    const avg = aggregate.avg_eod_return_pct;
    return {
      text: `Aggregate outcome of top ${aggregate.count} analogs: avg close return ${fmtPct(avg)}`,
      leaning:
        (avg ?? 0) > 0.15 ? 'bullish'
        : (avg ?? 0) < -0.15 ? 'bearish'
        : 'flat',
      bullish: aggregate.bullish_count,
      bearish: aggregate.bearish_count,
      avg,
    };
  }, [data]);

  // --- loading state ---
  if (isLoading && !data) {
    return (
      <Card className="py-2.5 px-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          <History className="w-3 h-3" /> Historical analogs
          <span className="ml-auto normal-case tracking-normal text-muted-foreground/70">loading…</span>
        </div>
      </Card>
    );
  }

  // --- error state ---
  if (error || !data) {
    return (
      <Card className="py-2.5 px-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          <History className="w-3 h-3" /> Historical analogs
        </div>
        <div className="text-xs text-muted-foreground mt-1">couldn't load analogs right now.</div>
      </Card>
    );
  }

  // --- warming-up state (< 3 past embeddings) ---
  if (data.warming_up) {
    return (
      <Card className="py-2.5 px-3 border-l-4 border-l-sky-500/40">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          <History className="w-3 h-3" /> Historical analogs
          <Badge variant="outline" className="text-[9px] font-mono">
            {data.corpus_count} / 3
          </Badge>
        </div>
        <div className="text-xs text-foreground/90 mt-1.5">
          Warming up — builds nightly, starts suggesting matches after ~5 days.
        </div>
        {data.cross_facet.queried && data.cross_facet.hits.length > 0 && (
          <div className="mt-2 pt-2 border-t border-white/5">
            <div className="flex items-center gap-1 text-[10px] text-violet-300/90 mb-1">
              <Sparkles className="w-3 h-3" /> cross-facet narrative
            </div>
            <ul className="space-y-1">
              {data.cross_facet.hits.slice(0, 2).map((h, i) => (
                <li key={i} className="text-[11px] text-muted-foreground leading-snug">
                  <span className="font-mono text-muted-foreground/70">
                    {h.effective_date?.slice(0, 10) ?? '—'}
                  </span>
                  {' '}· {h.snippet.slice(0, 140)}…
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    );
  }

  const leaning = aggregateLine?.leaning ?? 'flat';
  const borderColor =
    leaning === 'bullish' ? 'border-l-emerald-500/60'
    : leaning === 'bearish' ? 'border-l-red-500/60'
    : 'border-l-muted';

  return (
    <Card className={`py-2.5 px-3 border-l-4 ${borderColor}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          <History className="w-3 h-3" /> Today's tape matches
        </div>
        <Badge variant="outline" className="text-[9px] font-mono">
          {data.corpus_count} past sessions
        </Badge>
        {data.thin_sample && (
          <Badge variant="outline" className="text-[9px] font-mono text-violet-300 border-violet-500/30">
            thin sample
          </Badge>
        )}
      </div>

      {/* Aggregate line — directional forecast */}
      {aggregateLine && (
        <div className={`text-xs mb-2 flex items-center gap-1.5 ${pctColor(aggregateLine.avg)}`}>
          <PctIcon n={aggregateLine.avg} />
          <span>
            Aggregate outcome of top {data.aggregate.count} analogs:
            {' '}avg close {fmtPct(aggregateLine.avg)}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {aggregateLine.bullish}↑ {aggregateLine.bearish}↓
          </span>
        </div>
      )}

      {/* Match rows */}
      {data.matches.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No past sessions matched above threshold yet.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {data.matches.map((m) => (
            <li key={`${m.session_date}-${m.through_utc}`}>
              <Link
                to={`/session?date=${m.session_date}`}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer transition-colors text-left"
              >
                <span className="font-mono text-xs text-foreground/95 shrink-0">
                  {m.session_date}
                </span>
                <span className="text-[10px] font-mono text-sky-300/90 shrink-0">
                  {fmtSim(m.similarity)}
                </span>
                <span className="flex-1 min-w-0 text-[11px] text-muted-foreground truncate">
                  {m.eod_summary ?? m.state_summary_excerpt}
                </span>
                <span className={`text-[11px] font-mono shrink-0 flex items-center gap-0.5 ${pctColor(m.eod_return_pct)}`}>
                  <PctIcon n={m.eod_return_pct} />
                  {fmtPct(m.eod_return_pct)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {/* Cross-facet narrative hits (thin-sample only) */}
      {data.cross_facet.queried && data.cross_facet.hits.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/5">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-violet-300/90 mb-1">
            <Sparkles className="w-3 h-3" /> cross-facet narrative
          </div>
          <ul className="space-y-0.5">
            {data.cross_facet.hits.slice(0, 2).map((h, i) => (
              <li key={i} className="text-[11px] text-muted-foreground leading-snug px-2">
                <span className="font-mono text-muted-foreground/70">
                  {h.effective_date?.slice(0, 10) ?? '—'}
                </span>
                {' '}· {h.snippet.slice(0, 140)}…
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-1.5 text-[10px] text-muted-foreground/70 text-right font-mono">
        based on heartbeat at {data.through_utc.slice(11, 16)} UTC
      </div>
    </Card>
  );
}
