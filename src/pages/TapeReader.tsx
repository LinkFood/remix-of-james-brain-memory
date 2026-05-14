/**
 * /tape-reader — Full timeline of Claude's tape commentary.
 *
 * Shows one entry per row for today first, then prior days. Each entry shows
 * the paragraph + trigger kind + VIX + tide + counts + cost. Designed so
 * James can read the day like a trading journal.
 *
 * Also shows aggregate stats at top: count today, total cost, longest quiet
 * streak, biggest single interrupt (highest-score flag that fired).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Brain, Clock, Zap, Calendar, DollarSign, TrendingUp, Sun, Moon, Sunrise } from 'lucide-react';
import { TapeCommentaryRender } from '@/components/co-trader/TapeCommentaryRender';

interface CommentaryRow {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: 'scheduled' | 'flag_interrupt' | 'manual';
  commentary: string;
  flow_ids: number[] | null;
  flag_ids: string[] | null;
  vix_level: number | null;
  market_tide: string | null;
  window_start: string | null;
  window_end: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
    }).toLowerCase().replace(' ', '');
  } catch {
    return iso.slice(11, 16);
  }
}

function formatDateET(iso: string): string {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function tideClass(tide: string | null): string {
  if (tide === 'bullish') return 'text-emerald-300';
  if (tide === 'bearish') return 'text-red-300';
  return 'text-muted-foreground';
}

/** Return the ET hour (0-23) for an ISO timestamp. */
function hourET(iso: string): number {
  try {
    const h = new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    });
    return parseInt(h, 10);
  } catch {
    return -1;
  }
}

/** Session label for an ET hour. RTH = 09:30-16:00 → 9..15 hour. */
function sessionForHour(h: number): { label: string; tone: string; icon: typeof Sun } {
  if (h < 9 || (h === 9 && false)) return { label: 'Pre-market', tone: 'text-sky-300', icon: Sunrise };
  if (h >= 9 && h <= 15) return { label: 'RTH', tone: 'text-emerald-300', icon: Sun };
  return { label: 'After-hours', tone: 'text-purple-300', icon: Moon };
}

/** Format an hour bucket label like "10am ET" / "1pm ET". */
function formatHourLabel(h: number): string {
  if (h === 0) return '12am ET';
  if (h === 12) return '12pm ET';
  if (h < 12) return `${h}am ET`;
  return `${h - 12}pm ET`;
}

