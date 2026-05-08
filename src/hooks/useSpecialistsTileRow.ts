/**
 * useSpecialistsTileRow — composite hook for the v2 Tape command-center
 * 10-tile specialist row.
 *
 * Returns one row per watchlist ticker with:
 *   - current_price  (latest spot from ct_ticker_snapshots)
 *   - conviction     (latest ct_specialist_reads.conviction)
 *   - direction      (latest ct_specialist_reads.direction_lean)
 *   - delta_1h       (current conviction minus conviction from row prior to 1h ago)
 *   - last_fired_at  (latest specialist_reads.updated_at)
 *
 * Single batched query per source. Polls every 30s — specialist reads land on
 * cron cadence, snapshots refresh ~5min, so 30s is the right TTL for a
 * glance-first command-center surface.
 *
 * Bundle Phase 2 organMetadata pattern: each row includes `as_of` per source
 * so consumers can render staleness if a ticker hasn't fired recently.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'QQQ', 'SPY', 'IWM',
] as const;

export type WatchlistTicker = typeof WATCHLIST[number];

export type TileDirection = 'bullish' | 'bearish' | 'neutral' | 'mixed' | null;

export interface SpecialistTile {
  ticker: WatchlistTicker;
  current_price: number | null;
  price_as_of: string | null;
  conviction: number | null;
  direction: TileDirection;
  delta_1h: number | null;
  last_fired_at: string | null;
}

interface SpecialistReadRaw {
  ticker: string;
  updated_at: string;
  direction_lean: string;
  conviction: number | string;
}

interface TickerSnapshotRaw {
  ticker: string;
  spot: number | string | null;
  snapshot_ts: string | null;
}

function normalizeDirection(s: string | null | undefined): TileDirection {
  if (s === 'bullish' || s === 'bearish' || s === 'neutral' || s === 'mixed') return s;
  return null;
}

export function useSpecialistsTileRow() {
  return useQuery<SpecialistTile[]>({
    queryKey: ['tape-v2-specialists-tile-row'],
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
    queryFn: async () => {
      const oneHourAgoIso = new Date(Date.now() - 60 * 60_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;

      // Fetch enough recent reads to cover both "latest" and ">=1h ago" per
      // ticker. 200 rows across 10 tickers covers ~20 reads per ticker, which
      // exceeds normal RTH cadence (1 wakeup/hour). Falls back gracefully if
      // some tickers have fewer rows.
      const readsResp = await sb.from('ct_specialist_reads')
        .select('ticker, updated_at, direction_lean, conviction')
        .in('ticker', [...WATCHLIST])
        .order('updated_at', { ascending: false })
        .limit(200);
      const readsRows: SpecialistReadRaw[] = Array.isArray(readsResp.data) ? readsResp.data : [];

      // Latest snapshot per ticker for spot. Distinct-on isn't directly available
      // through PostgREST so we pull recent rows and reduce client-side.
      const snapsResp = await sb.from('ct_ticker_snapshots')
        .select('ticker, spot, snapshot_ts')
        .in('ticker', [...WATCHLIST])
        .order('snapshot_ts', { ascending: false })
        .limit(200);
      const snapsRows: TickerSnapshotRaw[] = Array.isArray(snapsResp.data) ? snapsResp.data : [];

      const latestSnap = new Map<string, TickerSnapshotRaw>();
      for (const s of snapsRows) {
        if (!latestSnap.has(s.ticker)) latestSnap.set(s.ticker, s);
      }

      const tiles: SpecialistTile[] = WATCHLIST.map((ticker) => {
        const tickerReads = readsRows.filter((r) => r.ticker === ticker);
        const latest = tickerReads[0] ?? null;
        const priorBeforeHour = tickerReads.find((r) => r.updated_at <= oneHourAgoIso) ?? null;

        const latestConv = latest ? Number(latest.conviction) : null;
        const priorConv = priorBeforeHour ? Number(priorBeforeHour.conviction) : null;
        const delta = latestConv != null && priorConv != null ? latestConv - priorConv : null;

        const snap = latestSnap.get(ticker) ?? null;
        const spot = snap?.spot != null ? Number(snap.spot) : null;

        return {
          ticker,
          current_price: spot != null && Number.isFinite(spot) ? spot : null,
          price_as_of: snap?.snapshot_ts ?? null,
          conviction: latestConv != null && Number.isFinite(latestConv) ? latestConv : null,
          direction: latest ? normalizeDirection(latest.direction_lean) : null,
          delta_1h: delta != null && Number.isFinite(delta) ? delta : null,
          last_fired_at: latest?.updated_at ?? null,
        };
      });

      return tiles;
    },
  });
}

export const TAPE_V2_WATCHLIST = WATCHLIST;
