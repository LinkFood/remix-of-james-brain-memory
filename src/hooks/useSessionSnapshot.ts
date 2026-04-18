/**
 * useSessionSnapshot — client-side state reconstruction at `virtualNow`.
 *
 * Given the already-fetched session timeline events and the session's book row,
 * reconstructs what the system looked like at an arbitrary moment in the
 * session: which trades were open, what Claude's most recent read was, which
 * alerts were still live (horizon_end > virtualNow), which biases were active,
 * the latest combo verdicts, and an interpolated book-equity estimate.
 *
 * No network calls. Everything is a filter over data already in memory. Pure
 * `useMemo` so scrubbing a slider re-derives cheaply.
 *
 * The book-equity interpolation: ct_book rows are daily snapshots (one row per
 * session_date). We approximate mid-session equity as:
 *
 *   starting_balance
 *     + realized_pnl from CLOSED trades whose closed_at <= virtualNow
 *     + mark-to-market on OPEN trades at virtualNow (live_pnl_usd if fresh,
 *       else 0 — we don't have tick-level history).
 *
 * This is an approximation: it snaps realized P&L to trade-close events rather
 * than smoothly interpolating, and the mark-to-market for currently open
 * positions uses whatever live_pnl_usd is most-recently written (which is a
 * single value, not a time series). Good enough for a scrubber label; not a
 * replay engine.
 */
import { useMemo } from 'react';
import type { TimelineEvent } from './useSessionTimeline';
import type { CtBookRow } from './useCoTraderData';

export interface OpenTradeAtTime {
  id: string;
  instrument: string;
  side: string;
  entry_price: number | null;
  opened_at: string;
  thesis: string | null;
  conviction: number | null;
  /** milliseconds between opened_at and virtualNow (positive). */
  age_ms: number;
}

export interface ActiveAlertAtTime {
  id: string;
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  glance: string | null;
  created_at: string;
  horizon_end: string | null;
  /** milliseconds since alert was emitted. */
  age_ms: number;
}

export interface ActiveBiasAtTime {
  id: string;
  label: string;
  first_seen_at: string;
  retired_at: string | null;
}

export interface ComboVerdictAtTime {
  id: string;
  created_at: string;
  source: 'alert' | 'flag';
  combo: Record<string, unknown> | null;
  /** milliseconds between event created_at and virtualNow. */
  age_ms: number;
}

export interface SessionSnapshot {
  virtualNow: string;
  open_trades_at_time: OpenTradeAtTime[];
  claude_read: {
    status_line: string;
    created_at: string;
    age_ms: number;
  } | null;
  /** Most recent observation glance[0] — drives the "3 minutes ago Claude wrote:" line. */
  last_observation: {
    text: string;
    created_at: string;
    age_ms: number;
  } | null;
  active_alerts: ActiveAlertAtTime[];
  active_biases: ActiveBiasAtTime[];
  book_equity_at_time: number | null;
  book_realized_at_time: number;
  combo_verdicts: ComboVerdictAtTime[];
  /** Convenience counters for the state card. */
  counts: {
    open_trades: number;
    active_alerts: number;
    active_biases: number;
  };
}

