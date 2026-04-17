/**
 * GexHeatmap — TRACE-style gamma landscape over time.
 *
 * X-axis: snapshot timestamps (left=old → right=new)
 * Y-axis: strike prices (top=high → bottom=low)
 * Cell color: net gamma. Purple (neg) → white (flip) → red (pos) per
 * SpotGamma convention.
 * Overlay: green line = underlying price moving across the gamma landscape.
 *
 * Hard ATM bound: strikes rendered = nearest 40 to current price, capped at
 * ±15% range. Doesn't trust the DB `is_atm_band` flag on its own; filters
 * client-side from actual latest price so a stale/wrong flag can't pollute.
 *
 * Axis labels: real strike ticks on both sides, HH:mm time ticks along bottom.
 */
import { useEffect, useRef, useMemo, useState } from 'react';
import { useGexTimeseries } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';

interface Props {
  defaultTicker?: string;
  availableTickers?: string[];
  hours?: number;
}

const WATCHLIST_CHOICES = ['SPX', 'SPY', 'QQQ', 'IWM', 'AAPL', 'NVDA', 'META', 'TSLA'];
const MAX_STRIKES = 40;               // cap strikes rendered
const ATM_PCT = 0.15;                  // ±15% hard bound on top of nearest-N

function gexColor(net: number, max: number): string {
  if (!Number.isFinite(net) || max === 0) return 'rgba(120,120,120,0.08)';
  const t = Math.max(-1, Math.min(1, net / max));
  if (t > 0) {
    const g = Math.round(255 - Math.min(200, t * 200));
    const a = 0.15 + Math.min(0.85, Math.abs(t) * 0.85);
    return `rgba(255,${g},${g},${a})`;
  }
  const r = Math.round(255 - Math.min(130, -t * 130));
  const g = Math.round(255 - Math.min(200, -t * 200));
  const a = 0.15 + Math.min(0.85, Math.abs(t) * 0.85);
  return `rgba(${r},${g},255,${a})`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtStrike(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  return n.toFixed(0);
}

export function GexHeatmap({ defaultTicker = 'SPX', availableTickers = WATCHLIST_CHOICES, hours = 6 }: Props) {
  const [ticker, setTicker] = useState(defaultTicker);
  const { data, isLoading } = useGexTimeseries(ticker, hours);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const grid = useMemo(() => {
    if (!data || data.length === 0) return null;

    // 1. Find latest underlying price per ticker, used as the ATM anchor
    const byTsPrice = new Map<string, number>();
    for (const r of data) {
      if (r.underlying_price != null && !byTsPrice.has(r.snapshot_at)) {
        byTsPrice.set(r.snapshot_at, r.underlying_price);
      }
    }
    const sortedTs = Array.from(new Set(data.map(r => r.snapshot_at))).sort();
    const latestPrice = (() => {
      for (let i = sortedTs.length - 1; i >= 0; i--) {
        const p = byTsPrice.get(sortedTs[i]);
        if (p != null) return p;
      }
      return null;
    })();
    if (latestPrice === null) return null;

    // 2. Hard ATM bound from actual price — ignore DB is_atm_band flag
    const low = latestPrice * (1 - ATM_PCT);
    const high = latestPrice * (1 + ATM_PCT);

    // 3. Collect strikes in band, then keep nearest N to ATM
    const strikeSet = new Set<number>();
    for (const r of data) {
      if (r.strike >= low && r.strike <= high) strikeSet.add(r.strike);
    }
    const allStrikes = Array.from(strikeSet).sort((a, b) => a - b);
    const nearestN = [...allStrikes]
      .sort((a, b) => Math.abs(a - latestPrice) - Math.abs(b - latestPrice))
      .slice(0, MAX_STRIKES);
    const strikes = nearestN.sort((a, b) => b - a);     // top=high, bottom=low
    if (strikes.length === 0) return null;
    const strikeFilter = new Set(strikes);

    // 4. Build cell lookup, find |max| for color scale
    const cell = new Map<string, number>();
    let maxAbs = 0;
    for (const r of data) {
      if (!strikeFilter.has(r.strike)) continue;
      const net = r.net_gex ?? 0;
      cell.set(`${r.snapshot_at}|${r.strike}`, net);
      if (Math.abs(net) > maxAbs) maxAbs = Math.abs(net);
    }

    return {
      timestamps: sortedTs,
      strikes,
      cell,
      maxAbs,
      priceAt: byTsPrice,
      latestPrice,
      minStrike: strikes[strikes.length - 1],
      maxStrike: strikes[0],
    };
  }, [data]);

  // Canvas render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const { timestamps, strikes, cell, maxAbs, priceAt, minStrike, maxStrike } = grid;
    const cellW = rect.width / timestamps.length;
    const cellH = rect.height / strikes.length;

    // Cells
    for (let x = 0; x < timestamps.length; x++) {
      for (let y = 0; y < strikes.length; y++) {
        const net = cell.get(`${timestamps[x]}|${strikes[y]}`) ?? 0;
        ctx.fillStyle = gexColor(net, maxAbs);
        ctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // Flip zero-line (row where net ≈ zero, approximated as halfway between
    // ATM band) — for visual anchor
    // (skip — price line serves this role)

    // Price line
    ctx.strokeStyle = 'rgba(34, 197, 94, 1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let x = 0; x < timestamps.length; x++) {
      const px = priceAt.get(timestamps[x]);
      if (px == null) continue;
      const range = maxStrike - minStrike;
      if (range === 0) continue;
      const yNorm = (maxStrike - px) / range;
      const y = Math.max(0, Math.min(rect.height, yNorm * rect.height));
      const xpx = x * cellW + cellW / 2;
      if (!started) { ctx.moveTo(xpx, y); started = true; }
      else ctx.lineTo(xpx, y);
    }
    ctx.stroke();

    // Price dot at latest
    if (started) {
      const lastIdx = timestamps.length - 1;
      const lastPx = priceAt.get(timestamps[lastIdx]) ?? grid.latestPrice;
      const range = maxStrike - minStrike;
      if (range > 0 && lastPx != null) {
        const yNorm = (maxStrike - lastPx) / range;
        const y = Math.max(0, Math.min(rect.height, yNorm * rect.height));
        const xpx = lastIdx * cellW + cellW / 2;
        ctx.fillStyle = 'rgba(34, 197, 94, 1)';
        ctx.beginPath();
        ctx.arc(xpx, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [grid]);

  // Compute strike ticks to show — top, middle(s), bottom
  const strikeTicks = useMemo(() => {
    if (!grid) return [];
    const n = grid.strikes.length;
    if (n <= 4) return grid.strikes;
    const idxs = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
    return idxs.map(i => grid.strikes[i]);
  }, [grid]);

  const timeTicks = useMemo(() => {
    if (!grid) return [] as Array<{ label: string; pct: number }>;
    const n = grid.timestamps.length;
    if (n === 0) return [];
    if (n === 1) return [{ label: fmtTime(grid.timestamps[0]), pct: 50 }];
    const count = Math.min(6, n);
    const out: Array<{ label: string; pct: number }> = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i * (n - 1)) / (count - 1));
      out.push({ label: fmtTime(grid.timestamps[idx]), pct: (idx / (n - 1)) * 100 });
    }
    return out;
  }, [grid]);

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">GEX Heatmap</span>
        <span className="text-[10px] text-muted-foreground">time × strike × dealer gamma</span>
        {grid && (
          <span className="text-[10px] text-muted-foreground ml-2">
            spot <span className="text-foreground font-medium">${grid.latestPrice.toFixed(2)}</span>
          </span>
        )}
        <div className="flex items-center gap-0.5 ml-auto">
          {availableTickers.map(t => (
            <button
              key={t}
              onClick={() => setTicker(t)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                ticker === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="h-[340px] flex items-center justify-center text-xs text-muted-foreground">loading…</div>
      ) : !grid ? (
        <div className="h-[340px] flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
          No gamma time-series yet for {ticker}. Each watcher cycle (every 30min during market hours) adds one column.
        </div>
      ) : (
        <div>
          {/* Chart with axis gutters */}
          <div className="flex">
            {/* Left strike axis */}
            <div className="w-12 shrink-0 relative" style={{ height: 340 }}>
              {strikeTicks.map((s, i) => {
                const idx = grid.strikes.indexOf(s);
                const pct = (idx / (grid.strikes.length - 1)) * 100;
                return (
                  <div
                    key={i}
                    className="absolute right-1 text-[9px] text-muted-foreground"
                    style={{ top: `${pct}%`, transform: 'translateY(-50%)' }}
                  >
                    ${fmtStrike(s)}
                  </div>
                );
              })}
            </div>

            {/* Canvas */}
            <div className="flex-1 relative" style={{ height: 340 }}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            </div>

            {/* Right strike axis (mirrored) */}
            <div className="w-12 shrink-0 relative" style={{ height: 340 }}>
              {strikeTicks.map((s, i) => {
                const idx = grid.strikes.indexOf(s);
                const pct = (idx / (grid.strikes.length - 1)) * 100;
                const isAtmStrike = Math.abs(s - grid.latestPrice) / grid.latestPrice < 0.005;
                return (
                  <div
                    key={i}
                    className={`absolute left-1 text-[9px] ${isAtmStrike ? 'text-green-400 font-semibold' : 'text-muted-foreground'}`}
                    style={{ top: `${pct}%`, transform: 'translateY(-50%)' }}
                  >
                    ${fmtStrike(s)}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Time axis */}
          <div className="flex px-12">
            <div className="flex-1 relative h-5 border-t border-border">
              {timeTicks.map((t, i) => (
                <div
                  key={i}
                  className="absolute text-[9px] text-muted-foreground top-1"
                  style={{ left: `${t.pct}%`, transform: 'translateX(-50%)' }}
                >
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="px-3 py-1.5 border-t border-border bg-muted/20 flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">
              {grid.timestamps.length} snapshot{grid.timestamps.length === 1 ? '' : 's'} · {grid.strikes.length} strikes ATM±15% · |Γ|max {grid.maxAbs.toExponential(1)}
            </span>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-2" style={{ background: 'rgba(180, 55, 255, 0.75)' }} />
              <span className="text-muted-foreground">−Γ</span>
              <span className="inline-block w-3 h-2" style={{ background: 'rgba(255, 255, 255, 0.3)' }} />
              <span className="text-muted-foreground">flip</span>
              <span className="inline-block w-3 h-2" style={{ background: 'rgba(255, 55, 55, 0.75)' }} />
              <span className="text-muted-foreground">+Γ</span>
              <span className="text-muted-foreground/70 ml-2">green line = spot</span>
            </div>
          </div>

          {/* Density warning */}
          {grid.timestamps.length < 10 && (
            <div className="px-3 py-1.5 border-t border-border bg-amber-500/5 text-[10px] text-amber-400/80">
              Sparse data: {grid.timestamps.length} snapshot{grid.timestamps.length === 1 ? '' : 's'}. TRACE-style heatmaps need 30+ columns. Tomorrow's 9am-4pm ET session will add ~14 at current 30min cadence; bumping watcher to 3min cadence would give ~130/day.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
