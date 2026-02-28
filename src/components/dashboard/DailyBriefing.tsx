import { RefreshCw, Sun, Sunset, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { BrainInsight } from "@/hooks/useProactiveInsights";
import type { DashboardStats } from "@/hooks/useEntries";

interface DailyBriefingProps {
  insights: BrainInsight[];
  stats: DashboardStats;
  loading: boolean;
  onRefresh: () => void;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return { text: "Good morning", Icon: Sun };
  if (hour < 18) return { text: "Good afternoon", Icon: Sunset };
  return { text: "Good evening", Icon: Moon };
}

function buildBriefing(insights: BrainInsight[], stats: DashboardStats): string {
  // Synthesize top 3 insights into prose
  const top = insights.slice(0, 3);
  if (top.length > 0) {
    return top.map(i => i.title).join(". ") + ".";
  }

  // Stat fallback
  const parts: string[] = [];
  if (stats.total > 0) parts.push(`${stats.total} entries`);
  if (stats.today > 0) parts.push(`${stats.today} today`);
  if (stats.important > 0) parts.push(`${stats.important} important`);
  return parts.length > 0 ? parts.join(", ") + "." : "Your brain is empty. Dump something in.";
}

const DailyBriefing = ({ insights, stats, loading, onRefresh }: DailyBriefingProps) => {
  const { text: greeting, Icon: GreetingIcon } = getGreeting();
  const briefing = buildBriefing(insights, stats);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <GreetingIcon className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{greeting}</p>
            <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{briefing}</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
    </Card>
  );
};

export default DailyBriefing;
