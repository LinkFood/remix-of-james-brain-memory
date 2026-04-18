/**
 * EvLadder — portfolio-weighted expected value across live ALERTs.
 *
 * Compact card sits at the top of CommandStation, ABOVE ColdOpen when
 * there are live alerts. Answers the one question James asks at the top
 * of the hour: "If I took all three of Claude's live calls at 1R each,
 * what's the math?"
 *
 * Layout:
 *   Header        Portfolio EV: +$60  (green/red/amber)
 *   Rows          ticker · dir · conv · midpoint · R · P(win) · EV
 *                 (clickable → expand to show full expected_move + thesis)
 *   Footer        P(≥1 wins) · Exp max DD · Kelly · skipped count
 *
 * Empty state tells James nothing's live so he doesn't stare at a zero.
 * Independence footnote sits below the footer because overlapping
 * tickers correlate and the math pretends they don't.
 */
import { memo, useCallback, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Info } from 'lucide-react';
import { useEvLadder, type EvLadderAlert } from '@/hooks/useEvLadder';

// ──────── format helpers ────────

function fmtMoney(n: number, sign = true): string {
  if (!Number.isFinite(n)) return '—';
  const prefix = sign && n > 0 ? '+' : n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}K` : `$${abs.toFixed(0)}`;
  return `${prefix}${body}`;
}

function fmtPct(n: number, digits = 1, signed = true): string {
  if (!Number.isFinite(n)) return '—';
  const v = n * 100;
  const sign = signed && v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtMovePct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtR(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${n.toFixed(2)}R`;
}

function convictionLabel(c: number | null): string {
  if (c == null || !Number.isFinite(c)) return '—';
  // Normalize both 0..10 and 0..100 schemas to an int 0..100.
  const pct = c > 10 ? Math.round(c) : Math.round(c * 10);
  return `${pct}`;
}

function evColor(ev: number): string {
  if (ev > 0.2) return 'text-emerald-300';
  if (ev < -0.1) return 'text-red-300';
  return 'text-amber-300';
}

function evHeaderColor(ev: number): { text: string; border: string } {
  if (ev > 0) return { text: 'text-emerald-300', border: 'border-l-emerald-500' };
  if (ev < 0) return { text: 'text-red-300', border: 'border-l-red-500' };
  return { text: 'text-amber-300', border: 'border-l-amber-500' };
}

function directionLabel(dir: string | null): string {
  if (!dir) return '—';
  const d = dir.toLowerCase();
  if (d === 'long' || d === 'bullish' || d === 'up') return 'LONG';
  if (d === 'short' || d === 'bearish' || d === 'down') return 'SHORT';
  return dir.toUpperCase();
}

// ──────── row (collapsed + expanded) ────────

interface LadderRowProps {
  alert: EvLadderAlert;
  dollarsPerR: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}

const LadderRow = memo(function LadderRow({ alert, dollarsPerR, expanded, onToggle }: LadderRowProps) {
  const { expectedMove: em } = alert;
  const handleClick = useCallback(() => onToggle(alert.id), [alert.id, onToggle]);

  return (
    <li className="rounded border border-white/5 overflow-hidden">
      <button
        type="button"
        onClick={handleClick}
        className="w-full grid grid-cols-[56px_56px_40px_68px_52px_52px_1fr] gap-2 px-2 py-1.5 items-center text-left text-[12px] font-mono hover:bg-white/5 transition-colors"
      >
        <span className="font-semibold text-foreground truncate">{alert.instrument}</span>
        <span className={alert.direction?.toLowerCase().startsWith('s') || alert.direction?.toLowerCase().startsWith('b') && alert.direction?.toLowerCase().includes('bear') ? 'text-red-300' : 'text-emerald-300'}>
          {directionLabel(alert.direction)}
        </span>
        <span className="text-muted-foreground text-right">{convictionLabel(alert.conviction)}</span>
        <span className="text-sky-300 text-right">{fmtMovePct(alert.midpointMovePct)}</span>
        <span className="text-foreground text-right">{fmtR(alert.rMultiple)}</span>
        <span className="text-muted-foreground text-right">{fmtPct(alert.adjustedPWin, 0, false)}</span>
        <span className={`text-right font-semibold ${evColor(alert.evPer1R)}`}>
          {fmtMoney(alert.evPer1R * dollarsPerR)}
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-2 bg-black/20 border-t border-white/5 text-[11px] text-muted-foreground space-y-1.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
            <div>band low: <span className="text-foreground">{fmtMovePct(em.low_pct)}</span></div>
            <div>band high: <span className="text-foreground">{fmtMovePct(em.high_pct)}</span></div>
            <div>claimed conf: <span className="text-foreground">{em.confidence_pct.toFixed(0)}%</span></div>
            <div>adjusted: <span className="text-foreground">{fmtPct(alert.adjustedPWin, 0, false)}</span></div>
            <div>horizon: <span className="text-foreground">{em.horizon_hrs}h</span></div>
            <div>claim P×R − (1−P): <span className={evColor(alert.evPer1R)}>{alert.evPer1R.toFixed(2)}</span></div>
          </div>
          {alert.tradeSetup?.rationale && (
            <div className="italic text-foreground/80 leading-snug">
              "{alert.tradeSetup.rationale}"
            </div>
          )}
          {alert.tradeSetup?.stop_level != null && (
            <div className="font-mono">
              stop: <span className="text-foreground">{alert.tradeSetup.stop_level.toFixed(2)}</span>
              {alert.tradeSetup.target_level != null && (
                <>
                  {' · '}target: <span className="text-foreground">{alert.tradeSetup.target_level.toFixed(2)}</span>
                </>
              )}
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            grade history for {alert.instrument} — open Scorecard for the full ledger
          </div>
        </div>
      )}
    </li>
  );
});

