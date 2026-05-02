/**
 * /pulse — Pulse v2 regime view.
 *
 * Five panels stacked top-down:
 *   1. Market-wide tile + 10 ticker tiles (current regime grid)
 *   2. Per-ticker raw signals table (momentum, breadth, trajectory, dispersion, duration, macro)
 *   3. Recent transitions log (last 7 days, classification-change only, capped 50)
 *   4. Analog frequency table (next-bucket distribution from last 30d market-wide)
 *   5. (sub-section) v1 Pulse score timeline — kept as a collapsible footer for
 *      continuity, the v2 page is the new primary view.
 *
 * Backend: ct_regime_classifications + ct_regime_signals + ct_regime_history
 * via useRegimeState. Refresh 30s; bell-cross invalidation handled globally
 * by useMarketHoursTrigger mounted in App root.
 *
 * Weekend fallback: if dataAnchor > 15 min old, banner explains we're showing
 * the last captured state and the page still renders the same panels using
 * that anchor. ct_regime_history's append-only model means transitions/analogs
 * are session-stable across the weekend.
 *
 * C1 protection: this file does not touch specialist context — it reads
 * regime tables only. Specialist recall property unaffected.
 */

import { useMemo } from 'react';
import {
  Activity,
  ChevronUp,
  ChevronDown,
  Equal,
  AlertTriangle,
  Clock,
  Calendar as CalendarIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  REGIME_WATCHLIST,
  MARKET_KEY,
  useRegimeState,
  classificationStyle,
  formatClassificationLabel,
  formatAge,
  formatBucketTime,
  formatBucketDate,
  macroBadges,
  type RegimeClassificationRow,
  type RegimeSignalRow,
  type RegimeConfigRow,
  type Trajectory,
} from '@/hooks/useRegimeState';

// ---- Sub-components (file-local) -------------------------------------------

function TrajectoryIcon({ trajectory }: { trajectory: Trajectory | null }) {
  if (trajectory === 'accelerating') {
    return <ChevronUp className="w-4 h-4 text-emerald-400" aria-label="accelerating" />;
  }
  if (trajectory === 'decaying') {
    return <ChevronDown className="w-4 h-4 text-red-400" aria-label="decaying" />;
  }
  if (trajectory === 'steady') {
    return <Equal className="w-4 h-4 text-amber-300" aria-label="steady" />;
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  // Color tracks confidence — low = muted, high = solid
  const color =
    pct >= 70 ? 'bg-emerald-500'
    : pct >= 50 ? 'bg-sky-500'
    : pct >= 30 ? 'bg-amber-500'
    : 'bg-muted';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-12 rounded bg-muted/40 overflow-hidden">
        <div className={cn('h-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">{Math.round(pct)}</span>
    </div>
  );
}

function ClassificationBadge({
  name,
  description,
  size = 'sm',
}: {
  name: string;
  description?: string | null;
  size?: 'sm' | 'lg';
}) {
  const style = classificationStyle(name);
  const label = formatClassificationLabel(name);
  const content = (
    <Badge
      variant="outline"
      className={cn(
        'font-mono border',
        style.badge,
        size === 'lg' ? 'text-sm py-1 px-2.5' : 'text-[10px] py-0 px-1.5',
      )}
    >
      {label}
    </Badge>
  );
  if (!description) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{content}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function MacroBadges({ row }: { row: RegimeSignalRow | null | undefined }) {
  const badges = macroBadges(row?.macro_proximity ?? null);
  if (badges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge
          key={b.label}
          variant="outline"
          className="text-[10px] py-0 px-1.5 font-mono border-purple-500/40 bg-purple-500/10 text-purple-300"
        >
          {b.label} {b.days}d
        </Badge>
      ))}
    </div>
  );
}

// ---- Panels ----------------------------------------------------------------

