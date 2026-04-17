import { useMemo } from 'react';
import { useLatestHeartbeat, useTheses } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GexMiniChart } from './GexMiniChart';

interface Wall {
  strike: number;
  gex: number;
  distance_pct: number;
}

interface CondensedTicker {
  ticker: string;
  price: number | null;
  call_wall: number | null;
  put_wall: number | null;
  gamma_flip: number | null;
  regime?: 'positive' | 'negative' | 'unknown';
  call_walls?: Wall[];
  put_walls?: Wall[];
  net_gamma_oi: number | null;
  total_call_gamma_oi: number | null;
  total_put_gamma_oi: number | null;
  put_call_volume_ratio: number | null;
  day_put_call_ratio: number | null;
  near_atm_strike_count: number;
  near_atm_strikes?: Array<{ strike: number; call_gex: number; put_gex: number; net: number }>;
}

const LABELS: Record<string, { group: string; note?: string }> = {
  SPY: { group: 'Index' }, QQQ: { group: 'Index' }, IWM: { group: 'Index' },
  AAPL: { group: 'Mag7' }, MSFT: { group: 'Mag7' }, GOOGL: { group: 'Mag7' },
  AMZN: { group: 'Mag7' }, META: { group: 'Mag7' }, NVDA: { group: 'Mag7' }, TSLA: { group: 'Mag7' },
  GLD:  { group: 'Macro', note: 'gold proxy' },
  USO:  { group: 'Macro', note: 'oil proxy' },
};

function fmtLarge(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n >= 100 ? n.toFixed(2) : n.toFixed(2);
}

function directionColor(d: string | undefined | null): string {
  switch (d) {
    case 'bullish':     return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'bearish':     return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'neutral':     return 'bg-muted/50 text-muted-foreground border-muted';
    case 'volatility':  return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    default:            return 'bg-muted/30 text-muted-foreground/70';
  }
}

function RegimeLine({ regime, price, flip }: { regime?: 'positive' | 'negative' | 'unknown'; price: number | null; flip: number | null }) {
  if (!regime || regime === 'unknown' || price == null || flip == null) return null;
  const pos = regime === 'positive';
  const distPct = ((price - flip) / flip) * 100;
  return (
    <div className={`flex items-center justify-between text-[10px] mb-1 px-1 py-0.5 rounded ${pos ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'}`}>
      <span className="font-semibold uppercase tracking-wider">
        {pos ? '+Γ · mean-revert' : '−Γ · momentum'}
      </span>
      <span className="text-foreground/60">
        {distPct >= 0 ? '+' : ''}{distPct.toFixed(1)}% vs flip
      </span>
    </div>
  );
}

function WallsRow({ label, walls, price, kind }: { label: string; walls: Wall[]; price: number | null; kind: 'call' | 'put' }) {
  if (walls.length === 0) {
    return <div className="text-muted-foreground/50">{label}: —</div>;
  }
  const color = kind === 'call' ? 'text-orange-400' : 'text-blue-400';
  return (
    <div className="flex items-center gap-1 overflow-hidden">
      <span className={`text-muted-foreground shrink-0 w-8 ${color}`}>{label}</span>
      {walls.slice(0, 3).map((w, i) => {
        const dist = price ? ((w.strike - price) / price) * 100 : 0;
        return (
          <span key={i} className="flex items-baseline gap-0.5 shrink-0">
            <span className="text-foreground/90 font-medium">${fmtPrice(w.strike)}</span>
            <span className="text-muted-foreground/60 text-[9px]">
              {dist >= 0 ? '+' : ''}{dist.toFixed(1)}%
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function TickerGrid() {
  const { data: heartbeat } = useLatestHeartbeat();
  const { data: theses } = useTheses();

  const tickers = useMemo(() => {
    const snap = (heartbeat?.current_reads as Record<string, unknown> | undefined)?._snapshot as Record<string, unknown> | undefined;
    const perTicker = (snap?.per_ticker ?? {}) as Record<string, CondensedTicker>;
    const thesesMap = new Map<string, ReturnType<typeof Object>>();
    for (const t of theses ?? []) thesesMap.set(t.instrument, t);
    return Object.entries(perTicker)
      .sort(([a], [b]) => {
        const groupOrder = ['Index', 'Mag7', 'Macro'];
        const ga = groupOrder.indexOf(LABELS[a]?.group ?? '');
        const gb = groupOrder.indexOf(LABELS[b]?.group ?? '');
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b);
      })
      .map(([ticker, state]) => ({ ticker, state, thesis: thesesMap.get(ticker) as { direction?: string; conviction?: number; up_case?: string; down_case?: string; watching?: string | null } | undefined }));
  }, [heartbeat, theses]);

  if (tickers.length === 0) {
    return (
      <Card className="p-6 text-center text-muted-foreground text-sm">
        No ticker state yet. Watcher cron fires next at weekday 13:00 UTC.
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {tickers.map(({ ticker, state, thesis }) => {
        const label = LABELS[ticker];
        const price = state.price;
        const near = price && state.call_wall ? ((state.call_wall - price) / price * 100) : null;
        return (
          <Card key={ticker} className="p-3 hover:border-primary/40 transition-colors">
            <div className="flex items-baseline justify-between mb-2">
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold text-foreground">{ticker}</span>
                {label && (
                  <span className="text-[10px] text-muted-foreground/80 uppercase tracking-wide">
                    {label.group}{label.note ? ` · ${label.note}` : ''}
                  </span>
                )}
              </div>
              <span className="text-base font-semibold text-foreground">${fmtPrice(price)}</span>
            </div>

            <RegimeLine regime={state.regime} price={state.price} flip={state.gamma_flip} />

            <GexMiniChart strikes={state.near_atm_strikes ?? []} price={price} flip={state.gamma_flip} />

            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] mt-1.5 mb-1">
              <WallsRow label="Calls" walls={state.call_walls ?? (state.call_wall ? [{strike: state.call_wall, gex: 0, distance_pct: 0}] : [])} price={state.price} kind="call" />
              <WallsRow label="Puts" walls={state.put_walls ?? (state.put_wall ? [{strike: state.put_wall, gex: 0, distance_pct: 0}] : [])} price={state.price} kind="put" />
            </div>

            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>Flip <span className="text-foreground/80 font-medium">${fmtPrice(state.gamma_flip)}</span></span>
              <span>Net Γ <span className={`font-medium ${(state.net_gamma_oi ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>{fmtLarge(state.net_gamma_oi)}</span></span>
            </div>

            {thesis ? (
              <div className="space-y-1 pt-2 border-t border-border">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${directionColor(thesis.direction)}`}>
                    {thesis.direction?.toUpperCase()}
                  </Badge>
                  {thesis.conviction != null && (
                    <span className="text-[10px] text-muted-foreground">conv {thesis.conviction}/5</span>
                  )}
                </div>
                {thesis.up_case && (
                  <div className="text-[11px] text-green-400/90">↑ {thesis.up_case}</div>
                )}
                {thesis.down_case && (
                  <div className="text-[11px] text-red-400/90">↓ {thesis.down_case}</div>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground/60 italic pt-2 border-t border-border">
                no thesis yet
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
