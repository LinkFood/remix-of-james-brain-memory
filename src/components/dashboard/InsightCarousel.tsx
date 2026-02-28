import { X, TrendingUp, AlertTriangle, Clock, Calendar, Lightbulb, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BrainInsight, InsightType } from "@/hooks/useProactiveInsights";

interface InsightCarouselProps {
  insights: BrainInsight[];
  onDismiss: (id: string) => void;
  onAction: (insight: BrainInsight) => void;
}

const typeConfig: Record<InsightType, { icon: typeof Brain; color: string; bg: string; actionLabel: string }> = {
  pattern: { icon: TrendingUp, color: 'text-purple-400', bg: 'bg-purple-500/5 border-purple-500/20', actionLabel: 'Explore' },
  overdue: { icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/5 border-red-500/20', actionLabel: 'View' },
  stale: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/5 border-amber-500/20', actionLabel: 'Revisit' },
  schedule: { icon: Calendar, color: 'text-green-400', bg: 'bg-green-500/5 border-green-500/20', actionLabel: 'View' },
  suggestion: { icon: Lightbulb, color: 'text-cyan-400', bg: 'bg-cyan-500/5 border-cyan-500/20', actionLabel: 'Show me' },
  forgotten: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/5 border-amber-500/20', actionLabel: 'Show me' },
  unchecked: { icon: Brain, color: 'text-blue-400', bg: 'bg-blue-500/5 border-blue-500/20', actionLabel: 'Show me' },
};

const InsightCarousel = ({ insights, onDismiss, onAction }: InsightCarouselProps) => {
  if (insights.length === 0) return null;

  // Single insight: full-width card
  if (insights.length === 1) {
    const insight = insights[0];
    const { icon: Icon, color, bg, actionLabel } = typeConfig[insight.type] || typeConfig.suggestion;
    return (
      <div className={cn("rounded-lg border p-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300", bg)}>
        <Icon className={cn("w-5 h-5 shrink-0", color)} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{insight.title}</p>
          <p className="text-xs text-muted-foreground truncate">{insight.body}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onAction(insight)} className="h-7 text-xs shrink-0">
          {actionLabel}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 hover:bg-background/50" onClick={() => onDismiss(insight.id)}>
          <X className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  // Multiple insights: horizontal scroll
  return (
    <div className="overflow-x-auto flex gap-3 pb-1 snap-x snap-mandatory scrollbar-thin scrollbar-thumb-muted scrollbar-track-transparent">
      {insights.map(insight => {
        const { icon: Icon, color, bg, actionLabel } = typeConfig[insight.type] || typeConfig.suggestion;
        return (
          <div
            key={insight.id}
            className={cn("min-w-[260px] max-w-[300px] rounded-lg border p-3 snap-start shrink-0 animate-in fade-in duration-300", bg)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <Icon className={cn("w-4 h-4 shrink-0 mt-0.5", color)} />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{insight.title}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{insight.body}</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 hover:bg-background/50" onClick={() => onDismiss(insight.id)}>
                <X className="w-3 h-3" />
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onAction(insight)} className="h-6 text-xs mt-2 w-full">
              {actionLabel}
            </Button>
          </div>
        );
      })}
    </div>
  );
};

export default InsightCarousel;
