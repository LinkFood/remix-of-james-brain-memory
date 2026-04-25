/**
 * ContractPnLChip — small inline pill that renders the live contract-axis P&L
 * state for one ct_contract_tracks row.
 *
 * Drops into tape rows (one per print) without redesigning the row. Click
 * opens the ContractDrillSheet (parent owns that state). Color-coded by
 * track_status and current_contract_pct so a quick scan tells you which
 * prints printed money and which got run over.
 *
 * Empty state (track === null) renders a thin "—" pill so the column never
 * stretches the row when the tracker hasn't seen this alert yet.
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Target, Clock, Hourglass,
} from 'lucide-react';
import {
  fmtPctFromFraction, fmtPctMagnitude,
  type ContractTrackRow, type ContractTrackStatus,
} from '@/hooks/useContractTracks';

interface Props {
  track: ContractTrackRow | null;
  onClick?: () => void;
  size?: 'sm' | 'md';
}

interface ChipShape {
  className: string;       // background/text/border
  icon: React.ComponentType<{ className?: string }>;
  primary: string;         // main label, e.g. "+47%"
  secondary?: string | null; // optional trailing label, e.g. "↑ peak +120%"
  title?: string;          // tooltip
}

function shapeFor(track: ContractTrackRow | null): ChipShape | null {
  if (!track) return null;
  const status: ContractTrackStatus = track.track_status;
  const cur = track.current_contract_pct;        // signed fraction
  const peak = track.peak_contract_pct;          // absolute fraction
  const dd = track.max_drawdown_pct;             // absolute fraction

  // Color helper for emerald-vs-rose by sign of current.
  const liveColor = (signed: number | null) =>
    signed != null && signed >= 0
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : 'bg-rose-500/15 text-rose-300 border-rose-500/30';

  const peakSecondary = (cur: number | null, peak: number) => {
    if (peak <= 0) return null;
    if (cur != null && Math.abs(cur) >= peak) return null;
    return `↑ ${fmtPctMagnitude(peak)}`;
  };

  switch (status) {
    case 'WIN':
      return {
        className: 'bg-emerald-500/30 text-emerald-200 border-emerald-500/60 font-bold',
        icon: Target,
        primary: `WIN ${fmtPctMagnitude(peak)}`,
        secondary: dd > 0.05 ? `−${(dd * 100).toFixed(0)}% dd` : null,
        title: `Hit WIN threshold. Peak ${fmtPctMagnitude(peak)} at ${track.peak_contract_at ?? 'n/a'}`,
      };
    case 'LOSS':
      return {
        className: 'bg-rose-500/30 text-rose-200 border-rose-500/60 font-bold',
        icon: TrendingDown,
        primary: `LOSS ${fmtPctFromFraction(cur ?? -dd)}`,
        secondary: peak > 0 ? `peak +${(peak * 100).toFixed(0)}%` : null,
        title: `Hit LOSS threshold. Drawdown ${(dd * 100).toFixed(0)}%`,
      };
    case 'EXPIRED_WIN':
      return {
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
        icon: Clock,
        primary: `EXP WIN`,
        secondary: peak > 0 ? `peak ${fmtPctMagnitude(peak)}` : null,
        title: `Expired in WIN territory. Peak ${fmtPctMagnitude(peak)}`,
      };
    case 'EXPIRED_LOSS':
      return {
        className: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
        icon: Clock,
        primary: `EXP LOSS`,
        secondary: dd > 0 ? `dd −${(dd * 100).toFixed(0)}%` : null,
        title: `Expired in LOSS territory. Drawdown ${(dd * 100).toFixed(0)}%`,
      };
    case 'EXPIRED_FLAT':
      return {
        className: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
        icon: Clock,
        primary: 'EXP FLAT',
        secondary: peak > 0 ? `peak ${fmtPctMagnitude(peak)}` : null,
        title: `Expired without crossing WIN or LOSS threshold`,
      };
    case 'STALE':
      return {
        className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
        icon: Hourglass,
        primary: 'STALE',
        secondary: null,
        title: `No fresh quote. Last seen ${track.last_quoted_at ?? 'never'}`,
      };
    case 'WORKING':
    default:
      return {
        className: liveColor(cur),
        icon: cur != null && cur >= 0 ? TrendingUp : TrendingDown,
        primary: cur != null ? fmtPctFromFraction(cur) : '·',
        secondary: peakSecondary(cur, peak),
        title:
          cur != null
            ? `Working · current ${fmtPctFromFraction(cur)}, peak ${fmtPctMagnitude(peak)}`
            : `Working · awaiting first quote`,
      };
  }
}

export function ContractPnLChip({ track, onClick, size = 'sm' }: Props) {
  const shape = shapeFor(track);

  // Render a thin neutral placeholder when there's no track row yet.
  if (!shape) {
    const base = (
      <Badge
        variant="outline"
        className={cn(
          'font-mono tabular-nums text-muted-foreground border-border/50 bg-transparent',
          size === 'sm' ? 'text-[10px] px-1.5 py-0 h-[18px]' : 'text-xs px-2 py-0.5',
          onClick ? 'cursor-pointer hover:opacity-80' : '',
        )}
        onClick={onClick}
        title="No contract track yet"
      >
        —
      </Badge>
    );
    return base;
  }

  const Icon = shape.icon;
  const sizing =
    size === 'sm'
      ? 'text-[10px] px-1.5 py-0 h-[18px] gap-1'
      : 'text-xs px-2 py-0.5 gap-1';

  return (
    <Badge
      variant="outline"
      onClick={onClick}
      title={shape.title}
      className={cn(
        'inline-flex items-center font-mono tabular-nums whitespace-nowrap',
        sizing,
        shape.className,
        onClick ? 'cursor-pointer hover:opacity-80' : '',
      )}
    >
      <Icon className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      <span>{shape.primary}</span>
      {shape.secondary && (
        <span className={cn('opacity-70 font-normal', size === 'sm' ? 'text-[9px]' : 'text-[10px]')}>
          {shape.secondary}
        </span>
      )}
    </Badge>
  );
}