function MarketTile({
  classification,
  signals,
  config,
}: {
  classification: RegimeClassificationRow | null;
  signals: RegimeSignalRow | null;
  config: Map<string, RegimeConfigRow>;
}) {
  if (!classification) {
    return (
      <Card className="p-6 border-dashed">
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Activity className="w-4 h-4" />
          Market-wide regime — awaiting first capture
        </div>
      </Card>
    );
  }
  const style = classificationStyle(classification.classification);
  const desc = config.get(classification.classification)?.description ?? null;
  const dur = signals?.duration_minutes ?? null;
  return (
    <Card className={cn('p-5 border-2', style.border, style.bg)}>
      <div className="flex flex-wrap items-start gap-4 justify-between">
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-mono">
            Market-wide regime
          </div>
          <ClassificationBadge
            name={classification.classification}
            description={desc}
            size="lg"
          />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <ConfidenceBar value={classification.confidence} />
            {dur != null && (
              <span className="flex items-center gap-1 tabular-nums">
                <Clock className="w-3 h-3" />
                {dur}m in regime
              </span>
            )}
            <span className="tabular-nums">
              bucket {formatBucketTime(classification.bucket_ts)} ET
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <SignalKv label="momentum" value={fmt2(signals?.momentum)} accent={signSign(signals?.momentum)} />
          <SignalKv label="breadth" value={fmt2(signals?.breadth)} />
          <SignalKv
            label="trajectory"
            valueNode={
              <span className="flex items-center gap-1">
                <TrajectoryIcon trajectory={signals?.trajectory ?? null} />
                <span className="font-mono">{signals?.trajectory ?? '—'}</span>
              </span>
            }
          />
          <SignalKv label="dispersion" value={fmt2(signals?.dispersion)} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wider">macro</span>
        <MacroBadges row={signals} />
        {macroBadges(signals?.macro_proximity ?? null).length === 0 && (
          <span className="text-[11px] text-muted-foreground italic">
            no events within 5 trading days
          </span>
        )}
      </div>
    </Card>
  );
}

function SignalKv({
  label,
  value,
  valueNode,
  accent,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  accent?: 'pos' | 'neg' | undefined;
}) {
  const cls =
    accent === 'pos' ? 'text-emerald-300'
    : accent === 'neg' ? 'text-red-300'
    : 'text-foreground';
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
        {label}
      </span>
      {valueNode ? valueNode : (
        <span className={cn('font-mono tabular-nums', cls)}>{value ?? '—'}</span>
      )}
    </div>
  );
}