// ──────── header row (column labels) ────────

function HeaderRow() {
  return (
    <div className="grid grid-cols-[56px_56px_40px_68px_52px_52px_1fr] gap-2 px-2 pb-1 items-center text-[9px] uppercase tracking-wider text-muted-foreground/70 font-mono">
      <span>tkr</span>
      <span>dir</span>
      <span className="text-right">conv</span>
      <span className="text-right">mid</span>
      <span className="text-right">R</span>
      <span className="text-right">P(w)</span>
      <span className="text-right">EV</span>
    </div>
  );
}

// ──────── component ────────

interface EvLadderProps {
  /** Notional $ per 1R. Defaults to $100 for readability; wire to real book size later. */
  dollarsPerR?: number;
}

export function EvLadder({ dollarsPerR = 100 }: EvLadderProps) {
  const ladder = useEvLadder(dollarsPerR);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id));
  }, []);

  const header = useMemo(() => evHeaderColor(ladder.portfolioEvDollars), [ladder.portfolioEvDollars]);

  // Empty state — no live alerts at all.
  if (!ladder.isLoading && ladder.totalAlertsInWindow === 0) {
    return (
      <Card className="border-l-4 border-l-muted py-2.5 px-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
            Portfolio EV · last 60min
          </div>
          <span className="text-[10px] text-muted-foreground">idle</span>
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          No active alerts — no open trades from alert commits.
        </div>
      </Card>
    );
  }

  // All alerts were pre-v1.3 (no magnitude) — can't compute EV but still
  // want to tell James SOMETHING is live, just unmeasured.
  if (!ladder.isLoading && ladder.alerts.length === 0 && ladder.skippedNoMagnitude > 0) {
    return (
      <Card className="border-l-4 border-l-muted py-2.5 px-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
            Portfolio EV · last 60min
          </div>
          <span className="text-[10px] text-muted-foreground">no magnitude</span>
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {ladder.skippedNoMagnitude} active alert{ladder.skippedNoMagnitude === 1 ? '' : 's'} in window — all pre-v1.3 (no expected_move). Can't compute ladder.
        </div>
      </Card>
    );
  }

  const uncalibrated = ladder.bandAccuracy === null;

  return (
    <Card className={`border-l-4 ${header.border} py-2.5 px-3`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
          Portfolio EV · last 60min · {ladder.alerts.length} live alert{ladder.alerts.length === 1 ? '' : 's'}
        </div>
        <div className={`text-lg font-bold font-mono ${header.text}`}>
          {fmtMoney(ladder.portfolioEvDollars)}
        </div>
      </div>

      {/* Column headers + rows */}
      {ladder.alerts.length > 0 && (
        <>
          <HeaderRow />
          <ul className="space-y-0.5">
            {ladder.alerts.map(a => (
              <LadderRow
                key={a.id}
                alert={a}
                dollarsPerR={ladder.dollarsPerR}
                expanded={expandedId === a.id}
                onToggle={toggleExpand}
              />
            ))}
          </ul>
        </>
      )}

      {/* Footer */}
      <div className="mt-2 pt-2 border-t border-white/5 grid grid-cols-3 gap-2 text-[11px] font-mono">
        <div>
          <div className="text-muted-foreground/70 uppercase text-[9px] tracking-wider">P(≥1 win)</div>
          <div className="text-foreground">{fmtPct(ladder.probAtLeastOneWin, 0, false)}</div>
        </div>
        <div>
          <div className="text-muted-foreground/70 uppercase text-[9px] tracking-wider">Exp max DD</div>
          <div className="text-red-300">−{fmtMoney(ladder.expectedMaxDrawdownDollars, false)}</div>
        </div>
        <div>
          <div className="text-muted-foreground/70 uppercase text-[9px] tracking-wider">Kelly</div>
          <div className="text-foreground">{fmtPct(ladder.kellyFraction, 0, false)}</div>
        </div>
      </div>

      {/* Calibration line */}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground/80 font-mono">
        <span>
          {uncalibrated
            ? 'P(win) uncalibrated — no band_accuracy samples yet'
            : `P(win) discounted ×${ladder.discountFactor.toFixed(2)} (band acc ${(ladder.bandAccuracy!.hitRate * 100).toFixed(0)}% on ${ladder.bandAccuracy!.sampleSize} samples)`}
        </span>
        {ladder.skippedNoMagnitude > 0 && (
          <span>
            {ladder.skippedNoMagnitude} pre-v1.3 alert{ladder.skippedNoMagnitude === 1 ? '' : 's'} skipped (no magnitude)
          </span>
        )}
      </div>

      {/* Independence footnote */}
      <div className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground/60 leading-snug">
        <Info className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
        <span>
          P(≥1 wins) assumes independence. Overlapping tickers → correlated outcomes → this number is an optimistic ceiling.
        </span>
      </div>
    </Card>
  );
}
