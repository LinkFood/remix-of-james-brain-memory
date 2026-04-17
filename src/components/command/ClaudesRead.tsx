/**
 * ClaudesRead — Hero Thesis Strip.
 *
 * Three lines, scannable in <2 seconds:
 *   L1: BEARISH · conv 3/5 · 1h-4h       (direction + conviction dots + horizon)
 *   L2: QQQ 640 break → SPY 700 cascade  (one-sentence thesis)
 *   L3: Kill: call inflow >$50M           (invalidation condition)
 *
 * Below: collapsed "Full reasoning + glance bullets" expandable.
 */
import { useState } from 'react';
import { useRecentEvents, type CtEvent } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { AlertTriangle, Flag, Eye, ChevronDown, ChevronUp } from 'lucide-react';

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Palette {
  border: string;
  accent: string;
  glow: string;
  badge: string;
  icon: React.ReactNode;
  label: string;
}

function paletteFor(direction: string | null | undefined, type: CtEvent['_type']): Palette {
  const typeIcon = type === 'alert'
    ? <AlertTriangle className="w-4 h-4" />
    : type === 'flag'
    ? <Flag className="w-4 h-4" />
    : <Eye className="w-4 h-4" />;
  const label = type.toUpperCase();

  switch (direction) {
    case 'bearish':
      return {
        border: 'border-red-500/50',
        accent: 'text-red-400',
        glow: 'bg-red-500/10',
        badge: 'bg-red-500/20 text-red-300 border-red-500/40',
        icon: typeIcon,
        label,
      };
    case 'bullish':
      return {
        border: 'border-green-500/50',
        accent: 'text-green-400',
        glow: 'bg-green-500/10',
        badge: 'bg-green-500/20 text-green-300 border-green-500/40',
        icon: typeIcon,
        label,
      };
    case 'volatility':
      return {
        border: 'border-amber-500/50',
        accent: 'text-amber-400',
        glow: 'bg-amber-500/10',
        badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        icon: typeIcon,
        label,
      };
    default:
      return {
        border: 'border-border',
        accent: 'text-foreground',
        glow: 'bg-muted/30',
        badge: 'bg-muted/40 text-muted-foreground border-border',
        icon: typeIcon,
        label,
      };
  }
}

