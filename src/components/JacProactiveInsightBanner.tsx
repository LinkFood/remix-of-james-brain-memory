/**
 * JacProactiveInsightBanner — Proactive Jac insight at top of dashboard
 * 
 * Shows dismissible banners for overdue items or forgotten entries.
 */

import { Brain, X, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface JacProactiveInsightBannerProps {
  message: string;
  type: 'forgotten' | 'overdue' | 'unchecked';
  onDismiss: () => void;
  onAction?: () => void;
}

const config = {
  forgotten: { 
    icon: Clock, 
    color: 'text-amber-400', 
    bg: 'bg-amber-500/5 border-amber-500/20',
    actionLabel: 'Show me',
  },
  overdue: { 
    icon: AlertTriangle, 
    color: 'text-red-400', 
    bg: 'bg-red-500/5 border-red-500/20',
    actionLabel: 'View',
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
  const { icon: Icon, color, bg, actionLabel } = config[type];

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
