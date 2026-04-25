/**
 * ContractGradeChips — tight 4-badge cluster showing per-print contract_v1
 * horizon grades on /tape rows.
 *
 * One badge per horizon (30m / 2h / eod / +1d). Each badge encodes:
 *   - WIN    → emerald, e.g. "30m W +57%"
 *   - LOSS   → rose,    e.g. "30m L −83%"
 *   - FLAT   → slate,   e.g. "30m F"
 *   - empty  → muted "—" placeholder so column width never jitters as
 *              grades land asynchronously through the day.
 *
 * Different signal from <ContractPnLChip>: that chip shows the live state of
 * the contract right now (WORKING/WIN/LOSS/EXPIRED_*); these chips show what
 * the contract did at FIXED snapshot horizons. Both useful — sibling column
 * on the tape row.
 */

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  CONTRACT_GRADE_HORIZONS,
  type ContractGradeHorizon,
  type ContractGradeRow,
} from '@/hooks/useContractTracks';

interface Props {
  grades: ContractGradeRow[] | undefined;
  size?: 'xs' | 'sm';
}

const HORIZON_LABEL: Record<ContractGradeHorizon, string> = {
  '30m': '30m',
  '2h': '2h',
  eod: 'eod',
  plus1d: '+1d',
};

/** Compact signed % from a decimal fraction. 0.57 -> "+57%", -0.83 -> "−83%". */
function fmtSignedPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '−';
  return `${sign}${Math.abs(pct).toFixed(0)}%`;
}

interface ChipShape {
  label: string;
  className: string;
  title: string;
}

function shapeFor(horizon: ContractGradeHorizon, grade: ContractGradeRow | undefined): ChipShape {
  const horizonLabel = HORIZON_LABEL[horizon];

  if (!grade) {
    return {
      label: '—',
      className: 'bg-transparent text-muted-foreground/60 border-border/40',
      title: `${horizonLabel} horizon — not graded yet`,
    };
  }

  const moveLabel = fmtSignedPct(grade.actual_move_pct);

  switch (grade.grade) {
    case 'WIN':
      return {
        label: `${horizonLabel} W ${moveLabel}`.trim(),
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-semibold',
        title: `${horizonLabel} horizon — WIN, ${moveLabel} on contract`,
      };
    case 'LOSS':
      return {
        label: `${horizonLabel} L ${moveLabel}`.trim(),
        className: 'bg-rose-500/20 text-rose-300 border-rose-500/40 font-semibold',
        title: `${horizonLabel} horizon — LOSS, ${moveLabel} on contract`,
      };
    case 'FLAT':
    default:
      return {
        label: `${horizonLabel} F`,
        className: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
        title: `${horizonLabel} horizon — FLAT (${moveLabel || 'no move'})`,
      };
  }
}

export function ContractGradeChips({ grades, size = 'xs' }: Props) {
  // Index by horizon so we can render placeholders for missing ones in order.
  const byHorizon = new Map<ContractGradeHorizon, ContractGradeRow>();
  if (grades) {
    for (const g of grades) byHorizon.set(g.horizon, g);
  }

  const sizing =
    size === 'xs'
      ? 'text-[9px] px-1 py-0 h-[16px]'
      : 'text-[10px] px-1.5 py-0 h-[18px]';

  return (
    <div className="inline-flex items-center gap-0.5 font-mono tabular-nums whitespace-nowrap">
      {CONTRACT_GRADE_HORIZONS.map((h) => {
        const shape = shapeFor(h, byHorizon.get(h));
        return (
          <Badge
            key={h}
            variant="outline"
            title={shape.title}
            className={cn('inline-flex items-center', sizing, shape.className)}
          >
            {shape.label}
          </Badge>
        );
      })}
    </div>
  );
}
