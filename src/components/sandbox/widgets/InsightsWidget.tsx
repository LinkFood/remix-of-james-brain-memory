/**
 * InsightsWidget — AI-generated insights/signals.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useProactiveInsights } from '@/hooks/useProactiveInsights';
import {
  TrendingUp,
  AlertTriangle,
  Clock,
  Calendar,
  Lightbulb,
  Brain,
  Activity,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { InsightType } from '@/hooks/useProactiveInsights';
import type { WidgetProps } from '@/types/widget';

interface TypeConfig {
  icon: LucideIcon;
  color: string;
  bg: string;
}

const TYPE_CONFIG: Record<string, TypeConfig> = {
  pattern:    { icon: TrendingUp,    color: 'text-purple-400',  bg: 'bg-purple-500/15' },
  overdue:    { icon: AlertTriangle, color: 'text-red-400',     bg: 'bg-red-500/15' },
  stale:      { icon: Clock,         color: 'text-amber-400',   bg: 'bg-amber-500/15' },
  schedule:   { icon: Calendar,      color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
  suggestion: { icon: Lightbulb,     color: 'text-cyan-400',    bg: 'bg-cyan-500/15' },
  forgotten:  { icon: Clock,         color: 'text-amber-400',   bg: 'bg-amber-500/15' },
  unchecked:  { icon: Brain,         color: 'text-blue-400',    bg: 'bg-blue-500/15' },
  activity:   { icon: Activity,      color: 'text-rose-400',    bg: 'bg-rose-500/15' },
};

export default function InsightsWidget({ compact }: WidgetProps) {
  const [userId, setUserId] = useState<string | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { insights, dismiss, loading } = useProactiveInsights(userId);

  const visible = insights.slice(0, compact ? 2 : insights.length);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0 flex items-center justify-between">
        <span className="text-xs font-medium text-white/70">Signals</span>
        {!loading && insights.length > 0 && (
          <span className="text-[10px] text-white/30">{insights.length}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">No signals</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 p-2">
            {visible.map(insight => {
              const cfg = TYPE_CONFIG[insight.type] ?? TYPE_CONFIG.suggestion;
              const Icon = cfg.icon;
              return (
                <div
                  key={insight.id}
                  className={cn(
                    'flex items-start gap-2 p-2 rounded-md border border-white/5',
                    cfg.bg
                  )}
                >
                  <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', cfg.color)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white/80 truncate">
                      {insight.title}
                    </div>
                    <div className="text-[10px] text-white/50 line-clamp-2 mt-0.5">
                      {insight.body}
                    </div>
                    <span className="text-[9px] text-white/20 mt-0.5">
                      {insight.type === 'activity' ? 'from reflections' : 'from entries'}
                    </span>
                  </div>
                  <button
                    onClick={() => dismiss(insight.id)}
                    className="shrink-0 text-white/20 hover:text-white/50 transition-colors mt-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
