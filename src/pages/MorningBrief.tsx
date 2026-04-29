/**
 * /morning-brief — Daily macro briefing (Co-Trader v2).
 *
 * One entry per trading day. Generated 7 AM ET by the ct-daily-brief
 * cron — a Sonnet-written setup pack with macro narrative, breaking
 * events, overnight tape, per-ticker tilts, and high-conviction ideas.
 *
 * UI mode (tenet 26): pure read-only window into ct_daily_briefs. No
 * triggers, no analysis controls, no writes. Date-range filter chips
 * mirror /flags (Today / 7d / 30d / All), defaulting to Today.
 *
 * Schema reference: see useMorningBrief.ts for the full row shape.
 */

import { useMemo, useState } from 'react';
import {
  useMorningBrief,
  type BriefDateRange,
  type DailyBriefRow,
  type BreakingEvent,
  type PerTickerView,
  type HighConvictionIdea,
} from '@/hooks/useMorningBrief';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  Sunrise,
  Calendar,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Newspaper,
  Moon,
  TrendingUp,
  TrendingDown,
  Minus,
  Ban,
  Target,
  Eye,
  Clock,
} from 'lucide-react';

// ---------- formatters ----------

function formatDateET(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatGenAt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

// ---------- color helpers ----------

function tiltStyle(tilt: string): { card: string; chip: string; label: string } {
  switch (tilt) {
    case 'long_lean':
      return {
        card: 'border-emerald-500/30',
        chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
        label: 'LONG LEAN',
      };
    case 'short_lean':
      return {
        card: 'border-red-500/30',
        chip: 'bg-red-500/15 text-red-300 border-red-500/40',
        label: 'SHORT LEAN',
      };
    case 'avoid':
      return {
        card: 'border-red-500/60 ring-1 ring-red-500/20',
        chip: 'bg-red-500/20 text-red-200 border-red-500/60',
        label: 'AVOID',
      };
    case 'neutral':
    default:
      return {
        card: 'border-border/60',
        chip: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
        label: 'NEUTRAL',
      };
  }
}

function severityStyle(sev: number): { ring: string; text: string; label: string } {
  if (sev >= 5) return { ring: 'border-red-500/60 bg-red-500/10', text: 'text-red-300', label: 'sev 5' };
  if (sev >= 4) return { ring: 'border-orange-500/50 bg-orange-500/10', text: 'text-orange-300', label: 'sev 4' };
  if (sev >= 3) return { ring: 'border-amber-500/50 bg-amber-500/10', text: 'text-amber-300', label: 'sev 3' };
  if (sev >= 2) return { ring: 'border-slate-500/40 bg-slate-500/10', text: 'text-slate-300', label: 'sev 2' };
  return { ring: 'border-muted bg-muted/20', text: 'text-muted-foreground', label: 'sev 1' };
}

function directionIcon(dir: string) {
  if (dir === 'long' || dir === 'long_lean') return <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />;
  if (dir === 'short' || dir === 'short_lean') return <TrendingDown className="w-3.5 h-3.5 text-red-400" />;
  if (dir === 'avoid') return <Ban className="w-3.5 h-3.5 text-red-400" />;
  return <Minus className="w-3.5 h-3.5 text-muted-foreground" />;
}

// ---------- sub-components ----------

function FocusDots({ n }: { n: number }) {
  // 1-5 scale → 5 dots, filled = focus level.
  const clamped = Math.max(0, Math.min(5, Math.round(n || 0)));
  return (
    <span className="inline-flex items-center gap-0.5" title={`Focus ${clamped}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={cn(
            'w-1.5 h-1.5 rounded-full',
            i <= clamped ? 'bg-primary' : 'bg-muted-foreground/25',
          )}
        />
      ))}
    </span>
  );
}

function TickerCard({ pt }: { pt: PerTickerView }) {
  const tilt = tiltStyle(pt.tilt);
  return (
    <Card className={cn('p-3 space-y-2 border', tilt.card)}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base font-bold tracking-tight">{pt.ticker}</span>
          <span
            className={cn(
              'text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border',
              tilt.chip,
            )}
          >
            {tilt.label}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <FocusDots n={pt.focus} />
          <span
            className="text-[10px] font-mono text-muted-foreground"
            title={`Confidence multiplier ${pt.confidence_multiplier}`}
          >
            ×{Number(pt.confidence_multiplier ?? 1).toFixed(2)}
          </span>
        </div>
      </header>

      <div className="flex flex-wrap gap-1 text-[10px]">
        {pt.regime && (
          <span className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground font-mono">
            regime:{pt.regime}
          </span>
        )}
        {pt.alignment && (
          <span className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground font-mono">
            align:{pt.alignment}
          </span>
        )}
      </div>

      {pt.rationale && (
        <p className="text-[12px] leading-relaxed text-foreground/90 italic border-l-2 border-primary/30 pl-2">
          {pt.rationale}
        </p>
      )}

      <div className="grid gap-2">
        {pt.tape_view && (
          <div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Tape view
            </div>
            <p className="text-[11.5px] leading-relaxed text-foreground/80">{pt.tape_view}</p>
          </div>
        )}
        {pt.narrative_view && (
          <div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">
              Narrative view
            </div>
            <p className="text-[11.5px] leading-relaxed text-foreground/80">{pt.narrative_view}</p>
          </div>
        )}
      </div>

      {Array.isArray(pt.catalysts) && pt.catalysts.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {pt.catalysts.map((c, i) => (
            <span
              key={i}
              className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary/90 border border-primary/20"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function IdeaCard({ idea }: { idea: HighConvictionIdea }) {
  return (
    <Card className="p-3 space-y-2 border border-primary/30 bg-primary/5">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {directionIcon(idea.direction)}
          <span className="text-base font-bold tracking-tight">{idea.instrument}</span>
          <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
            {idea.direction}
          </span>
        </div>
        <Badge variant="outline" className="text-[10px] font-mono">
          {Number(idea.size_pct ?? 0).toFixed(1)}% size
        </Badge>
      </header>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded bg-muted/20 p-1.5">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Entry</div>
          <div className="text-xs font-mono font-semibold tabular-nums">{idea.entry_zone || '—'}</div>
        </div>
        <div className="rounded bg-red-500/10 p-1.5">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Stop</div>
          <div className="text-xs font-mono font-semibold tabular-nums text-red-300">
            {idea.stop || '—'}
          </div>
        </div>
        <div className="rounded bg-emerald-500/10 p-1.5">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Target</div>
          <div className="text-xs font-mono font-semibold tabular-nums text-emerald-300">
            {idea.target || '—'}
          </div>
        </div>
      </div>

      {idea.rationale && (
        <p className="text-[12px] leading-relaxed text-foreground/85 italic border-l-2 border-primary/40 pl-2">
          {idea.rationale}
        </p>
      )}
    </Card>
  );
}

function BreakingEventRow({ ev }: { ev: BreakingEvent }) {
  const sev = severityStyle(Number(ev.severity ?? 1));
  return (
    <div className={cn('rounded border p-2 flex items-start gap-2', sev.ring)}>
      <AlertTriangle className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', sev.text)} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug text-foreground/90">{ev.headline}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
          {ev.time && <span>{ev.time}</span>}
          {ev.source && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>{ev.source}</span>
            </>
          )}
          <span className="text-muted-foreground/40">·</span>
          <span className={cn('font-mono', sev.text)}>{sev.label}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- per-day section ----------

function BriefEntry({ row, defaultOpen }: { row: DailyBriefRow; defaultOpen: boolean }) {
  const [expanded, setExpanded] = useState(defaultOpen);

  const breaking = Array.isArray(row.breaking_events) ? row.breaking_events : [];
  const prints = Array.isArray(row.recent_prints) ? row.recent_prints : [];
  const tickers = Array.isArray(row.per_ticker) ? row.per_ticker : [];
  const ideas = Array.isArray(row.high_conviction_ideas) ? row.high_conviction_ideas : [];
  const watchlist = Array.isArray(row.watchlist_focus) ? row.watchlist_focus : [];
  const skip = Array.isArray(row.skip_today) ? row.skip_today : [];

  return (
    <Card className="p-4 space-y-4">
      {/* Header */}
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold tracking-tight">
              {formatDateET(row.session_date)}
            </h2>
            {row.macro_regime && (
              <span className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary">
                {row.macro_regime}
              </span>
            )}
            {row.urgency && row.urgency !== 'normal' && (
              <span className="text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300">
                {row.urgency}
              </span>
            )}
            {row.brief_version != null && row.brief_version > 1 && (
              <span className="text-[10px] font-mono text-muted-foreground">
                v{row.brief_version}
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
            <span>generated {formatGenAt(row.created_at)}</span>
            {row.generated_by_model && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono">{row.generated_by_model}</span>
              </>
            )}
            {row.triggered_by && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-mono">{row.triggered_by}</span>
              </>
            )}
            {row.expires_at && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="inline-flex items-center gap-1 font-mono">
                  <Clock className="w-2.5 h-2.5" />
                  expires {formatGenAt(row.expires_at)}
                </span>
              </>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((e) => !e)}
          className="text-[11px] shrink-0"
        >
          {expanded ? (
            <>
              <ChevronDown className="w-3 h-3 mr-1" /> Collapse
            </>
          ) : (
            <>
              <ChevronRight className="w-3 h-3 mr-1" /> Expand
            </>
          )}
        </Button>
      </header>

      {/* Watchlist + skip chips — visible whether collapsed or open */}
      {(watchlist.length > 0 || skip.length > 0) && (
        <div className="flex flex-wrap gap-2 items-center">
          {watchlist.length > 0 && (
            <>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1">
                <Eye className="w-3 h-3" /> Focus
              </span>
              {watchlist.map((t) => (
                <span
                  key={`w-${t}`}
                  className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                >
                  {t}
                </span>
              ))}
            </>
          )}
          {skip.length > 0 && (
            <>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1 ml-2">
                <Ban className="w-3 h-3" /> Skip
              </span>
              {skip.map((t) => (
                <span
                  key={`s-${t}`}
                  className="text-[11px] font-mono px-2 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/40"
                >
                  {t}
                </span>
              ))}
            </>
          )}
        </div>
      )}

      {/* Macro narrative — lead paragraph */}
      {row.macro_narrative && (
        <div className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90 border-l-2 border-primary/40 pl-3">
          {row.macro_narrative}
        </div>
      )}

      {expanded && (
        <>
          {/* High conviction ideas — prominent */}
          {ideas.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" /> High Conviction Ideas
                <span className="text-muted-foreground/60">({ideas.length})</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {ideas.map((idea, i) => (
                  <IdeaCard key={i} idea={idea} />
                ))}
              </div>
            </section>
          )}

          {/* Breaking events */}
          {breaking.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Breaking Events
                <span className="text-muted-foreground/60">({breaking.length})</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {breaking.map((ev, i) => (
                  <BreakingEventRow key={i} ev={ev} />
                ))}
              </div>
            </section>
          )}

          {/* Overnight action */}
          {row.overnight_action && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Moon className="w-3.5 h-3.5" /> Overnight Action
              </h3>
              <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
                {row.overnight_action}
              </p>
            </section>
          )}

          {/* Recent econ prints */}
          {prints.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Newspaper className="w-3.5 h-3.5" /> Recent Prints
              </h3>
              <div className="rounded border border-border/60 divide-y divide-border/60 bg-muted/10">
                {prints.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-2 px-3 py-1.5 text-[12px]"
                  >
                    <span className="text-muted-foreground font-mono shrink-0">{p.at}</span>
                    <span className="flex-1 truncate text-foreground/85 px-2">{p.name}</span>
                    <span className="font-mono font-medium tabular-nums">{p.value}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Per-ticker grid */}
          {tickers.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
                Per-Ticker Read
                <span className="text-muted-foreground/60 ml-1">({tickers.length})</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {tickers.map((pt, i) => (
                  <TickerCard key={`${pt.ticker}-${i}`} pt={pt} />
                ))}
              </div>
            </section>
          )}

          {/* Convergent view — italic callout */}
          {row.convergent_view && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
                Convergent View
              </h3>
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
                <p className="text-sm leading-relaxed italic text-foreground/90 whitespace-pre-wrap">
                  {row.convergent_view}
                </p>
              </div>
            </section>
          )}

          {/* Footer metadata */}
          <div className="text-[10px] text-muted-foreground/80 leading-relaxed border-t border-border/40 pt-2 flex flex-wrap gap-x-3 gap-y-1">
            {row.generated_by_model && (
              <span>
                model: <span className="font-mono">{row.generated_by_model}</span>
              </span>
            )}
            {row.ttl_hours != null && (
              <span>
                ttl: <span className="font-mono">{row.ttl_hours}h</span>
              </span>
            )}
            {row.expires_at && (
              <span>
                expires: <span className="font-mono">{formatGenAt(row.expires_at)}</span>
              </span>
            )}
            <span>
              id: <span className="font-mono">{row.id.slice(0, 8)}</span>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------- main page ----------

export default function MorningBrief() {
  const [range, setRange] = useState<BriefDateRange>('today');
  const { data: rows, isLoading } = useMorningBrief(range);

  const latest = rows?.[0];
  const tickerCount = useMemo(
    () => (Array.isArray(latest?.per_ticker) ? latest!.per_ticker!.length : 0),
    [latest],
  );
  const ideaCount = useMemo(
    () => (Array.isArray(latest?.high_conviction_ideas) ? latest!.high_conviction_ideas!.length : 0),
    [latest],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Sunrise className="w-5 h-5 text-primary" />
            <span>Morning Brief</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Macro setup pack written by Sonnet at 7 AM ET. Macro narrative, breaking events,
            overnight tape, per-ticker tilts, and high-conviction ideas — read it once, decide,
            move.
          </p>
        </header>

        {/* Top stats strip — mirrors /eod */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Briefs in range
            </div>
            <div className="text-2xl font-bold tabular-nums">{rows?.length ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">
              {range === 'today' ? 'today' : range === 'all' ? 'all-time' : `last ${range}`}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Sunrise className="w-3 h-3" /> Latest
            </div>
            <div className="text-base font-bold">
              {latest?.session_date ? formatDateET(latest.session_date) : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {latest?.macro_regime ? `regime: ${latest.macro_regime}` : 'no regime'}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Eye className="w-3 h-3" /> Tickers covered
            </div>
            <div className="text-2xl font-bold tabular-nums">{tickerCount}</div>
            <div className="text-[10px] text-muted-foreground">latest brief</div>
          </Card>
          <Card className="p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <Target className="w-3 h-3" /> Conviction ideas
            </div>
            <div className="text-2xl font-bold tabular-nums">{ideaCount}</div>
            <div className="text-[10px] text-muted-foreground">latest brief</div>
          </Card>
        </div>

        {/* Date range chips — mirrors /flags */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-1">When:</span>
          {(
            [
              { key: 'today', label: 'Today' },
              { key: '7d', label: '7d' },
              { key: '30d', label: '30d' },
              { key: 'all', label: 'All' },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                range === key
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        {isLoading && !rows ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Loading morning brief…
          </Card>
        ) : !rows || rows.length === 0 ? (
          range === 'today' ? (
            <Card className="p-6 text-center text-sm text-muted-foreground space-y-2">
              <div>Today's brief hasn't fired yet (cron 7 AM ET).</div>
              <div className="text-xs">
                Switch the date range to <span className="font-mono">7d</span> /{' '}
                <span className="font-mono">30d</span> to see prior briefs.
              </div>
            </Card>
          ) : (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              No briefs in this range.
            </Card>
          )
        ) : (
          <div className="space-y-3">
            {rows.map((r, idx) => (
              <BriefEntry key={r.id} row={r} defaultOpen={idx === 0} />
            ))}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Cadence: 7 AM ET weekdays via the <span className="font-mono">ct-daily-brief</span>{' '}
          cron. One row per session_date. Sources: macro tape, breaking news watcher, recent
          econ prints, per-ticker quant cards, gamma + flow positioning.
        </div>
      </div>
    </div>
  );
}
