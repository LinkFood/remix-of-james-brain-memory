/**
 * RegimeFlipJournal — Phase 6 of the audit-driven loop. Renders the regime
 * transition stream that has been silently logged in ct_regime_history but
 * never surfaced.
 *
 * Per fusion ground-truth audit Section E #3: /pulse shows current regime
 * + sparkline. Transition timestamps + prior→next + trigger annotations
 * (rationale jsonb) had no UI surface today. RegimeFlipJournal renders
 * the journal so captain reads "2026-05-06 10:00: 9 tickers flipped to
 * pre_event_macro (Fed event upcoming)" at a glance.
 *
 * 5x lift: surface doesn't exist; this is structurally new state visibility
 * — when did regimes flip, what triggered them, was it ticker-isolated or
 * market-wide synchronized.
 *
 * Display:
 *   - Each grouped flip = one row
 *   - Header: time + classification + ticker count (or single ticker name)
 *   - Subhead: "from X to Y" + dominant rationale snippet
 *   - Click row → expand to show all tickers in the group + full rationale
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { GitBranch, ArrowRight, Clock } from 'lucide-react';
import { useRegimeTransitions, type RegimeTransition } from '@/hooks/useRegimeTransitions';

function classBadgeColor(cls: string): string {
  // Heuristic regime → color mapping. Trending up = emerald, trending down
  // = red, chop = amber, transition/risk = sky blue, unknown = muted.
  const c = cls.toLowerCase();
  if (c.includes('bull') || c.includes('trend_up') || c.includes('breakout')) {
    return 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30';
  }
  if (c.includes('bear') || c.includes('trend_down') || c.includes('breakdown')) {
    return 'bg-red-500/20 text-red-200 border-red-500/30';
  }
  if (c.includes('chop') || c.includes('range') || c.includes('mixed')) {
    return 'bg-amber-500/15 text-amber-200 border-amber-500/30';
  }
  if (c.includes('event') || c.includes('macro') || c.includes('pre_')) {
    return 'bg-sky-500/15 text-sky-200 border-sky-500/30';
  }
  if (c === 'unknown') return 'bg-muted/20 text-muted-foreground border-border/40';
  return 'bg-violet-500/15 text-violet-200 border-violet-500/30';
}

function formatTimeNY(iso: string): string {
  const d = new Date(iso);
  const dStr = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/New_York' });
  const tStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  return `${dStr} ${tStr}`;
}

function rationaleSnippet(rationale: Record<string, unknown> | null | undefined): string | null {
  if (!rationale) return null;
  // Try common keys: note, reason, trigger, summary
  for (const k of ['note', 'reason', 'trigger', 'summary', 'why']) {
    const v = (rationale as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 140);
  }
  // Fallback: first string value found
  for (const v of Object.values(rationale)) {
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 140);
  }
  return null;
}

interface FlipRowProps {
  bucket_ts: string;
  classification: string;
  rows: RegimeTransition[];
}

function FlipRow({ bucket_ts, classification, rows }: FlipRowProps) {
  const [expanded, setExpanded] = useState(false);
  const tickers = rows.map((r) => r.ticker ?? 'MKT');
  const tickerCount = tickers.length;
  const sampleRow = rows[0];
  const priorSet = new Set(rows.map((r) => r.prior_classification));
  const priorLabel = priorSet.size === 1 ? Array.from(priorSet)[0] : `${priorSet.size} prior states`;
  const snippet = rationaleSnippet(sampleRow.rationale);
  const meanConf = rows.reduce((s, r) => s + r.confidence, 0) / rows.length;

  return (
    <div className="border border-border/30 rounded-md bg-muted/10 hover:bg-muted/15 transition-colors">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-2 cursor-pointer"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Clock className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-[10px] font-mono text-foreground/90 shrink-0">
            {formatTimeNY(bucket_ts)} ET
          </span>
          <span className={cn('text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border', 'bg-muted/20 text-muted-foreground border-border/40')}>
            {priorLabel}
          </span>
          <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className={cn('text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border font-semibold', classBadgeColor(classification))}>
            {classification}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground shrink-0">
            {tickerCount === 1
              ? tickers[0]
              : `${tickerCount} tickers · ${tickers.slice(0, 4).join(',')}${tickerCount > 4 ? '+' : ''}`}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground shrink-0 ml-auto">
            conf {meanConf.toFixed(0)}
          </span>
        </div>
        {snippet && !expanded && (
          <div className="mt-1 text-[10px] text-muted-foreground/80 line-clamp-1 pl-5">
            {snippet}
          </div>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border/30 p-2 pl-5 space-y-1.5 text-[10px]">
          {snippet && (
            <div className="text-muted-foreground/90 leading-snug">{snippet}</div>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[9px] text-muted-foreground">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 py-0.5">
                <span className="font-semibold text-foreground/90">{r.ticker ?? 'MKT'}</span>
                <span>{r.prior_classification} → {r.classification}</span>
                <span className="opacity-70">conf {r.confidence.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function RegimeFlipJournal() {
  const { grouped, transitions, isLoading } = useRegimeTransitions({ lookbackHours: 72, limit: 80 });

  if (isLoading) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          Regime Flip Journal · loading...
        </div>
      </Card>
    );
  }

  if (grouped.length === 0) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="flex items-center gap-2 mb-1">
          <GitBranch className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
            Regime Flip Journal · last 72h
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 italic">
          No regime transitions in the last 72h. Quiet regime — no flips logged. Regime classifier runs every 15 min RTH.
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-3 bg-muted/10 border-primary/20 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Regime Flip Journal · last 72h
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground">
          <span>{grouped.length} flip event{grouped.length === 1 ? '' : 's'}</span>
          <span>{transitions.length} ticker-flip{transitions.length === 1 ? '' : 's'}</span>
          <span className="opacity-70">click any row to expand</span>
        </div>
      </div>

      <div className="space-y-1.5 max-h-96 overflow-y-auto">
        {grouped.map((g, idx) => (
          <FlipRow
            key={`${g.bucket_ts}-${g.classification}-${idx}`}
            bucket_ts={g.bucket_ts}
            classification={g.classification}
            rows={g.rows}
          />
        ))}
      </div>
    </Card>
  );
}
