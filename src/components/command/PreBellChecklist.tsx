/**
 * PreBellChecklist — glance-able readiness panel, visible only during the
 * pre-bell window (04:00 → 09:30 ET weekdays, skips NYSE holidays).
 *
 * Eight rows (status + label + detail, clickable to jump to the relevant
 * page) plus a live countdown to 09:30 ET. A top overall verdict dot
 * summarises the whole panel at a glance ("READY" green / "DEGRADED" amber
 * / "NOT READY" red). Force-refresh button invalidates all row queries so
 * paranoid mornings can re-run the gauntlet on demand.
 *
 * Visibility is owned by the hook's `visible` flag — this component
 * returns null outside pre-bell hours and on non-trading days. Render
 * unconditionally from CommandStation; it will mount/unmount itself.
 */

import { memo, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check, X, Clock, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  usePreBellReadiness,
  type PreBellItem,
  type PreBellStatus,
} from '@/hooks/usePreBellReadiness';
import { fmtCountdown } from '@/lib/etMarketClock';

// ---------------------------------------------------------------------------
// Visual tokens
// ---------------------------------------------------------------------------

const OVERALL_STYLES = {
  ready:       { dot: 'bg-emerald-500', text: 'text-emerald-300', label: 'READY',     borderL: 'border-l-emerald-500' },
  degraded:    { dot: 'bg-amber-500',   text: 'text-amber-300',   label: 'DEGRADED',  borderL: 'border-l-amber-500' },
  'not-ready': { dot: 'bg-red-500',     text: 'text-red-300',     label: 'NOT READY', borderL: 'border-l-red-500' },
} as const;

const ROW_STATUS_STYLES: Record<PreBellStatus, {
  icon: (className: string) => JSX.Element;
  text: string;
  subtle: string;
}> = {
  ok: {
    icon: (cn: string) => <Check className={cn} />,
    text: 'text-emerald-300',
    subtle: 'bg-emerald-500/15 border-emerald-500/40',
  },
  pending: {
    icon: (cn: string) => <Clock className={cn} />,
    text: 'text-amber-300',
    subtle: 'bg-amber-500/15 border-amber-500/40',
  },
  fail: {
    icon: (cn: string) => <X className={cn} />,
    text: 'text-red-300',
    subtle: 'bg-red-500/15 border-red-500/40',
  },
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CheckRowProps {
  item: PreBellItem;
  onNavigate: (href: string) => void;
  countdownText?: string;
}

const CheckRow = memo(function CheckRow({ item, onNavigate, countdownText }: CheckRowProps) {
  const style = ROW_STATUS_STYLES[item.status];
  const clickable = item.href != null && !item.isInformational;

  const handleClick = useCallback(() => {
    if (clickable && item.href) onNavigate(item.href);
  }, [clickable, item.href, onNavigate]);

  // Countdown row renders differently — no status icon, monospace clock on the right.
  if (item.isInformational) {
    return (
      <div className="flex items-center gap-2.5 px-2 py-1.5 rounded">
        <span className="w-5 h-5 inline-flex items-center justify-center shrink-0">
          <Clock className="w-3.5 h-3.5 text-sky-300" />
        </span>
        <span className="flex-1 text-sm text-foreground/90">{item.label}</span>
        <span className="text-sm font-mono font-semibold text-sky-300 tabular-nums">
          {countdownText ?? '—'}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={clickable ? handleClick : undefined}
      disabled={!clickable}
      className={[
        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded text-left transition-colors',
        clickable ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default',
      ].join(' ')}
    >
      <span
        className={[
          'w-5 h-5 inline-flex items-center justify-center shrink-0 rounded-full border',
          style.subtle,
        ].join(' ')}
        aria-hidden
      >
        {style.icon(`w-3 h-3 ${style.text}`)}
      </span>
      <span className="flex-1 min-w-0 text-sm leading-snug text-foreground/95">
        {item.label}
      </span>
      <span className={`text-[11px] font-mono shrink-0 ${style.text}`}>
        {item.detail}
      </span>
    </button>
  );
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function PreBellChecklist() {
  const navigate = useNavigate();
  const {
    items,
    overall,
    marketOpensInMs,
    lastUpdated,
    isLoading,
    forceRefresh,
    visible,
  } = usePreBellReadiness();

  const onNavigate = useCallback((href: string) => {
    if (href.startsWith('http')) window.open(href, '_blank');
    else if (href.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
    else navigate(href);
  }, [navigate]);

  // Hook handles all visibility logic (trading day + 04:00–09:31 ET window).
  if (!visible) return null;

  const ov = OVERALL_STYLES[overall];
  const countdownText = fmtCountdown(marketOpensInMs);

  return (
    <Card className={`border-l-4 ${ov.borderL} py-2.5 px-3`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${ov.dot}`} aria-hidden />
          <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
            Pre-bell checklist
          </div>
          <span className={`text-[10px] font-mono font-semibold ${ov.text}`}>
            {ov.label}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void forceRefresh()}
          disabled={isLoading}
          className="h-6 px-2 text-[10px] uppercase tracking-wider"
        >
          <RefreshCw className={`w-3 h-3 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
          Force check
        </Button>
      </div>

      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.id}>
            <CheckRow
              item={item}
              onNavigate={onNavigate}
              countdownText={item.id === 'countdown' ? countdownText : undefined}
            />
          </li>
        ))}
      </ul>

      {lastUpdated && (
        <div className="mt-1.5 text-[10px] text-muted-foreground/70 text-right font-mono">
          last checked {formatTime(lastUpdated)}
        </div>
      )}
    </Card>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return '—';
  }
}
