/**
 * GexHeatmap — TRACE-style gamma landscape over time.
 *
 * X-axis: snapshot timestamps (most recent on right)
 * Y-axis: strike prices (highest on top)
 * Cell color: net gamma at that strike at that snapshot
 *   - Pink/red (positive) = dealer long = resistance zone
 *   - Purple/violet (negative) = dealer short = acceleration zone
 *   - Near-zero = white band = gamma flip zone
 * Overlay: underlying price as a line across time
 * Right edge: named level tabs — Call Wall, Gamma Flip, Put Wall
 *
 * Canvas-rendered for performance with 50×50+ cells. Legend + hover tooltip
 * via overlay div.
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

// Color interpolation: purple (negative) → white (zero) → red (positive)
function gexColor(net: number, max: number): string {
  if (!Number.isFinite(net) || max === 0) return 'rgba(120,120,120,0.1)';
  const t = Math.max(-1, Math.min(1, net / max));     // -1..1
  if (t > 0) {
    // white → red
    const r = 255;
    const g = Math.round(255 - Math.min(200, t * 200));
    const b = Math.round(255 - Math.min(200, t * 200));
    const a = 0.15 + Math.min(0.85, Math.abs(t) * 0.85);
    return `rgba(${r},${g},${b},${a})`;
  } else {
    // white → purple
    const r = Math.round(255 - Math.min(130, -t * 130));
    const g = Math.round(255 - Math.min(200, -t * 200));
    const b = 255;
    const a = 0.15 + Math.min(0.85, Math.abs(t) * 0.85);
    return `rgba(${r},${g},${b},${a})`;
  }
}

export function GexHeatmap({ defaultTicker = 'SPX', availableTickers = WATCHLIST_CHOICES, hours = 4 }: Props) {
  const [ticker, setTicker] = useState(defaultTicker);
  const [atmOnly, setAtmOnly] = useState(true);
  const { data, isLoading } = useGexTimeseries(ticker, hours);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const grid = useMemo(() => {
    if (!data || data.length === 0) return null;
    // Build unique timestamps + strikes
    const tsSet = new Set<string>();
    const strikeSet = new Set<number>();
    for (const r of data) {
      if (atmOnly && !r.is_atm_band) continue;
      tsSet.add(r.snapshot_at);
      strikeSet.add(r.strike);
    }
    const timestamps = Array.from(tsSet).sort();
    const strikes = Array.from(strikeSet).sort((a, b) => b - a);     // high → low (top to bottom)
    if (timestamps.length === 0 || strikes.length === 0) return null;

    // Build lookup
    const map = new Map<string, number>();
    let maxAbs = 0;
    for (const r of data) {
      if (atmOnly && !r.is_atm_band) continue;
      const net = r.net_gex ?? 0;
      map.set(`${r.snapshot_at}|${r.strike}`, net);
      if (Math.abs(net) > maxAbs) maxAbs = Math.abs(net);
    }

    // Price per timestamp (use highest-strike row's underlying)
    const priceAt = new Map<string, number>();
    for (const r of data) {
      if (!priceAt.has(r.snapshot_at) && r.underlying_price != null) {
        priceAt.set(r.snapshot_at, r.underlying_price);
      }
    }

    return { timestamps, strikes, map, maxAbs, priceAt };
  }, [data, atmOnly]);

  // Render canvas
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

    const { timestamps, strikes, map, maxAbs, priceAt } = grid;
    const cellW = rect.width / timestamps.length;
    const cellH = rect.height / strikes.length;

    // Paint cells
    for (let x = 0; x < timestamps.length; x++) {
      for (let y = 0; y < strikes.length; y++) {
        const net = map.get(`${timestamps[x]}|${strikes[y]}`) ?? 0;
        ctx.fillStyle = gexColor(net, maxAbs);
        ctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // Price line overlay — green
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let x = 0; x < timestamps.length; x++) {
      const px = priceAt.get(timestamps[x]);
      if (px == null) continue;
      // Map price to y — linear between strikes[0] (top) and strikes[last] (bottom)
      const top = strikes[0];
      const bot = strikes[strikes.length - 1];
      if (top === bot) continue;
      const normY = (top - px) / (top - bot);
      const y = normY * rect.height;
      const xpx = x * cellW + cellW / 2;
      if (!started) { ctx.moveTo(xpx, y); started = true; }
      else ctx.lineTo(xpx, y);
    }
    ctx.stroke();
  }, [grid]);

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">GEX Heatmap</span>
        <span className="text-[10px] text-muted-foreground">time × strike × dealer gamma</span>
        <div className="flex items-center gap-0.5 ml-auto">
          <button
            onClick={() => setAtmOnly(!atmOnly)}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
              atmOnly ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            ATM±10%
          </button>
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
        <div className="h-[320px] flex items-center justify-center text-xs text-muted-foreground">loading…</div>
      ) : !grid ? (
        <div className="h-[320px] flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
          No gamma time-series yet for {ticker}. Each watcher cycle writes one column — accumulating as crons run.
        </div>
      ) : (
        <div className="relative">
          <canvas ref={canvasRef} style={{ width: '100%', height: 320, display: 'block' }} />
          <div className="absolute inset-0 pointer-events-none flex items-center justify-between px-2 text-[9px] text-muted-foreground/70">
            <div className="flex flex-col justify-between h-full py-1">
              {grid.strikes.slice(0, 1).map(s => <span key="top">${s.toFixed(0)}</span>)}
              <span>{grid.strikes[Math.floor(grid.strikes.length / 2)]?.toFixed(0) ? `$${grid.strikes[Math.floor(grid.strikes.length / 2)].toFixed(0)}` : ''}</span>
              {grid.strikes.slice(-1).map(s => <span key="bot">${s.toFixed(0)}</span>)}
            </div>
            <div className="flex flex-col justify-between h-full py-1 items-end">
              {grid.strikes.slice(0, 1).map(s => <span key="top">${s.toFixed(0)}</span>)}
              <span>spot line (green)</span>
              {grid.strikes.slice(-1).map(s => <span key="bot">${s.toFixed(0)}</span>)}
            </div>
          </div>
          <div className="px-3 py-1.5 border-t border-border bg-muted/20 flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">
              {grid.timestamps.length} snapshots · {grid.strikes.length} strikes · |γ|max {grid.maxAbs.toExponential(1)}
            </span>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-2" style={{ background: 'rgba(180, 55, 255, 0.75)' }} />
              <span className="text-muted-foreground">−Γ</span>
              <span className="inline-block w-3 h-2" style={{ background: 'rgba(255, 255, 255, 0.3)' }} />
              <span className="text-muted-foreground">flip</span>
              <span className="inline-block w-3 h-2" style={{ background: 'rgba(255, 55, 55, 0.75)' }} />
              <span className="text-muted-foreground">+Γ</span>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