interface Args {
  virtualNow: string | null;
  events: TimelineEvent[];
  sessionBook: CtBookRow | null;
  biases?: ActiveBiasAtTime[];
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Combo verdicts: look at ALERT+FLAG events within 30min of virtualNow. */
const COMBO_WINDOW_MS = 30 * 60 * 1000;

export function useSessionSnapshot({
  virtualNow,
  events,
  sessionBook,
  biases = [],
}: Args): SessionSnapshot | null {
  return useMemo(() => {
    if (!virtualNow) return null;
    const nowMs = toMs(virtualNow);
    if (nowMs === null) return null;

    const open_trades_at_time: OpenTradeAtTime[] = [];
    let book_realized_at_time = 0;
    let open_trade_unrealized_usd = 0;

    let claude_read: SessionSnapshot['claude_read'] = null;
    let last_observation: SessionSnapshot['last_observation'] = null;
    const active_alerts: ActiveAlertAtTime[] = [];
    const combo_verdicts: ComboVerdictAtTime[] = [];

    // Iterate events once — they're already sorted ascending.
    for (const e of events) {
      const tMs = toMs(e.time);
      if (tMs === null) continue;

      if (e.kind === 'HEARTBEAT' && tMs <= nowMs) {
        const d = e.detail as Record<string, unknown>;
        claude_read = {
          status_line: (d.status_line as string) ?? e.summary ?? '—',
          created_at: e.time,
          age_ms: nowMs - tMs,
        };
      } else if (e.kind === 'OBSERVATION' && tMs <= nowMs) {
        const d = e.detail as Record<string, unknown>;
        const glance = d.glance as string[] | null | undefined;
        const text =
          (Array.isArray(glance) && glance[0]) ||
          (d.observation as string) ||
          e.summary ||
          '—';
        last_observation = {
          text,
          created_at: e.time,
          age_ms: nowMs - tMs,
        };
      } else if (e.kind === 'ALERT' && tMs <= nowMs) {
        const d = e.detail as Record<string, unknown>;
        // horizon_end may not be on the select; fall back to horizon string +
        // a conservative 2h assumption if it's absent.
        const horizonEndIso =
          (d.horizon_end as string | null | undefined) ??
          (d.horizon_end_at as string | null | undefined) ??
          null;
        const endMs = horizonEndIso ? toMs(horizonEndIso) : tMs + 2 * 60 * 60 * 1000;
        if (endMs !== null && endMs > nowMs) {
          const glanceArr = d.glance as string[] | null | undefined;
          active_alerts.push({
            id: e.id,
            instruments: (d.instruments as string[]) ?? [],
            direction: (d.direction as string) ?? null,
            conviction: (d.conviction as number | null) ?? null,
            glance: (Array.isArray(glanceArr) && glanceArr[0]) || null,
            created_at: e.time,
            horizon_end: horizonEndIso,
            age_ms: nowMs - tMs,
          });
        }
        // Combo verdict capture (from alerts)
        if (Math.abs(nowMs - tMs) <= COMBO_WINDOW_MS) {
          const combo =
            (d.combo as Record<string, unknown> | null) ??
            (d.combo_verdict as Record<string, unknown> | null) ??
            null;
          if (combo) {
            combo_verdicts.push({
              id: e.id,
              created_at: e.time,
              source: 'alert',
              combo,
              age_ms: nowMs - tMs,
            });
          }
        }
      } else if (e.kind === 'FLAG' && tMs <= nowMs) {
        const d = e.detail as Record<string, unknown>;
        if (Math.abs(nowMs - tMs) <= COMBO_WINDOW_MS) {
          const combo =
            (d.combo as Record<string, unknown> | null) ??
            (d.combo_verdict as Record<string, unknown> | null) ??
            null;
          if (combo) {
            combo_verdicts.push({
              id: e.id,
              created_at: e.time,
              source: 'flag',
              combo,
              age_ms: nowMs - tMs,
            });
          }
        }
      } else if (e.kind === 'TRADE_COMMIT' && tMs <= nowMs) {
        const d = e.detail as Record<string, unknown>;
        const closedAtMs = toMs((d.closed_at as string | null) ?? null);
        const isOpenAtVirtualNow = closedAtMs === null || closedAtMs > nowMs;
        if (isOpenAtVirtualNow) {
          open_trades_at_time.push({
            id: e.id,
            instrument: (d.instrument as string) ?? e.subject ?? '?',
            side: (d.side as string) ?? '?',
            entry_price: (d.entry_price as number | null) ?? null,
            opened_at: e.time,
            thesis: (d.thesis as string) ?? null,
            conviction: (d.conviction as number | null) ?? null,
            age_ms: nowMs - tMs,
          });
          // Live-P&L approximation for currently open positions.
          const liveUsd = d.live_pnl_usd as number | null | undefined;
          if (typeof liveUsd === 'number' && Number.isFinite(liveUsd)) {
            open_trade_unrealized_usd += liveUsd;
          }
        } else if (closedAtMs !== null && closedAtMs <= nowMs) {
          // Trade was already closed by virtualNow — realized P&L contributes.
          const realizedUsd = d.realized_pnl_usd as number | null | undefined;
          if (typeof realizedUsd === 'number' && Number.isFinite(realizedUsd)) {
            book_realized_at_time += realizedUsd;
          }
        }
      }
    }

    // Book equity: starting + realized-so-far + mark-to-market-open.
    let book_equity_at_time: number | null = null;
    if (sessionBook?.starting_balance != null) {
      book_equity_at_time =
        sessionBook.starting_balance + book_realized_at_time + open_trade_unrealized_usd;
    }

    // Biases: active if first_seen_at <= virtualNow AND (retired_at IS NULL OR retired_at > virtualNow).
    const active_biases: ActiveBiasAtTime[] = biases.filter((b) => {
      const seenMs = toMs(b.first_seen_at);
      if (seenMs === null || seenMs > nowMs) return false;
      const retiredMs = toMs(b.retired_at);
      return retiredMs === null || retiredMs > nowMs;
    });

    return {
      virtualNow,
      open_trades_at_time,
      claude_read,
      last_observation,
      active_alerts,
      active_biases,
      book_equity_at_time,
      book_realized_at_time,
      combo_verdicts,
      counts: {
        open_trades: open_trades_at_time.length,
        active_alerts: active_alerts.length,
        active_biases: active_biases.length,
      },
    };
  }, [virtualNow, events, sessionBook, biases]);
}
