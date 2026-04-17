/**
 * SweepClusterStrip — always-on flag pills for ct_sweep_clusters.
 *
 * Surfaces the 5 most recent sweep clusters from the last 15 minutes,
 * regardless of any downstream filter state. Separate strip (not merged
 * into AlwaysOnFlagStrip) because:
 *   - Combo verdicts = structural state (GEX/flow score snapshots).
 *   - Sweep clusters = event bursts (time-windowed flow anomalies).
 *   Mixing them in one strip creates visual pressure and conflates
 *   "what is SPY right now" with "what just happened to NVDA".
 *
 * Click a pill → fires `ct:flowtape:filter` window event → FlowTape
 * focuses on that ticker. No prop-drilling through CommandStation.
 *
 * No new UW calls — consumes ct_sweep_clusters populated by ct-sweep-cluster,
 * which is itself a pure internal scan of ct_flow_alerts.
 */
import { memo } from 'react';
import { Zap } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useSweepClusters, type SweepCluster } from '@/hooks/useCoTraderData';

// James's TrendSpider color vocabulary.
const COLOR_CALL = '#00C853';
const COLOR_PUT = '#FF1744';
const COLOR_MIXED = '#E040FB';

function colorFor(side: SweepCluster['dominant_side']): string {
  switch (side) {
    case 'call': return COLOR_CALL;
    case 'put':  return COLOR_PUT;
    case 'mixed':
    default:     return COLOR_MIXED;
  }
}

function sideLabel(side: SweepCluster['dominant_side']): string {
  switch (side) {
    case 'call': return 'calls';
    case 'put':  return 'puts';
    case 'mixed':
    default:     return 'mixed';
  }
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const s = Math.max(0, Math.floor(d / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function focusFlowTape(ticker: string) {
  window.dispatchEvent(
    new CustomEvent('ct:flowtape:filter', { detail: { ticker } }),
  );
}

interface PillProps {
  c: SweepCluster;
}

const SweepPill = memo(function SweepPill({ c }: PillProps) {
  const bg = colorFor(c.dominant_side);
  const label = `${c.ticker} ◉${c.sweep_count} ${sideLabel(c.dominant_side)} ${fmtMoney(c.total_premium)}`;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => focusFlowTape(c.ticker)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tabular-nums tracking-wide hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all shadow-sm"
            style={{ background: bg, color: '#000' }}
            aria-label={`${c.ticker} sweep cluster — focus Flow Tape`}
          >
            <Zap className="w-3 h-3" />
            <span>{c.ticker}</span>
            <span className="opacity-80">◉{c.sweep_count}</span>
            <span className="opacity-80">·</span>
            <span>{sideLabel(c.dominant_side)}</span>
            <span className="opacity-80">·</span>
            <span>{fmtMoney(c.total_premium)}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
            {c.ticker} sweep cluster · {relTime(c.created_at)} ago
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] tabular-nums">
            <span className="text-white/50">sweeps</span>
            <span className="text-right">{c.sweep_count}</span>
            <span className="text-white/50">calls / puts</span>
            <span className="text-right">{c.call_count} / {c.put_count}</span>
            <span className="text-white/50">total prem</span>
            <span className="text-right">{fmtMoney(c.total_premium)}</span>
            <span className="text-white/50">largest</span>
            <span className="text-right">{fmtMoney(c.largest_single_premium)}</span>
            <span className="text-white/50">score</span>
            <span className="text-right">{c.attention_score}</span>
          </div>
          <div className="text-[9px] text-white/40 mt-1.5 pt-1.5 border-t border-white/10">
            click → filter Flow Tape to {c.ticker}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

interface Props {
  limit?: number;
  windowMinutes?: number;
}

/**
 * Pills for the most recent sweep clusters. Hidden entirely when there are
 * none in the window — no placeholder chrome, so the strip disappears during
 * quiet markets rather than shouting "nothing".
 */
export const SweepClusterStrip = memo(function SweepClusterStrip({
  limit = 5,
  windowMinutes = 15,
}: Props) {
  const { data, isLoading } = useSweepClusters(limit, windowMinutes);

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 text-[10px] text-muted-foreground">
        scanning sweep clusters…
      </div>
    );
  }

  const clusters = data ?? [];
  if (clusters.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-wider text-white/40 shrink-0">
        Sweeps
      </span>
      <div className="flex items-center gap-2 flex-nowrap">
        {clusters.map(c => <SweepPill key={c.id} c={c} />)}
      </div>
    </div>
  );
});
