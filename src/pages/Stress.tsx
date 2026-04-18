/**
 * Stress — stress scenarios page for the Co-Trader book.
 *
 * Three preset scenario cards (MILD / MODERATE / SEVERE) project per-position
 * P&L over the current open book under ±% underlying moves. Bottom of the
 * page hosts a 5-slot custom scenario builder.
 *
 * All math is client-side (see useStressScenarios). No edge functions, no UW
 * calls. Options rows are deferred — we surface that as a badge/count rather
 * than making up greeks.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowLeft, AlertTriangle, Activity, Zap } from 'lucide-react';
import {
  useStressScenarios,
  runCustomScenario,
  type ScenarioResult,
  type TradeProjection,
  type CustomLeg,
} from '@/hooks/useStressScenarios';

const GREEN = '#00C853';
const RED = '#FF1744';
const MUTED = 'hsl(var(--muted-foreground))';

function fmtUsd(n: number | null | undefined, signed = true): string {
  if (n == null) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  if (!signed) return `$${abs}`;
  if (n === 0) return '$0';
  return n > 0 ? `+$${abs}` : `-$${abs}`;
}

function fmtUsdCents(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function pnlColor(n: number | null | undefined): string | undefined {
  if (n == null || n === 0) return undefined;
  return n > 0 ? GREEN : RED;
}

// ----------------------------------------------------------------------------
// Per-leg projection rows inside a scenario card
// ----------------------------------------------------------------------------

function LegTable({
  title,
  projections,
  direction,
}: {
  title: string;
  projections: TradeProjection[];
  direction: 'down' | 'up';
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        <span className="text-[10px]">
          ({direction === 'down' ? 'down leg' : 'up leg'})
        </span>
      </div>
      <div className="space-y-1">
        {projections.map(p => {
          const t = p.trade;
          const isStop = p.stopOut;
          const isTarget = p.targetHit;
          return (
            <div
              key={`${t.id}-${direction}`}
              className="flex items-center justify-between text-xs font-mono tabular-nums border-b border-border/40 pb-1"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold truncate">{t.instrument}</span>
                <span className="text-muted-foreground text-[10px] uppercase">
                  {t.side}
                </span>
                {p.optionsDeferred && (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 h-4 border-amber-500/40 text-amber-400"
                  >
                    options deferred
                  </Badge>
                )}
                {isStop && (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 h-4"
                    style={{ borderColor: RED, color: RED }}
                  >
                    STOP
                  </Badge>
                )}
                {isTarget && (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 h-4"
                    style={{ borderColor: GREEN, color: GREEN }}
                  >
                    TARGET
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-right shrink-0">
                <span className="text-muted-foreground text-[10px]">
                  {direction === 'down' ? '-' : '+'}
                  {(p.appliedPct * 100).toFixed(2)}%
                </span>
                <span className="text-muted-foreground">
                  {p.hypotheticalPrice != null
                    ? fmtUsdCents(p.hypotheticalPrice)
                    : '—'}
                </span>
                <span
                  className="w-20 text-right"
                  style={{ color: pnlColor(p.projectedPnlUsd) }}
                >
                  {fmtUsd(p.projectedPnlUsd)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Scenario card
// ----------------------------------------------------------------------------

function tierAccent(tier: string): { color: string; icon: JSX.Element } {
  if (tier === 'MILD')
    return {
      color: '#3B82F6',
      icon: <Activity className="h-4 w-4" />,
    };
  if (tier === 'MODERATE')
    return {
      color: '#F59E0B',
      icon: <AlertTriangle className="h-4 w-4" />,
    };
  return { color: RED, icon: <Zap className="h-4 w-4" /> };
}

function ScenarioCard({ result }: { result: ScenarioResult }) {
  const { scenario, downLeg, upLeg } = result;
  const accent = tierAccent(scenario.name);

  // Headline: the worst of the two legs — this is what a risk desk stares at.
  const worstTotal = Math.min(result.totalPnlDown, result.totalPnlUp);
  const bestTotal = Math.max(result.totalPnlDown, result.totalPnlUp);
  const headlineColor = pnlColor(worstTotal) ?? MUTED;

  return (
    <Card className="p-4 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span style={{ color: accent.color }}>{accent.icon}</span>
          <h3 className="font-bold tracking-wide" style={{ color: accent.color }}>
            {scenario.name}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">{scenario.headline}</p>
        {scenario.vixSpike && (
          <p className="text-[11px] text-amber-400/80">
            Assumes coincident VIX spike (narrative only — not modeled in P&L).
          </p>
        )}
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border/50 p-2">
          <div className="text-[10px] uppercase text-muted-foreground">
            Worst-leg P&L
          </div>
          <div
            className="text-lg font-bold font-mono tabular-nums"
            style={{ color: headlineColor }}
          >
            {fmtUsd(worstTotal)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            best leg {fmtUsd(bestTotal)}
          </div>
        </div>
        <div className="rounded border border-border/50 p-2">
          <div className="text-[10px] uppercase text-muted-foreground">
            Implied max drawdown
          </div>
          <div
            className="text-lg font-bold font-mono tabular-nums"
            style={{ color: pnlColor(result.maxDrawdownUsd) ?? MUTED }}
          >
            {fmtUsd(result.maxDrawdownUsd)}
          </div>
        </div>
        <div className="rounded border border-border/50 p-2">
          <div className="text-[10px] uppercase text-muted-foreground">
            Stops (down / up)
          </div>
          <div className="text-base font-mono tabular-nums">
            <span style={{ color: RED }}>{result.stopOutsDown}</span>
            <span className="text-muted-foreground"> / </span>
            <span style={{ color: RED }}>{result.stopOutsUp}</span>
          </div>
        </div>
        <div className="rounded border border-border/50 p-2">
          <div className="text-[10px] uppercase text-muted-foreground">
            Targets (down / up)
          </div>
          <div className="text-base font-mono tabular-nums">
            <span style={{ color: GREEN }}>{result.targetsDown}</span>
            <span className="text-muted-foreground"> / </span>
            <span style={{ color: GREEN }}>{result.targetsUp}</span>
          </div>
        </div>
      </div>

      {result.optionsDeferredCount > 0 && (
        <div className="text-[11px] text-amber-400/80 border border-amber-500/20 bg-amber-500/5 rounded px-2 py-1">
          {result.optionsDeferredCount} option position(s) skipped — greeks and
          delta evolution not modeled.
        </div>
      )}

      {/* Per-position detail */}
      <div className="space-y-3">
        <LegTable title="Down move" projections={downLeg} direction="down" />
        <LegTable title="Up move" projections={upLeg} direction="up" />
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Custom scenario builder
// ----------------------------------------------------------------------------

