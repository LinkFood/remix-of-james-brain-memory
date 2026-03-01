/**
 * PrincipleTickerWidget — Auto-rotating display of JAC's distilled operating principles.
 *
 * Single view (no tabs). Auto-rotates every 6s, pauses on hover.
 * Compact: truncated single principle, no nav.
 * Expanded: scrollable list of all principles.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Compass, ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { usePrinciples } from '@/hooks/usePrinciples';
import type { WidgetProps } from '@/types/widget';

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return `${Math.floor(diffD / 30)}mo ago`;
}

export default function PrincipleTickerWidget({ compact, expanded }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { principles, isLoading } = usePrinciples(userId);

  // Auto-rotate timer
  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (principles.length <= 1) return;
    timerRef.current = setInterval(() => {
      setActiveIndex(prev => (prev + 1) % principles.length);
    }, 6000);
  }, [principles.length]);

  useEffect(() => {
    if (!hovered && !expanded) {
      startTimer();
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [hovered, expanded, startTimer]);

  // Keep activeIndex in bounds when principles change
  useEffect(() => {
    if (principles.length > 0 && activeIndex >= principles.length) {
      setActiveIndex(0);
    }
  }, [principles.length, activeIndex]);

  const goTo = (index: number) => {
    setActiveIndex(index);
    startTimer();
  };

  const prev = () => goTo((activeIndex - 1 + principles.length) % principles.length);
  const next = () => goTo((activeIndex + 1) % principles.length);

  // --- Loading ---
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  // --- Empty ---
  if (principles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <Compass className="w-6 h-6" />
        <span className="text-[11px]">No principles yet</span>
        <span className="text-[10px] text-white/20">JAC distills these weekly from reflections</span>
      </div>
    );
  }

  // --- Expanded: scrollable list ---
  if (expanded) {
    return (
      <div className="flex flex-col h-full overflow-y-auto">
        {principles.map((p, i) => (
          <div
            key={p.id}
            className="px-4 py-3 border-b border-white/5 last:border-b-0"
          >
            <p className="text-[12px] text-white/80 leading-relaxed">{p.principle}</p>
            <div className="flex items-center gap-3 mt-1.5">
              {p.confidence > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-cyan-400/50"
                      style={{ width: `${Math.min(p.confidence * 100, 100)}%` }}
                    />
                  </div>
                  <span className="text-[9px] text-white/30">{Math.round(p.confidence * 100)}%</span>
                </div>
              )}
              {p.times_applied > 0 && (
                <span className="text-[9px] text-white/30">applied {p.times_applied}x</span>
              )}
              {p.last_validated && (
                <span className="text-[9px] text-white/20">validated {timeAgo(p.last_validated)}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const current = principles[activeIndex];

  // --- Compact: just the text, truncated ---
  if (compact) {
    return (
      <div className="flex items-center h-full px-3">
        <p className="text-[11px] text-white/60 leading-snug line-clamp-2">{current.principle}</p>
      </div>
    );
  }

  // --- Normal: rotating card with nav ---
  return (
    <div
      className="flex flex-col h-full justify-between px-4 py-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Principle text */}
      <div className="flex-1 flex items-center">
        <p className="text-[13px] text-white/80 leading-relaxed">{current.principle}</p>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 mt-2">
        {current.confidence > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-cyan-400/50"
                style={{ width: `${Math.min(current.confidence * 100, 100)}%` }}
              />
            </div>
            <span className="text-[9px] text-white/30">{Math.round(current.confidence * 100)}%</span>
          </div>
        )}
        {current.times_applied > 0 && (
          <span className="text-[9px] text-white/30">applied {current.times_applied}x</span>
        )}
        {current.last_validated && (
          <span className="text-[9px] text-white/20">validated {timeAgo(current.last_validated)}</span>
        )}
      </div>

      {/* Navigation */}
      {principles.length > 1 && (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          <button
            onClick={prev}
            className="p-0.5 rounded hover:bg-white/5 transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-white/30 hover:text-white/50" />
          </button>

          <div className="flex items-center gap-1.5">
            {principles.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === activeIndex ? 'bg-cyan-400/60' : 'bg-white/15 hover:bg-white/25'
                }`}
              />
            ))}
          </div>

          <button
            onClick={next}
            className="p-0.5 rounded hover:bg-white/5 transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5 text-white/30 hover:text-white/50" />
          </button>
        </div>
      )}
    </div>
  );
}