export default function TapeReader() {
  const { data: rows, isLoading } = useQuery<CommentaryRow[]>({
    queryKey: ['ct_tape_commentary_timeline'],
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_tape_commentary' as never) as any)
        .select('id,created_at,session_date,trigger_kind,commentary,flow_ids,flag_ids,vix_level,market_tide,window_start,window_end,model,input_tokens,output_tokens,cost_usd')
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as CommentaryRow[];
    },
  });

  const todayET = useMemo(() => {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }, []);

  const stats = useMemo(() => {
    if (!rows) return { todayCount: 0, todayCost: 0, interrupts: 0, sevenDayCount: 0, sevenDayCost: 0 };
    const sevenDayStart = new Date();
    sevenDayStart.setDate(sevenDayStart.getDate() - 7);
    let todayCount = 0, todayCost = 0, interrupts = 0, sevenDayCount = 0, sevenDayCost = 0;
    for (const r of rows) {
      if (r.session_date === todayET) {
        todayCount++;
        todayCost += r.cost_usd ?? 0;
        if (r.trigger_kind === 'flag_interrupt') interrupts++;
      }
      if (Date.parse(r.created_at) >= sevenDayStart.getTime()) {
        sevenDayCount++;
        sevenDayCost += r.cost_usd ?? 0;
      }
    }
    return { todayCount, todayCost, interrupts, sevenDayCount, sevenDayCost };
  }, [rows, todayET]);

  // Group by session_date
  const grouped = useMemo(() => {
    const out: Array<{ date: string; rows: CommentaryRow[] }> = [];
    if (!rows) return out;
    const m = new Map<string, CommentaryRow[]>();
    for (const r of rows) {
      const arr = m.get(r.session_date) ?? [];
      arr.push(r);
      m.set(r.session_date, arr);
    }
    const sorted = Array.from(m.keys()).sort((a, b) => b.localeCompare(a));
    for (const d of sorted) out.push({ date: d, rows: m.get(d) ?? [] });
    return out;
  }, [rows]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary" />
            <span>Tape Reader</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Claude reads the tape every 10 min during market hours — plus every time a specialist fires a conviction flag. This page is the running journal.
          </p>
        </header>

        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Today</div>
            <div className="text-2xl font-bold tabular-nums">{stats.todayCount}</div>
            <div className="text-[10px] text-muted-foreground">entries</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Zap className="w-3 h-3" /> Interrupts
            </div>
            <div className="text-2xl font-bold tabular-nums text-amber-300">{stats.interrupts}</div>
            <div className="text-[10px] text-muted-foreground">conviction flags</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <DollarSign className="w-3 h-3" /> Today cost
            </div>
            <div className="text-2xl font-bold tabular-nums">${stats.todayCost.toFixed(3)}</div>
            <div className="text-[10px] text-muted-foreground">Haiku</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">7-day</div>
            <div className="text-2xl font-bold tabular-nums">{stats.sevenDayCount}</div>
            <div className="text-[10px] text-muted-foreground">entries</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">7-day cost</div>
            <div className="text-2xl font-bold tabular-nums">${stats.sevenDayCost.toFixed(2)}</div>
            <div className="text-[10px] text-muted-foreground">Haiku</div>
          </Card>
        </div>

        {/* Timeline */}
        {isLoading && !rows ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">Loading timeline…</Card>
        ) : grouped.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            No tape commentary yet. Runs every 10 min during RTH (13:30–20:00 UTC) once the cron fires. Fire a manual one from the Supabase dashboard to bootstrap.
          </Card>
        ) : (
          grouped.map((group) => {
            // Hour-bucket within each session_date so the timeline reads as
            // pre-market / RTH / after-hours blocks with sticky hour headers.
            // rows is newest-first; we keep that ordering so the latest read
            // is at the top under the most recent hour bucket.
            const hourBuckets: Array<{ hour: number; rows: CommentaryRow[] }> = [];
            const seenHours = new Map<number, CommentaryRow[]>();
            for (const r of group.rows) {
              const h = hourET(r.created_at);
              const arr = seenHours.get(h) ?? [];
              arr.push(r);
              seenHours.set(h, arr);
            }
            const hourKeysDesc = Array.from(seenHours.keys()).sort((a, b) => b - a);
            for (const h of hourKeysDesc) hourBuckets.push({ hour: h, rows: seenHours.get(h) ?? [] });

            return (
              <div key={group.date} className="space-y-2">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground mt-2">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>{formatDateET(group.date)}</span>
                  <span className="text-muted-foreground/60">·</span>
                  <span>{group.rows.length} entries</span>
                </div>

                {hourBuckets.map((bucket) => {
                  const session = sessionForHour(bucket.hour);
                  const SessionIcon = session.icon;
                  return (
                    <div key={`${group.date}-h${bucket.hour}`} className="space-y-2">
                      <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border/40 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
                        <SessionIcon className={cn('w-3 h-3', session.tone)} />
                        <span className={cn('font-semibold', session.tone)}>{session.label}</span>
                        <span className="text-muted-foreground/70">·</span>
                        <span className="text-muted-foreground">{formatHourLabel(bucket.hour)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span className="text-muted-foreground">{bucket.rows.length} read{bucket.rows.length === 1 ? '' : 's'}</span>
                      </div>

                      {bucket.rows.map((r, idx) => {
                        // priorCommentary = the chronologically-prior read in the same session.
                        // rows are newest-first, so the *next* row in the array (idx+1 in the
                        // bucket, OR the first row of the next-older bucket) is the prior one.
                        let priorCommentary: string | null = null;
                        if (idx + 1 < bucket.rows.length) {
                          priorCommentary = bucket.rows[idx + 1].commentary;
                        } else {
                          // Look into the next-older hour bucket within the same day.
                          const bucketPos = hourBuckets.findIndex((b) => b.hour === bucket.hour);
                          for (let bi = bucketPos + 1; bi < hourBuckets.length; bi++) {
                            const cand = hourBuckets[bi].rows[0];
                            if (cand) { priorCommentary = cand.commentary; break; }
                          }
                        }

                        return (
                          <Card key={r.id} className={cn(
                            'p-3 space-y-2',
                            r.trigger_kind === 'flag_interrupt' && 'border-amber-500/30 bg-amber-500/5',
                          )}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 text-[11px]">
                                <Clock className="w-3 h-3 text-muted-foreground" />
                                <span className="font-mono tabular-nums text-foreground/80">{formatTimeET(r.created_at)}</span>
                                {r.trigger_kind === 'flag_interrupt' && (
                                  <span className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                                    <Zap className="w-2.5 h-2.5" />
                                    FLAG INTERRUPT
                                  </span>
                                )}
                                {r.trigger_kind === 'manual' && (
                                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">
                                    MANUAL
                                  </span>
                                )}
                                {r.market_tide && (
                                  <span className={cn('text-[10px] font-mono uppercase', tideClass(r.market_tide))}>
                                    tide {r.market_tide}
                                  </span>
                                )}
                                {r.vix_level != null && (
                                  <span className="text-[10px] font-mono text-muted-foreground">
                                    VIX {r.vix_level.toFixed(2)}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                <span className="flex items-center gap-0.5">
                                  <TrendingUp className="w-3 h-3" />
                                  {r.flow_ids?.length ?? 0} flow · {r.flag_ids?.length ?? 0} flag
                                </span>
                                {r.cost_usd != null && (
                                  <span className="tabular-nums">${r.cost_usd.toFixed(4)}</span>
                                )}
                              </div>
                            </div>
                            <TapeCommentaryRender
                              commentary={r.commentary}
                              flagIds={r.flag_ids}
                              flowIds={r.flow_ids}
                              priorCommentary={priorCommentary}
                            />
                          </Card>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Cadence: every 10 min during US RTH (13:30–20:00 UTC) + event-driven on ct_flags insert where score ≥ 80 and status ∈ (active, conviction). Flow / flag IDs stored on every row for future reflection — "what did Claude say vs what happened?"
        </div>
      </div>
    </div>
  );
}
