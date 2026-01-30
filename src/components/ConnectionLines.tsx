/**
 * ConnectionLines — SVG overlay showing visual connections between entries
 *
 * When Jac's dashboard transformation returns connections between entries,
 * this component draws subtle curved lines between them on the dashboard.
 * Lines are drawn from the center-right of one entry to the center-left of another.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import type { JacConnection } from "@/hooks/useJacDashboard";

interface ConnectionLinesProps {
  connections: JacConnection[];
  active: boolean;
}

interface LineCoords {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
  strength: number;
}

const ConnectionLines = ({ connections, active }: ConnectionLinesProps) => {
  const [lines, setLines] = useState<LineCoords[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const computeLines = useCallback(() => {
    if (!active || connections.length === 0) {
      setLines([]);
      return;
    }

    const newLines: LineCoords[] = [];

    for (const conn of connections) {
      const fromEl = document.getElementById(`entry-${conn.from}`);
      const toEl = document.getElementById(`entry-${conn.to}`);

      if (!fromEl || !toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      // Use center-right of "from" and center-left of "to"
      newLines.push({
        x1: fromRect.right - 8,
        y1: fromRect.top + fromRect.height / 2,
        x2: toRect.left + 8,
        y2: toRect.top + toRect.height / 2,
        label: conn.label,
        strength: conn.strength,
      });
    }

    setLines(newLines);
  }, [connections, active]);

  useEffect(() => {
    computeLines();
    // Recompute on scroll or resize
    const handler = () => requestAnimationFrame(computeLines);
    window.addEventListener("scroll", handler, { passive: true });
    window.addEventListener("resize", handler, { passive: true });
    return () => {
      window.removeEventListener("scroll", handler);
      window.removeEventListener("resize", handler);
    };
  }, [computeLines]);

  if (!active || lines.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 pointer-events-none z-30 animate-in fade-in duration-500"
    >
      <svg
        className="w-full h-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="conn-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgb(56, 189, 248)" stopOpacity="0.4" />
            <stop offset="50%" stopColor="rgb(168, 85, 247)" stopOpacity="0.6" />
            <stop offset="100%" stopColor="rgb(56, 189, 248)" stopOpacity="0.4" />
          </linearGradient>
        </defs>

        {lines.map((line, i) => {
          // Curved bezier path
          const midX = (line.x1 + line.x2) / 2;
          const dx = Math.abs(line.x2 - line.x1);
          const controlOffset = Math.max(30, dx * 0.3);

          const path = `M ${line.x1} ${line.y1} C ${line.x1 + controlOffset} ${line.y1}, ${line.x2 - controlOffset} ${line.y2}, ${line.x2} ${line.y2}`;

          return (
            <g key={i}>
              <path
                d={path}
                fill="none"
                stroke="url(#conn-gradient)"
                strokeWidth={1 + line.strength}
                strokeDasharray={line.strength < 0.5 ? "4 4" : "none"}
                opacity={0.4 + line.strength * 0.4}
              />
              {/* Connection dots at endpoints */}
              <circle
                cx={line.x1}
                cy={line.y1}
                r={2.5}
                fill="rgb(56, 189, 248)"
                opacity={0.6}
              />
              <circle
                cx={line.x2}
                cy={line.y2}
                r={2.5}
                fill="rgb(56, 189, 248)"
                opacity={0.6}
              />
              {/* Label at midpoint */}
              {line.label && (
                <text
                  x={midX}
                  y={(line.y1 + line.y2) / 2 - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                  opacity={0.7}
                >
                  {line.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export default ConnectionLines;
