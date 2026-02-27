/**
 * JacProactiveInsightBanner — Proactive Jac insight at top of dashboard
 *
 * Shows dismissible banners for AI-generated insights, overdue items, or forgotten entries.
 */

import { Brain, X, AlertTriangle, Clock, Lightbulb, Calendar, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { InsightType } from "@/hooks/useProactiveInsights";

interface JacProactiveInsightBannerProps {
  message: string;
  type: InsightType;
  onDismiss: () => void;
  onAction?: () => void;
}

const config: Record<InsightType, { icon: typeof Brain; color: string; bg: string; actionLabel: string }> = {
  pattern: {
    icon: TrendingUp,
    color: 'text-purple-400',
    bg: 'bg-purple-500/5 border-purple-500/20',
    actionLabel: 'Explore',
  },
  overdue: {
    icon: AlertTriangle,
    color: 'text-red-400',
    bg: 'bg-red-500/5 border-red-500/20',
    actionLabel: 'View',
  },
  stale: {
    icon: Clock,
    color: 'text-amber-400',
    bg: 'bg-amber-500/5 border-amber-500/20',
    actionLabel: 'Revisit',
  },
  schedule: {
    icon: Calendar,
    color: 'text-green-400',
    bg: 'bg-green-500/5 border-green-500/20',
    actionLabel: 'View',
  },
  suggestion: {
    icon: Lightbulb,
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/5 border-cyan-500/20',
    actionLabel: 'Show me',
  },
  forgotten: {
    icon: Clock,
    color: 'text-amber-400',
    bg: 'bg-amber-500/5 border-amber-500/20',
    actionLabel: 'Show me',
  },
  unchecked: {
    icon: Brain,
    color: 'text-blue-400',
    bg: 'bg-blue-500/5 border-blue-500/20',
    actionLabel: 'Show me',
  },
};

const JacProactiveInsightBanner = ({
  message,
  type,
  onDismiss,
  onAction
}: JacProactiveInsightBannerProps) => {
  const { icon: Icon, color, bg, actionLabel } = config[type] || config.suggestion;

  return (
    <div className={cn("rounded-lg border p-3 flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300", bg)}>
      <Icon className={cn("w-5 h-5 shrink-0", color)} />
      <p className="text-sm flex-1">{message}</p>
      {onAction && (
        <Button variant="ghost" size="sm" onClick={onAction} className="h-7 text-xs">
          {actionLabel}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 hover:bg-background/50"
        onClick={onDismiss}
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
};

export default JacProactiveInsightBanner;