const CUSTOM_SLOT_COUNT = 5;

function emptyLegs(): CustomLeg[] {
  return Array.from({ length: CUSTOM_SLOT_COUNT }, () => ({ ticker: '', pct: 0 }));
}

function CustomBuilder({
  trades,
}: {
  trades: ReturnType<typeof useStressScenarios>['trades'];
}) {
  const [legs, setLegs] = useState<CustomLeg[]>(emptyLegs());
  const [ranLegs, setRanLegs] = useState<CustomLeg[] | null>(null);

  const result = useMemo(() => {
    if (!ranLegs) return null;
    return runCustomScenario(ranLegs, trades);
  }, [ranLegs, trades]);

  function updateLeg(idx: number, patch: Partial<CustomLeg>) {
    setLegs(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function run() {
    setRanLegs(legs.map(l => ({ ...l })));
  }

  function reset() {
    setLegs(emptyLegs());
    setRanLegs(null);
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="space-y-1">
        <h3 className="font-bold">Custom scenario</h3>
        <p className="text-xs text-muted-foreground">
          Enter up to {CUSTOM_SLOT_COUNT} ticker / % move pairs. Only instruments
          in your open book are matched; unknown tickers are listed but not
          scored. Signed % allowed (e.g. -3, +5).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2">
        {legs.map((leg, i) => (
          <div key={i} className="space-y-1">
            <label className="text-[10px] uppercase text-muted-foreground">
              Slot {i + 1}
            </label>
            <Input
              placeholder="Ticker"
              value={leg.ticker}
              onChange={e => updateLeg(i, { ticker: e.target.value.toUpperCase() })}
              className="h-8 text-sm font-mono"
              maxLength={8}
            />
            <Input
              type="number"
              step="0.1"
              placeholder="% move"
              value={Number.isFinite(leg.pct) ? leg.pct : 0}
              onChange={e =>
                updateLeg(i, { pct: parseFloat(e.target.value) || 0 })
              }
              className="h-8 text-sm font-mono"
            />
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Button onClick={run} size="sm">
          Run scenario
        </Button>
        <Button onClick={reset} size="sm" variant="ghost">
          Reset
        </Button>
      </div>

      {result && (
        <div className="pt-2 space-y-3 border-t border-border/50">
          {result.matchedCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open positions matched the tickers you entered.
              {result.unmatchedTickers.length > 0 && (
                <> Unmatched: {result.unmatchedTickers.join(', ')}.</>
              )}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="rounded border border-border/50 p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">
                    Total book P&L
                  </div>
                  <div
                    className="text-lg font-bold font-mono tabular-nums"
                    style={{ color: pnlColor(result.totalPnlUsd) ?? MUTED }}
                  >
                    {fmtUsd(result.totalPnlUsd)}
                  </div>
                </div>
                <div className="rounded border border-border/50 p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">
                    Matched positions
                  </div>
                  <div className="text-lg font-mono tabular-nums">
                    {result.matchedCount}
                  </div>
                </div>
                <div className="rounded border border-border/50 p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">
                    Stops hit
                  </div>
                  <div
                    className="text-lg font-mono tabular-nums"
                    style={{ color: result.stopOuts > 0 ? RED : undefined }}
                  >
                    {result.stopOuts}
                  </div>
                </div>
                <div className="rounded border border-border/50 p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">
                    Targets hit
                  </div>
                  <div
                    className="text-lg font-mono tabular-nums"
                    style={{ color: result.targetsHit > 0 ? GREEN : undefined }}
                  >
                    {result.targetsHit}
                  </div>
                </div>
              </div>

              {result.optionsDeferredCount > 0 && (
                <p className="text-[11px] text-amber-400/80">
                  {result.optionsDeferredCount} option position(s) deferred.
                </p>
              )}
              {result.unmatchedTickers.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  No open positions for:{' '}
                  <span className="font-mono">
                    {result.unmatchedTickers.join(', ')}
                  </span>
                </p>
              )}

              <LegTable
                title="Custom legs"
                projections={result.projections}
                direction={result.totalPnlUsd < 0 ? 'down' : 'up'}
              />
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Page
// ----------------------------------------------------------------------------

export default function Stress() {
  const { results, trades, isLoading, error, hasOpenPositions } =
    useStressScenarios();

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="space-y-2">
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Command Station
        </Link>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Stress Scenarios</h1>
            <p className="text-sm text-muted-foreground">
              Projected book P&L under hypothetical moves. Pure projection — no
              greeks, no correlation modeling, no delta evolution.
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase text-muted-foreground">
              Open positions
            </div>
            <div className="text-2xl font-mono tabular-nums">
              {trades.length}
            </div>
          </div>
        </div>
      </div>

      {isLoading && (
        <Card className="p-6 text-sm text-muted-foreground">
          Loading open positions…
        </Card>
      )}

      {error && (
        <Card className="p-6 text-sm" style={{ color: RED }}>
          Failed to load trades: {error}
        </Card>
      )}

      {!isLoading && !hasOpenPositions && (
        <Card className="p-6 text-sm text-muted-foreground">
          No open positions — nothing to stress.
        </Card>
      )}

      {hasOpenPositions && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {results.map(r => (
              <ScenarioCard key={r.scenario.id} result={r} />
            ))}
          </div>

          <CustomBuilder trades={trades} />

          <div className="text-[11px] text-muted-foreground border-t border-border/50 pt-3 leading-relaxed">
            <span className="font-semibold">Correlation note:</span> Scenarios
            assume specified moves happen independently. In reality, correlated
            moves (SPY down → all tech down) amplify impact. Use MODERATE as
            baseline for real risk.
          </div>
        </>
      )}
    </div>
  );
}
