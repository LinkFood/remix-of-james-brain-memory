/**
 * useBookEquityCurve — full ct_book history (ascending) + today's ct_trades
 * for the equity-curve visual. 60s refresh.
 *
 * ct_book.starting_balance / ending_balance / realized_pnl / unrealized_pnl /
 * high_water_mark / max_drawdown_pct / wins / losses / trades_count / goal_hit
 * are all populated by ct-book-manager (every 15min) and ct-book-eod-close (4pm ET).
 *
 * ct_trades does NOT store a live/unrealized P&L per trade — intraday P&L is
 * rolled up to ct_book.unrealized_pnl. So per-trade open rows show "unresolved"
 * for running P&L; only closed trades have realized_pnl_pct/usd.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CtBookRow, CtTradeRow } from './useCoTraderData';

export interface EquityPoint {
  date: string;             // session_date (YYYY-MM-DD)
  label: string;            // short label for x-axis (MM/DD)
  balance: number;          // ending_balance OR starting + realized + unrealized (live)
  starting: number;         // session starting_balance
  hwm: number;              // running all-time HWM up to and including this session
  isToday: boolean;         // last row is today's intraday tick if open
}

export interface BookEquityCurve {
  history: CtBookRow[];             // all rows, asc by session_date
  todayTrades: CtTradeRow[];        // today's trades (open + closed)
  points: EquityPoint[];            // chart-ready points
  stats: {
    starting: number;               // $10,000 seed
    current: number;                // latest balance (intraday if today is open)
    currentDelta: number;           // current - starting, $
    currentPct: number;             // (current - starting) / starting * 100
    hwm: number;                    // all-time high water mark
    drawdownPct: number;            // current vs hwm, negative when below
    sessions: number;               // count of ct_book rows
    wins: number;                   // sum of wins across sessions
    losses: number;                 // sum of losses
    winRate: number;                // wins / (wins + losses)
    trades: number;                 // sum of trades_count
    bestSession: { date: string; pnl: number } | null;
    worstSession: { date: string; pnl: number } | null;
    todayRealizedUsd: number;
    todayUnrealizedUsd: number;
    todayTotalUsd: number;
    todayPct: number;               // today total / today starting
  };
}

const STARTING_SEED = 10_000;

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

export function useBookEquityCurve() {
  return useQuery<BookEquityCurve>({
    queryKey: ['book_equity_curve'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const todayStr = new Date().toISOString().slice(0, 10);

      const [bookRes, tradesRes] = await Promise.all([
        supabase
          .from('ct_book')
          .select('*')
          .order('session_date', { ascending: true }),
        supabase
          .from('ct_trades')
          .select('*')
          .eq('session_date', todayStr)
          .order('created_at', { ascending: true }),
      ]);

      if (bookRes.error) throw bookRes.error;
      if (tradesRes.error) throw tradesRes.error;

      const history = (bookRes.data ?? []) as CtBookRow[];
      const todayTrades = (tradesRes.data ?? []) as CtTradeRow[];

      // Build chart points. For today (if session not closed), use live balance:
      //   live = starting_balance + realized_pnl + unrealized_pnl
      // Otherwise use ending_balance (closed) or starting_balance (morning).
      let runningHwm = STARTING_SEED;
      const points: EquityPoint[] = history.map(b => {
        const live = b.starting_balance + (b.realized_pnl ?? 0) + (b.unrealized_pnl ?? 0);
        const balance = b.ending_balance ?? live;
        runningHwm = Math.max(runningHwm, balance, b.high_water_mark ?? 0);
        const [, mm, dd] = b.session_date.split('-');
        return {
          date: b.session_date,
          label: `${mm}/${dd}`,
          balance,
          starting: b.starting_balance,
          hwm: runningHwm,
          isToday: isToday(b.session_date),
        };
      });

      // Seed the chart at $10k on day 0 so a single-session book still draws
      // a line from the origin rather than a lone dot.
      if (points.length > 0 && points[0].balance !== STARTING_SEED) {
        const first = points[0];
        points.unshift({
          date: 'seed',
          label: 'start',
          balance: STARTING_SEED,
          starting: STARTING_SEED,
          hwm: STARTING_SEED,
          isToday: false,
        });
        // Don't let the synthetic seed pull HWM below the real first session
        void first;
      }

      // Stats
      const current = points.length > 0 ? points[points.length - 1].balance : STARTING_SEED;
      const hwm = points.length > 0 ? points[points.length - 1].hwm : STARTING_SEED;
      const currentDelta = current - STARTING_SEED;
      const currentPct = (currentDelta / STARTING_SEED) * 100;
      const drawdownPct = hwm > 0 ? ((current - hwm) / hwm) * 100 : 0;

      const realSessions = history; // exclude synthetic seed from session count
      const sessions = realSessions.length;
      const wins = realSessions.reduce((s, b) => s + (b.wins ?? 0), 0);
      const losses = realSessions.reduce((s, b) => s + (b.losses ?? 0), 0);
      const trades = realSessions.reduce((s, b) => s + (b.trades_count ?? 0), 0);
      const winRate = wins + losses > 0 ? wins / (wins + losses) : 0;

      // Best / worst session by realized P&L $
      let best: { date: string; pnl: number } | null = null;
      let worst: { date: string; pnl: number } | null = null;
      for (const b of realSessions) {
        const pnl = (b.ending_balance ?? b.starting_balance + (b.realized_pnl ?? 0) + (b.unrealized_pnl ?? 0)) - b.starting_balance;
        if (best === null || pnl > best.pnl) best = { date: b.session_date, pnl };
        if (worst === null || pnl < worst.pnl) worst = { date: b.session_date, pnl };
      }

      const todayRow = realSessions.find(b => b.session_date === todayStr) ?? null;
      const todayRealizedUsd = todayRow?.realized_pnl ?? 0;
      const todayUnrealizedUsd = todayRow?.unrealized_pnl ?? 0;
      const todayTotalUsd = todayRealizedUsd + todayUnrealizedUsd;
      const todayStarting = todayRow?.starting_balance ?? STARTING_SEED;
      const todayPct = todayStarting > 0 ? (todayTotalUsd / todayStarting) * 100 : 0;

      return {
        history,
        todayTrades,
        points,
        stats: {
          starting: STARTING_SEED,
          current,
          currentDelta,
          currentPct,
          hwm,
          drawdownPct,
          sessions,
          wins,
          losses,
          winRate,
          trades,
          bestSession: best,
          worstSession: worst,
          todayRealizedUsd,
          todayUnrealizedUsd,
          todayTotalUsd,
          todayPct,
        },
      };
    },
  });
}