function TickerGrid({
  perTickerLatest,
  perTickerSignals,
  config,
}: {
  perTickerLatest: Map<string, RegimeClassificationRow>;
  perTickerSignals: Map<string, RegimeSignalRow>;
  config: Map<string, RegimeConfigRow>;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
      {REGIME_WATCHLIST.map((t) => {
        const cls = perTickerLatest.get(t);
        const sig = perTickerSignals.get(t);
        const style = cls ? classificationStyle(cls.classification) : classificationStyle('unknown');
        const desc = cls ? config.get(cls.classification)?.description ?? null : null;
        return (
          <Card
            key={t}
            className={cn('p-2.5 border space-y-1.5', style.border, style.bg)}
          >
            <div className="flex items-center justify-between">
              <span className="font-mono font-semibold text-sm">{t}</span>
              <TrajectoryIcon trajectory={sig?.trajectory ?? null} />
            </div>
            {cls ? (
              <>
                <ClassificationBadge name={cls.classification} description={desc} />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <ConfidenceBar value={cls.confidence} />
                  <span className="font-mono tabular-nums">
                    {fmt2(sig?.momentum)}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-[11px] text-muted-foreground italic">no capture yet</div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function SignalsTable({
  perTickerLatest,
  perTickerSignals,
  marketSignals,
}: {
  perTickerLatest: Map<string, RegimeClassificationRow>;
  perTickerSignals: Map<string, RegimeSignalRow>;
  marketSignals: RegimeSignalRow | null;
}) {
  const marketBreadth = marketSignals?.breadth;
  const marketDispersion = marketSignals?.dispersion;
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">Ticker</TableHead>
            <TableHead className="w-32">Regime</TableHead>
            <TableHead className="text-right">Momentum</TableHead>
            <TableHead className="text-right">Breadth</TableHead>
            <TableHead className="w-28">Trajectory</TableHead>
            <TableHead className="text-right">Dispersion</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Macro</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* Market-wide row first */}
          <TableRow className="bg-muted/30">
            <TableCell className="font-mono font-semibold">MARKET</TableCell>
            <TableCell>
              {perTickerLatest.get(MARKET_KEY) ? (
                <ClassificationBadge name={perTickerLatest.get(MARKET_KEY)!.classification} />
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </TableCell>
            <TableCell className={cn('text-right font-mono tabular-nums', momentumClass(marketSignals?.momentum))}>
              {fmt2(marketSignals?.momentum)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {fmt2(marketSignals?.breadth)}
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1 text-xs">
                <TrajectoryIcon trajectory={marketSignals?.trajectory ?? null} />
                <span className="font-mono">{marketSignals?.trajectory ?? '—'}</span>
              </span>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {fmt2(marketSignals?.dispersion)}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {marketSignals?.duration_minutes ?? '—'}
              {marketSignals?.duration_minutes != null && <span className="text-muted-foreground">m</span>}
            </TableCell>
            <TableCell>
              <MacroBadges row={marketSignals} />
            </TableCell>
          </TableRow>
          {REGIME_WATCHLIST.map((t) => {
            const cls = perTickerLatest.get(t);
            const sig = perTickerSignals.get(t);
            return (
              <TableRow key={t}>
                <TableCell className="font-mono">{t}</TableCell>
                <TableCell>
                  {cls ? (
                    <ClassificationBadge name={cls.classification} />
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
                <TableCell className={cn('text-right font-mono tabular-nums', momentumClass(sig?.momentum))}>
                  {fmt2(sig?.momentum)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground italic">
                  {/* Per-ticker breadth typically N/A — fall back to market */}
                  {sig?.breadth != null ? fmt2(sig.breadth) : (
                    <span title="per-ticker breadth N/A — showing market-wide">
                      ({fmt2(marketBreadth)})
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-1 text-xs">
                    <TrajectoryIcon trajectory={sig?.trajectory ?? null} />
                    <span className="font-mono">{sig?.trajectory ?? '—'}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground italic">
                  {sig?.dispersion != null ? fmt2(sig.dispersion) : (
                    <span title="per-ticker dispersion N/A — showing market-wide">
                      ({fmt2(marketDispersion)})
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {sig?.duration_minutes ?? '—'}
                  {sig?.duration_minutes != null && <span className="text-muted-foreground">m</span>}
                </TableCell>
                <TableCell>
                  <MacroBadges row={sig} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

function TransitionsPanel({
  transitions,
}: {
  transitions: ReturnType<typeof useRegimeState>['transitions'];
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, typeof transitions>();
    for (const t of transitions) {
      const day = formatBucketDate(t.created_at);
      const arr = map.get(day) ?? [];
      arr.push(t);
      map.set(day, arr);
    }
    return Array.from(map.entries());
  }, [transitions]);

  if (transitions.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        No regime transitions in the last 7 days. Live transitions begin landing
        once classification capture has run for at least two adjacent buckets.
      </Card>
    );
  }

  return (
    <Card className="p-4 max-h-96 overflow-y-auto space-y-3">
      {grouped.map(([day, list]) => (
        <div key={day}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono mb-1">
            {day}
          </div>
          <ul className="space-y-1">
            {list.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 text-xs font-mono"
              >
                <span className="text-muted-foreground tabular-nums w-12">
                  {formatBucketTime(t.created_at)}
                </span>
                <span className="font-semibold w-16">
                  {t.tickerKey === MARKET_KEY ? 'MARKET' : t.ticker}
                </span>
                <span className="text-muted-foreground">
                  {formatClassificationLabel(t.from_classification)}
                </span>
                <span className="text-foreground">→</span>
                <ClassificationBadge name={t.to_classification} />
                <span className="text-muted-foreground tabular-nums ml-auto">
                  conf {Math.round(t.confidence)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function AnalogsPanel({
  marketLatest,
  analogFrequencyByPrior,
}: {
  marketLatest: RegimeClassificationRow | null;
  analogFrequencyByPrior: ReturnType<typeof useRegimeState>['analogFrequencyByPrior'];
}) {
  if (!marketLatest) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        Analog frequency unavailable — no market-wide classification yet.
      </Card>
    );
  }
  const freq = analogFrequencyByPrior.get(marketLatest.classification);
  if (!freq || freq.totalOccurrences === 0) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">
        Current regime is{' '}
        <ClassificationBadge name={marketLatest.classification} />. No prior
        occurrences in the last 30 days yet — analog distribution will populate
        as more captures accumulate.
      </Card>
    );
  }
  return (
    <Card className="p-4 space-y-3">
      <div className="text-sm">
        Current regime <ClassificationBadge name={freq.prior} />{' '}
        — observed{' '}
        <span className="font-mono tabular-nums">{freq.totalOccurrences}</span>{' '}
        prior buckets in the last 30d. Next-bucket distribution:
      </div>
      <ul className="space-y-1.5">
        {freq.distribution.slice(0, 6).map((d) => (
          <li key={d.next} className="flex items-center gap-3 text-xs">
            <div className="w-44 flex justify-end">
              <ClassificationBadge name={d.next} />
            </div>
            <div className="flex-1 h-1.5 bg-muted/40 rounded overflow-hidden">
              <div
                className={cn('h-full', classificationStyle(d.next).dot)}
                style={{ width: `${d.pct}%` }}
              />
            </div>
            <span className="font-mono tabular-nums w-20 text-right">
              {d.count}× ({d.pct.toFixed(0)}%)
            </span>
          </li>
        ))}
      </ul>
      <div className="text-[10px] text-muted-foreground">
        Frequency table only — true cosine analog search via{' '}
        <code className="text-[10px]">search_ct_regime_analogs</code> RPC requires
        a Voyage embedding round-trip and is deferred to v2.1.
      </div>
    </Card>
  );
}

// ---- Helpers --------------------------------------------------------------

function fmt2(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function signSign(n: number | null | undefined): 'pos' | 'neg' | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  if (n > 0.05) return 'pos';
  if (n < -0.05) return 'neg';
  return undefined;
}

function momentumClass(n: number | null | undefined): string {
  const s = signSign(n);
  if (s === 'pos') return 'text-emerald-300';
  if (s === 'neg') return 'text-red-300';
  return '';
}

// ---- Page ------------------------------------------------------------------

export default function Pulse() {
  const state = useRegimeState();
  const {
    marketLatest,
    marketSignals,
    perTickerLatest,
    perTickerSignals,
    configByName,
    transitions,
    analogFrequencyByPrior,
    dataAnchor,
    ageMinutes,
    isStale,
    isLoading,
    isError,
  } = state;

  const stalenessCopy = useMemo(() => {
    if (!dataAnchor) return null;
    if (!isStale) return null;
    return `Last regime capture ${formatAge(ageMinutes)}. Showing that snapshot — auto-resumes when capture cron resumes.`;
  }, [dataAnchor, isStale, ageMinutes]);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-[1600px] mx-auto p-4 space-y-4">
          {/* Header */}
          <header className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                <span>Pulse</span>
                <Badge variant="outline" className="font-mono text-[10px]">v2</Badge>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Regime classification across the 10-ticker universe. Each 5-min bucket
                tags one of {configByName.size || '—'} active regimes with a confidence
                score and rationale. Transitions and analog frequency back-test what
                the current regime usually resolves into.
              </p>
            </div>
            <div className="text-right text-[11px] text-muted-foreground tabular-nums space-y-0.5">
              <div className="flex items-center gap-1.5 justify-end">
                <Clock className="w-3 h-3" />
                {dataAnchor ? `anchor ${formatBucketTime(dataAnchor)} ET` : 'awaiting first capture'}
              </div>
              <div>{ageMinutes != null ? formatAge(ageMinutes) : ''}</div>
            </div>
          </header>

          {/* Staleness banner */}
          {stalenessCopy && (
            <Card className="p-3 border-amber-500/40 bg-amber-500/5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-100">{stalenessCopy}</div>
            </Card>
          )}

          {/* Error banner */}
          {isError && (
            <Card className="p-3 border-red-500/40 bg-red-500/5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="text-xs text-red-200">
                One of the regime queries failed. Page renders best-effort from the
                queries that succeeded. Refresh to retry.
              </div>
            </Card>
          )}

          {/* 1. Current regime panel */}
          <section className="space-y-3">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-mono flex items-center gap-2">
              <span>Current regime</span>
              {isLoading && !marketLatest && <span className="italic">loading…</span>}
            </h2>
            <MarketTile
              classification={marketLatest}
              signals={marketSignals}
              config={configByName}
            />
            <TickerGrid
              perTickerLatest={perTickerLatest}
              perTickerSignals={perTickerSignals}
              config={configByName}
            />
          </section>

          {/* 2. Signals panel */}
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-mono">
              Signals
            </h2>
            <SignalsTable
              perTickerLatest={perTickerLatest}
              perTickerSignals={perTickerSignals}
              marketSignals={marketSignals}
            />
          </section>

          {/* 3. Recent transitions */}
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-mono flex items-center gap-2">
              <CalendarIcon className="w-3 h-3" />
              <span>Transitions — last 7 days</span>
              <Badge variant="outline" className="text-[10px] font-mono">
                {transitions.length}
              </Badge>
            </h2>
            <TransitionsPanel transitions={transitions} />
          </section>

          {/* 4. Analogs frequency table */}
          <section className="space-y-2">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-mono">
              Analogs — how does this regime usually resolve?
            </h2>
            <AnalogsPanel
              marketLatest={marketLatest}
              analogFrequencyByPrior={analogFrequencyByPrior}
            />
          </section>

          {/* Footer note */}
          <div className="text-[10px] text-muted-foreground leading-relaxed pt-2">
            Refresh: 30s during RTH, slower off-hours. Bell-cross invalidates all queries
            globally. ct-regime-capture writes one row per (ticker, bucket) every 5 min RTH.
            Adding a new classification is a row INSERT in <code className="text-[10px]">ct_regime_config</code>.
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
