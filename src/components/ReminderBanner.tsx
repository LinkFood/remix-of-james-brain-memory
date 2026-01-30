import { useState } from "react";
import { format } from "date-fns";
import { Bell, ChevronDown, ChevronUp, Clock, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useUpcomingReminders } from "@/hooks/useUpcomingReminders";

interface ReminderBannerProps {
  userId: string;
  onViewEntry?: (entry: { id: string }) => void;
}

export function ReminderBanner({ userId, onViewEntry }: ReminderBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const { todayReminders, overdueReminders, upcomingCount, loading } = useUpcomingReminders(userId);

  if (loading || isDismissed) return null;

  const totalAlerts = todayReminders.length + overdueReminders.length;
  if (totalAlerts === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={cn(
          "w-full flex items-center justify-between p-3 hover:bg-accent/30 transition-colors",
          overdueReminders.length > 0 ? "bg-destructive/10" : "bg-primary/10"
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            "p-1.5 rounded-full",
            overdueReminders.length > 0 ? "bg-destructive/20" : "bg-primary/20"
          )}>
            {overdueReminders.length > 0 ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <Bell className="h-4 w-4 text-primary" />
            )}
          </div>
          <div className="text-left">
            <div className="font-medium text-sm">
              {overdueReminders.length > 0 && (
                <span className="text-destructive">{overdueReminders.length} overdue · </span>
              )}
              {todayReminders.length > 0 && (
                <span>{todayReminders.length} due today</span>
              )}
            </div>
            {!isExpanded && (
              <p className="text-xs text-muted-foreground">
                {(todayReminders[0] || overdueReminders[0])?.title || 
                 (todayReminders[0] || overdueReminders[0])?.content.slice(0, 40)}...
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            {upcomingCount} this week
          </Badge>
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-border divide-y divide-border">
          {/* Overdue */}
          {overdueReminders.length > 0 && (
            <div className="p-3 bg-destructive/5">
              <div className="text-xs font-medium text-destructive mb-2 uppercase tracking-wide">
                Overdue
              </div>
              <div className="space-y-1">
                {overdueReminders.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => onViewEntry?.({ id: entry.id })}
                    className="w-full text-left p-2 rounded-md hover:bg-destructive/10 transition-colors flex items-center gap-2"
                  >
                    <span className="text-sm">⏰</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">
                        {entry.title || entry.content.slice(0, 40)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Was due {format(new Date(entry.event_date), "MMM d")}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Today */}
          {todayReminders.length > 0 && (
            <div className="p-3">
              <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                Today
              </div>
              <div className="space-y-1">
                {todayReminders.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => onViewEntry?.({ id: entry.id })}
                    className="w-full text-left p-2 rounded-md hover:bg-accent/50 transition-colors flex items-center gap-2"
                  >
                    <span className="text-sm">
                      {entry.content_type === "reminder" ? "⏰" : "📅"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm truncate block">
                        {entry.title || entry.content.slice(0, 40)}
                      </span>
                      {entry.event_time && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {entry.event_time.slice(0, 5)}
                        </span>
                      )}
                    </div>
                    {entry.importance_score && entry.importance_score >= 7 && (
                      <span className="text-xs">🔥</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Dismiss */}
          <div className="p-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsDismissed(true)}
              className="text-xs text-muted-foreground"
            >
              <X className="h-3 w-3 mr-1" />
              Dismiss for now
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
