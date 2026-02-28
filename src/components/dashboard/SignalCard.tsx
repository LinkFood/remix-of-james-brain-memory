/**
 * SignalCard — Full-width insight card with thick left color border
 *
 * Glassmorphism background. Used as a vertical stack in the dashboard.
 * Replaces the InsightCarousel's horizontal scroll with stronger visual presence.
 */

import { X, TrendingUp, AlertTriangle, Clock, Calendar, Lightbulb, Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BrainInsight, InsightType } from '@/hooks/useProactiveInsights';

interface SignalCardProps {
  insight: BrainInsight;
  onDismiss: (id: string) => void;
  onAction: (insight: BrainInsight) => void;
}

const typeConfig: Record<InsightType, {
  icon: typeof Brain;
  borderColor: string;
  iconColor: string;
  actionLabel: string;
}> = {
  pattern:    { icon: TrendingUp,    borderColor: 'border-l-purple-500', iconColor: 'text-purple-400', actionLabel: 'Explore' },
  overdue:    { icon: AlertTriangle, borderColor: 'border-l-red-500',    iconColor: 'text-red-400',    actionLabel: 'View' },
  stale:      { icon: Clock,         borderColor: 'border-l-amber-500',  iconColor: 'text-amber-400',  actionLabel: 'Revisit' },
  schedule:   { icon: Calendar,      borderColor: 'border-l-green-500',  iconColor: 'text-green-400',  actionLabel: 'View' },
  suggestion: { icon: Lightbulb,     borderColor: 'border-l-cyan-500',   iconColor: 'text-cyan-400',   actionLabel: 'Show me' },
  forgotten:  { icon: Clock,         borderColor: 'border-l-amber-500',  iconColor: 'text-amber-400',  actionLabel: 'Show me' },
  unchecked:  { icon: Brain,         borderColor: 'border-l-blue-500',   iconColor: 'text-blue-400',   actionLabel: 'Show me' },
};

const SignalCard = ({ insight, onDismiss, onAction }: SignalCardProps) => {
  const config = typeConfig[insight.type] || typeConfig.suggestion;
  const Icon = config.icon;

  return (
    <div className={cn(
      'rounded-xl border-l-4 p-4 animate-in fade-in slide-in-from-top-2 duration-300',
      config.borderColor,
      'bg-white/[0.03] backdrop-blur-sm border border-white/10',
    )}>
      <div className="flex items-start gap-3">
        <Icon className={cn('w-4 h-4 shrink-0 mt-0.5', config.iconColor)} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{insight.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3">{insight.body}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAction(insight)}
            className="h-7 text-xs"
          >
            {config.actionLabel}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-background/50"
            onClick={() => onDismiss(insight.id)}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SignalCard;
