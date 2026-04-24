import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface OiShiftRow {
  ticker: string;
  option_symbol: string;
  strike: number | null;
  expiry: string | null;
  side: string | null;
  oi_today: number | null;
  oi_yesterday: number | null;
  delta_contracts: number | null;
  delta_pct: number | null;
  dollars_at_risk: number | null;
  spot: number | null;
  distance_from_spot_pct: number | null;
  snap_date: string | null;
  snap_slot: string | null;
}

export function useOvernightPositioning(ticker?: string, limit = 20) {
  return useQuery<OiShiftRow[]>({
    queryKey: ['overnight-positioning', ticker ?? 'all', limit],
    staleTime: 300_000,
    refetchInterval: 300_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_top_oi_shifts', {
        p_limit: limit,
        p_ticker: ticker ?? null,
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as OiShiftRow[];
    },
  });
}

/** Normalize side from RPC to 'call' | 'put' | null.
 *  RPC returns 'call'/'put' lowercase OR 'C'/'P' — handle both. */
export function normalizeSide(side: string | null | undefined): 'call' | 'put' | null {
  if (!side) return null;
  const u = side.toUpperCase();
  if (u.startsWith('C')) return 'call';
  if (u.startsWith('P')) return 'put';
  return null;
}

/** Compact dollar formatter: $9.6M / $467M / $1.2B. */
export function formatDollarsCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Signed contract count with thousands separators. */
export function formatDeltaContracts(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('en-US')}`;
}

/** "Mar 28" / "5/22" — short expiry label. */
export function formatExpiryShort(iso: string | null | undefined): string {
  if (!iso) return '-';
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(5).replace('-', '/');
  }
}

/**
 * OTM/ITM label relative to side.
 *   CALL: strike > spot → OTM (positive distance)
 *   PUT : strike < spot → OTM (positive distance)
 * distance_from_spot_pct comes as raw (strike - spot) / spot fraction or pct
 * depending on how the RPC computed it — we treat it as a pct number (e.g. 2.1
 * for 2.1%). If it comes as a fraction (0.021) we detect that and scale.
 */
export function formatMoneyness(
  distancePct: number | null | undefined,
  side: 'call' | 'put' | null,
): { label: string; moneyness: 'OTM' | 'ITM' | null } {
  if (distancePct == null || !Number.isFinite(distancePct) || side == null) {
    return { label: '-', moneyness: null };
  }
  // Detect fractional vs percent representation.
  const pct = Math.abs(distancePct) < 1 ? distancePct * 100 : distancePct;
  // (strike - spot) / spot sign tells us which side of spot the strike is on.
  const strikeAboveSpot = pct > 0;
  const moneyness: 'OTM' | 'ITM' =
    (side === 'call' && strikeAboveSpot) || (side === 'put' && !strikeAboveSpot)
      ? 'OTM'
      : 'ITM';
  const sign = pct >= 0 ? '+' : '';
  return { label: `${sign}${pct.toFixed(1)}% ${moneyness}`, moneyness };
}
