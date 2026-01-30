import { Brain, Flame, Calendar, Sparkles, Link2 } from "lucide-react";
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

    const hasToday = dumpDates.has(today.getTime());
    if (!hasToday) {
      checkDate.setDate(checkDate.getDate() - 1);
    }

    while (dumpDates.has(checkDate.getTime())) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    // Days active this week
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const daysActiveThisWeek = Array.from(dumpDates).filter(
      (d) => d >= weekAgo.getTime()
    ).length;

    // Proactive insight: top tag this week
    const weekEntries = entries.filter(
      (e) => new Date(e.created_at).getTime() >= weekAgo.getTime()
    );
    const tagCounts: Record<string, number> = {};
    for (const e of weekEntries) {
      for (const tag of e.tags || []) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    const topTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0];

    // Stale high-importance entries (important but older than 5 days)
    const fiveDaysAgo = new Date(today);
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const staleImportant = entries.filter(
      (e) =>
        (e.importance_score ?? 0) >= 7 &&
        new Date(e.created_at).getTime() < fiveDaysAgo.getTime()
    ).length;

    return {
      totalDumps,
      streak,
      daysActiveThisWeek,
      topTag: topTag ? { tag: topTag[0], count: topTag[1] } : null,
      staleImportant,
    };
  }, [entries]);

  if (stats.totalDumps === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2 text-sm">
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

      {stats.topTag && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
          <span className="hidden sm:inline">Hot:</span>
          <span className="font-medium text-foreground">#{stats.topTag.tag}</span>
          <span className="text-xs">({stats.topTag.count})</span>
        </div>
      )}

      {stats.staleImportant > 0 && (
        <div className="flex items-center gap-1.5 text-yellow-500/80">
          <Link2 className="w-3.5 h-3.5" />
          <span className="font-medium">{stats.staleImportant}</span>
          <span className="hidden sm:inline text-xs">important &amp; aging</span>
        </div>
      )}
    </div>
  );
}
