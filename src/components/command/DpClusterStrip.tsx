/**
 * DpClusterStrip — always-on flag pills for ct_dp_clusters.
 *
 * Sibling of SweepClusterStrip. Surfaces the 5 most recent dark-pool cluster
 * flags from the last 15 minutes, regardless of any downstream filter state.
 * Separate strip (not merged with sweeps) because:
 *   - Sweeps = directional (call/put dominant), colored green/red/magenta.
 *   - Dark pool blocks = institutional, non-directional. Size-only signal.
 *   Mixing them conflates "directional conviction" with "whale footprint".
 *
 * Click a pill → navigates to /ticker/:symbol (TickerTerminal). Previously
 * fired the `ct:darkpool:filter` window event to focus DarkPoolTape; swapped
 * to navigation to match the rest of the ticker-drill-down surface.
 *
 * No new UW calls — consumes ct_dp_clusters populated by ct-dp-cluster,
 * which is itself a pure internal scan of ct_dark_pool_prints.
 */
import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Square } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { FreshnessChip } from '@/components/FreshnessChip';
import { useDpClusters, type DpCluster } from '@/hooks/useCoTraderData';

// Institutional slate / muted-blue — DP prints aren't directional, so we
// don't use the call/put vocabulary. Base tone at score=65; higher scores
// brighten toward the attention-grabbing end.
const BASE = '#64748b';     // slate-500 — attention_score 65 (count 3)
const MID  = '#94a3b8';     // slate-400 — attention_score 75 (count 4)
const HOT  = '#cbd5e1';     // slate-300 — attention_score 85 (count 5+)

function colorFor(score: number): string {
  if (score >= 85) return HOT;
  if (score >= 75) return MID;
  return BASE;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
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

interface PillProps {
  c: DpCluster;
}

const DpPill = memo(function DpPill({ c }: PillProps) {
  const bg = colorFor(c.attention_score);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={`/ticker/${c.ticker}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tabular-nums tracking-wide hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-white/30 transition-all shadow-sm"
            style={{ background: bg, color: '#000' }}
            aria-label={`${c.ticker} dark pool cluster — open ticker terminal`}
          >
            <Square className="w-3 h-3 fill-current" />
            <span>{c.ticker}</span>
            <span className="opacity-80">◼{c.print_count}</span>
            <span className="opacity-80">·</span>
            <span>{fmtMoney(c.total_notional)}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="bg-black/95 border-white/10 text-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1">
            {c.ticker} dark pool cluster · {relTime(c.created_at)} ago
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] tabular-nums">
            <span className="text-white/50">blocks</span>
            <span className="text-right">{c.print_count}</span>
            <span className="text-white/50">total notional</span>
            <span className="text-right">{fmtMoney(c.total_notional)}</span>
            <span className="text-white/50">largest</span>
            <span className="text-right">{fmtMoney(c.largest_single_notional)}</span>
            <span className="text-white/50">score</span>
            <span className="text-right">{c.attention_score}</span>
          </div>
          <div className="text-[9px] text-white/40 mt-1.5 pt-1.5 border-t border-white/10">
            click → open ticker terminal for {c.ticker}
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
 * Pills for the most recent dark-pool clusters. Hidden entirely when there
 * are none in the window — no placeholder chrome, so the strip disappears
 * during quiet markets rather than shouting "nothing".
 */
export const DpClusterStrip = memo(function DpClusterStrip({
  limit = 5,
  windowMinutes = 15,
}: Props) {
  const { data, isLoading } = useDpClusters(limit, windowMinutes);

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 text-[10px] text-muted-foreground">
        scanning dark pool clusters…
      </div>
    );
  }

  const clusters = data ?? [];
  if (clusters.length === 0) return null;

  // Most-recent cluster timestamp — clusters are ordered DESC by created_at
  // in the hook, so [0] is the newest signal in-window.
  const latestTs = clusters[0]?.created_at ?? null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/40 border border-white/5 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-wider text-white/40 shrink-0">
        Dark Pool
      </span>
      <div className="flex items-center gap-2 flex-nowrap">
        {clusters.map(c => <DpPill key={c.id} c={c} />)}
      </div>
      <FreshnessChip timestamp={latestTs} className="ml-auto shrink-0" />
    </div>
  );
});
