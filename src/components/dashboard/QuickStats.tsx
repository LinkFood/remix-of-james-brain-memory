import { Brain, Flame, Calendar } from "lucide-react";
import { useMemo } from "react";
import type { Entry } from "@/types";

interface QuickStatsProps {
  entries: Entry[];
}

export function QuickStats({ entries }: QuickStatsProps) {
  const stats = useMemo(() => {
    const totalDumps = entries.length;
    
    // Calculate streak (consecutive days with dumps)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dumpDates = new Set(
      entries.map((e) => {
        const date = new Date(e.created_at);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
      })
    );
    
    let streak = 0;
    let checkDate = new Date(today);
    
    // Check if there's a dump today or yesterday to start the streak
    const hasToday = dumpDates.has(today.getTime());
    if (!hasToday) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    
    while (dumpDates.has(checkDate.getTime())) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }
    
    // Calculate days active this week
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const daysActiveThisWeek = Array.from(dumpDates).filter(
      (d) => d >= weekAgo.getTime()
    ).length;
    
    return { totalDumps, streak, daysActiveThisWeek };
  }, [entries]);

  if (stats.totalDumps === 0) return null;

  return (
    <div className="flex items-center gap-4 px-1 py-2 text-sm">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Brain className="w-4 h-4 text-primary" />
        <span className="font-medium text-foreground">{stats.totalDumps}</span>
        <span className="hidden sm:inline">thoughts</span>
      </div>
      
      {stats.streak > 0 && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Flame className="w-4 h-4 text-destructive" />
          <span className="font-medium text-foreground">{stats.streak}</span>
          <span className="hidden sm:inline">day streak</span>
        </div>
      )}
      
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Calendar className="w-4 h-4 text-primary" />
        <span className="font-medium text-foreground">{stats.daysActiveThisWeek}</span>
        <span className="hidden sm:inline">days this week</span>
      </div>
    </div>
  );
}
