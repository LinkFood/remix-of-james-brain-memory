/**
 * TradeCards — the edge.
 *
 * Claude doesn't get to say "bearish bias" and walk away. If he flags
 * conv≥3 or alerts, he MUST commit to a specific strike with entry/stop/
 * target/size. This surfaces those setups above the fold.
 *
 * Pulled from ct_flags + ct_alerts where horizon_end is in the future,
 * row is ungraded, trade_setup is non-null. Sorted by conviction desc.
 */
import { useState } from 'react';
import { useActiveTradeSetups, type CtEvent, type TradeSetup } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { AlertTriangle, Flag, ChevronDown, ChevronUp, Target, ShieldAlert, ArrowRightFromLine } from 'lucide-react';

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  // Preserve 2 decimals for under 1000, 1 for larger
  return Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(2);
}

function fmtR(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v}R`;
}

function strategyLabel(s: string | undefined): string {
  if (!s) return 'SETUP';
  return s.replace(/_/g, ' ').toUpperCase();
}

interface SidePalette {
  border: string;
  accent: string;
  glow: string;
  badge: string;
  icon: React.ReactNode;
  label: string;
}

function paletteFor(setup: TradeSetup | null | undefined, type: CtEvent['_type']): SidePalette {
  const typeIcon = type === 'alert'
    ? <AlertTriangle className="w-3.5 h-3.5" />
    : <Flag className="w-3.5 h-3.5" />;
  const label = type.toUpperCase();

  const optType = (setup?.type ?? '').toString().toLowerCase();
  const strat = (setup?.strategy ?? '').toString().toLowerCase();
  const isBearish = optType === 'put' || strat.includes('short_call') || strat.includes('long_put');
  const isBullish = optType === 'call' || strat.includes('long_call') || strat.includes('short_put');

  if (isBearish) {
    return {
      border: 'border-red-500/60',
      accent: 'text-red-400',
      glow: 'bg-red-500/10',
      badge: 'bg-red-500/20 text-red-300 border-red-500/40',
      icon: typeIcon,
      label,
    };
  }
  if (isBullish) {
    return {
      border: 'border-green-500/60',
      accent: 'text-green-400',
      glow: 'bg-green-500/10',
      badge: 'bg-green-500/20 text-green-300 border-green-500/40',
      icon: typeIcon,
      label,
    };
  }
  return {
    border: 'border-amber-500/60',
    accent: 'text-amber-400',
    glow: 'bg-amber-500/10',
    badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    icon: typeIcon,
    label,
  };
}

function ConvictionDots({ n }: { n: number | null | undefined }) {
  if (n == null) return null;
  const filled = Math.max(0, Math.min(5, Math.round(n)));
  return (
    <span className="inline-flex items-center gap-[3px] align-middle" title={`conviction ${filled}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${i < filled ? 'bg-current' : 'bg-current/20'}`}
        />
      ))}
    </span>
  );
}

function TradeCard({ event }: { event: CtEvent }) {
  const [expanded, setExpanded] = useState(false);
  const setup = event.trade_setup ?? null;
  const pal = paletteFor(setup, event._type);

  if (!setup) return null;

  const strat = strategyLabel(setup.strategy?.toString());
  const dteLabel = setup.dte != null
    ? setup.dte === 0 ? '0DTE' : `${setup.dte}DTE`
    : setup.expiry ?? '';

  const header = [
    strat,
    setup.instrument ? `${setup.instrument}${setup.strike != null ? ` ${setup.strike}` : ''}` : null,
    dteLabel || null,
  ].filter(Boolean).join(' · ');

  return (
    <Card className={`border-2 ${pal.border} overflow-hidden`}>
      <div className={`${pal.glow} px-4 py-3`}>
        {/* Meta row */}
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${pal.badge}`}>
            {pal.icon}
            {pal.label}
          </span>
          {event.conviction != null && (
            <span className={`inline-flex items-center gap-1.5 ${pal.accent}`}>
              <ConvictionDots n={event.conviction} />
              <span className="text-[10px] font-semibold normal-case tracking-normal">{event.conviction}/5</span>
            </span>
          )}
          {event.horizon && (
            <span className="font-mono">{event.horizon}</span>
          )}
          <span className="ml-auto normal-case tracking-normal">{relTime(event.created_at)}</span>
        </div>

        {/* Big header: STRATEGY · INSTRUMENT STRIKE · DTE */}
        <div className={`text-lg md:text-xl font-black tracking-tight ${pal.accent} mb-3`}>
          {header || 'TRADE SETUP'}
        </div>

        {/* Entry / Stop / Target row */}
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <ArrowRightFromLine className="w-3 h-3" />
              Entry
            </div>
            <div className="text-xl md:text-2xl font-black font-mono text-foreground leading-tight">
              {fmtPrice(setup.entry_level)}
            </div>
            {setup.entry_condition && (
              <div className="text-[10px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                {setup.entry_condition}
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <ShieldAlert className="w-3 h-3" />
              Stop
            </div>
            <div className="text-xl md:text-2xl font-black font-mono text-foreground leading-tight">
              {fmtPrice(setup.stop_level)}
            </div>
            {setup.stop_condition && (
              <div className="text-[10px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                {setup.stop_condition}
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Target className="w-3 h-3" />
              Target
            </div>
            <div className={`text-xl md:text-2xl font-black font-mono leading-tight ${pal.accent}`}>
              {fmtPrice(setup.target_level)}
            </div>
            {setup.target_rationale && (
              <div className="text-[10px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                {setup.target_rationale}
              </div>
            )}
          </div>
        </div>

        {/* Size badge + rationale */}
        <div className="flex items-start gap-3 mb-1">
          <span className={`inline-flex items-center px-2 py-1 rounded border text-xs font-black font-mono ${pal.badge} shrink-0`}>
            {fmtR(setup.size_r)}
          </span>
          {setup.rationale && (
            <p className="text-sm text-foreground/85 leading-snug">
              {setup.rationale}
            </p>
          )}
        </div>

        {/* Caveats */}
        {setup.caveats && (
          <p className="text-[11px] text-amber-400/90 leading-snug mt-2">
            <span className="uppercase tracking-wider font-semibold mr-1">Caveat:</span>
            {setup.caveats}
          </p>
        )}

        {/* Expand toggle — show underlying flag reasoning */}
        {(event.full_reasoning || (event.glance && event.glance.length > 0)) && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? 'hide' : 'show'} flag reasoning
          </button>
        )}

        {expanded && (
          <div className="mt-3 pt-3 border-t border-border/60 space-y-2 text-sm">
            {event.glance && event.glance.length > 0 && (
              <ul className="space-y-1 text-foreground/90 leading-relaxed">
                {event.glance.map((g, i) => (
                  <li key={i} className="pl-3 relative">
                    <span className="absolute left-0 top-[0.55em] w-1.5 h-1.5 rounded-full bg-primary/70" />
                    {g}
                  </li>
                ))}
              </ul>
            )}
            {event.full_reasoning && (
              <p className="text-foreground/85 leading-relaxed whitespace-pre-wrap">
                {event.full_reasoning}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function nextCycleEta(): string {
  // Watcher runs every 30 min on the half hour — approximate
  const now = new Date();
  const minutes = now.getMinutes();
  const mod = minutes % 30;
  const remaining = mod === 0 ? 30 : 30 - mod;
  return `~${remaining} min`;
}

export function TradeCards() {
  const { data: setups, isLoading } = useActiveTradeSetups(5);

  if (isLoading) {
    return (
      <Card className="p-4 min-h-[80px] flex items-center justify-center text-sm text-muted-foreground">
        loading trade setups…
      </Card>
    );
  }

  if (!setups || setups.length === 0) {
    return (
      <Card className="p-4 border-dashed">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              Active Trade Setups
            </div>
            <p className="text-sm text-foreground/80">
              No active trade setups. Claude writes these when conviction ≥3.
            </p>
          </div>
          <div className="text-xs text-muted-foreground font-mono text-right shrink-0">
            next watcher cycle<br />in {nextCycleEta()}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
          Active Trade Setups <span className="text-foreground/60">({setups.length})</span>
        </div>
        <div className="text-[10px] text-muted-foreground font-mono">
          next cycle in {nextCycleEta()}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {setups.map((e) => (
          <TradeCard key={`${e._type}-${e.id}`} event={e} />
        ))}
      </div>
    </div>
  );
}
