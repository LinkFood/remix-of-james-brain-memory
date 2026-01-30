/**
 * JacInsightCard — Jac's insight card on the dashboard
 *
 * Shows when Jac has transformed the dashboard with an answer.
 * Small, dismissable, clear. Not overwhelming.
 */

import { X, Brain, TrendingUp, Lightbulb, HelpCircle, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { JacInsight } from "@/hooks/useJacDashboard";

interface JacInsightCardProps {
  insight: JacInsight;
  message?: string | null;
  loading?: boolean;
  onDismiss: () => void;
  className?: string;
}

const typeConfig = {
  insight: {
    icon: Brain,
    color: "text-sky-400",
    bgColor: "bg-sky-400/5 border-sky-400/20",
    label: "Jac sees:",
  },
  pattern: {
    icon: TrendingUp,
    color: "text-purple-400",
    bgColor: "bg-purple-400/5 border-purple-400/20",
    label: "Pattern found:",
  },
  suggestion: {
    icon: Lightbulb,
    color: "text-yellow-400",
    bgColor: "bg-yellow-400/5 border-yellow-400/20",
    label: "Jac suggests:",
  },
  question: {
    icon: HelpCircle,
    color: "text-green-400",
    bgColor: "bg-green-400/5 border-green-400/20",
    label: "Jac wonders:",
  },
};

const JacInsightCard = ({
  insight,
  message,
  loading = false,
  onDismiss,
  className,
}: JacInsightCardProps) => {
  const config = typeConfig[insight.type] || typeConfig.insight;
  const Icon = config.icon;

  return (
    <Card
      className={cn(
        "border animate-in fade-in slide-in-from-top-2 duration-300",
        config.bgColor,
        className
      )}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={cn("mt-0.5 shrink-0", config.color)}>
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Icon className="w-5 h-5" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn("text-xs font-medium mb-1", config.color)}>
                {loading ? "Jac is thinking..." : config.label}
              </p>
              {!loading && (
                <>
                  <p className="text-sm font-medium">{insight.title}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {insight.body}
                  </p>
                  {message && message !== insight.body && (
                    <p className="text-xs text-muted-foreground/70 mt-2 italic">
                      {message}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default JacInsightCard;