/** Filled/empty conviction dots, e.g. ●●●○○. */
function ConvictionDots({ n }: { n: number | null | undefined }) {
  if (n == null) return null;
  const filled = Math.max(0, Math.min(5, Math.round(n)));
  return (
    <span className="inline-flex items-center gap-[3px] align-middle" title={`conviction ${filled}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`w-2 h-2 rounded-full ${i < filled ? 'bg-current' : 'bg-current/20'}`}
        />
      ))}
    </span>
  );
}

/**
 * Pick a one-sentence thesis:
 * 1. first glance bullet (trimmed, no trailing punctuation noise)
 * 2. else first sentence of full_reasoning
 * 3. else alert_trigger
 * 4. else fallback
 */
function extractThesis(e: CtEvent): string {
  if (e.glance && e.glance.length > 0 && e.glance[0]?.trim()) {
    return e.glance[0].trim();
  }
  if (e.full_reasoning) {
    const first = e.full_reasoning.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (first) return first.length > 200 ? first.slice(0, 200) + '…' : first;
  }
  if (e.alert_trigger) return e.alert_trigger;
  return 'Read pending — watcher will post next cycle.';
}

/**
 * Pick an invalidation condition:
 * 1. self_assessment.kill_conditions
 * 2. else scan full_reasoning for a "Watching:" / "Invalidation:" / "Kill:" line
 * 3. else fallback
 */
function extractKill(e: CtEvent): string {
  const kc = e.self_assessment?.kill_conditions?.trim();
  if (kc) return kc;

  if (e.full_reasoning) {
    const text = e.full_reasoning;
    const rx = /(?:^|\n)\s*(?:watching|invalidation|kill(?:\s+conditions?)?|what\s+could\s+go\s+wrong)\s*[:\-]\s*([^\n]+)/i;
    const m = text.match(rx);
    if (m && m[1]) return m[1].trim();
  }

  const wcgw = e.self_assessment?.what_could_go_wrong?.trim();
  if (wcgw) return wcgw;

  return 'manual review needed — no explicit kill condition written';
}

export function ClaudesRead() {
  const { data: events, isLoading } = useRecentEvents(5);
  const [expanded, setExpanded] = useState(false);
  const latest = events?.[0];

  if (isLoading) {
    return (
      <Card className="p-6 min-h-[140px] flex items-center justify-center text-sm text-muted-foreground">
        loading Claude's read…
      </Card>
    );
  }

  if (!latest) {
    return (
      <Card className="p-6 min-h-[140px] flex items-center justify-center text-sm text-muted-foreground">
        No observations yet. Watcher will post first read on next cycle.
      </Card>
    );
  }

  const pal = paletteFor(latest.direction, latest._type);
  const dirLabel = (latest.direction ?? 'neutral').toUpperCase();
  const instruments = (latest.instruments ?? []).join(' ');
  const thesis = extractThesis(latest);
  const kill = extractKill(latest);

  // Compact trade-setup play line — only if Claude committed to a setup
  const setup = latest.trade_setup ?? null;
  let playLine: string | null = null;
  if (setup) {
    const strat = (setup.strategy ?? '').toString().replace(/_/g, ' ');
    const inst = setup.instrument ?? '';
    const strike = setup.strike != null ? ` ${setup.strike}` : '';
    const dte = setup.dte != null
      ? setup.dte === 0 ? '0DTE' : `${setup.dte}DTE`
      : (setup.expiry ?? '');
    const sizeR = setup.size_r != null ? `${setup.size_r}R` : null;
    const entry = setup.entry_level != null ? `entry ${setup.entry_level}` : null;
    const stop = setup.stop_level != null ? `stop ${setup.stop_level}` : null;
    const target = setup.target_level != null ? `target ${setup.target_level}` : null;
    const head = [strat, `${inst}${strike}`, dte].filter(s => s && s.toString().trim()).join(' · ');
    const tail = [sizeR, entry, stop, target].filter(Boolean).join(' / ');
    playLine = [head, tail].filter(s => s && s.length > 0).join(' · ');
  }

  return (
    <Card className={`border-2 ${pal.border} overflow-hidden`}>
      <div className={`${pal.glow} px-4 py-3`}>
        {/* Meta row — small, muted, gives context */}
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${pal.badge}`}>
            {pal.icon}
            {pal.label}
          </span>
          <span className="font-mono font-semibold text-foreground tracking-normal">{instruments || '—'}</span>
          <span className="ml-auto normal-case tracking-normal">{relTime(latest.created_at)}</span>
        </div>

        {/* LINE 1 — hero header: DIRECTION · conv dots · horizon */}
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <span className={`text-2xl md:text-3xl font-black tracking-tight ${pal.accent}`}>
            {dirLabel}
          </span>
          {latest.conviction != null && (
            <span className={`inline-flex items-center gap-1.5 ${pal.accent}`}>
              <span className="text-xs uppercase tracking-wider opacity-70">conv</span>
              <ConvictionDots n={latest.conviction} />
              <span className="text-xs font-semibold">{latest.conviction}/5</span>
            </span>
          )}
          {latest.horizon && (
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              {latest.horizon}
            </span>
          )}
          {latest.alert_trigger && (
            <span className="text-xs font-mono uppercase tracking-wider text-red-400">
              trigger: {latest.alert_trigger}
            </span>
          )}
        </div>

        {/* LINE 2 — the thesis */}
        <p className="text-base md:text-lg font-medium text-foreground leading-snug mb-2">
          {thesis}
        </p>

        {/* LINE 3 — kill condition */}
        <p className="text-sm text-muted-foreground leading-snug">
          <span className="uppercase tracking-wider text-[10px] font-semibold text-foreground/70 mr-1.5">Kill:</span>
          {kill}
        </p>

        {/* LINE 4 — play line (only if Claude committed to a setup) */}
        {playLine && (
          <p className={`text-sm font-mono leading-snug mt-1 ${pal.accent}`}>
            <span className="uppercase tracking-wider text-[10px] font-semibold text-foreground/70 mr-1.5 font-sans">Play:</span>
            {playLine}
          </p>
        )}

        {/* Expand toggle */}
        {(latest.full_reasoning || (latest.glance && latest.glance.length > 0)) && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'hide' : 'show'} full reasoning + glance bullets
          </button>
        )}

        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/60 space-y-2 text-sm">
            {latest.glance && latest.glance.length > 0 && (
              <ul className="space-y-1 text-foreground/90 leading-relaxed">
                {latest.glance.map((g, i) => (
                  <li key={i} className="pl-3 relative">
                    <span className="absolute left-0 top-[0.55em] w-1.5 h-1.5 rounded-full bg-primary/70" />
                    {g}
                  </li>
                ))}
              </ul>
            )}
            {latest.full_reasoning && (
              <p className="text-foreground/85 leading-relaxed whitespace-pre-wrap">
                {latest.full_reasoning}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
