import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Brain, Hash, TrendingUp, Clock } from "lucide-react";

interface MemoryStatsProps {
  userId: string;
}

interface Stats {
  totalEntries: number;
  topTags: { tag: string; count: number }[];
  recentActivity: number;
  avgImportance: number;
}

const MemoryStats = ({ userId }: MemoryStatsProps) => {
  const [stats, setStats] = useState<Stats>({
    totalEntries: 0,
    topTags: [],
    recentActivity: 0,
    avgImportance: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, [userId]);

  const fetchStats = async () => {
    try {
      // Total entries
      const { count: entryCount } = await supabase
        .from("entries")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("archived", false);

      // Recent activity (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const { count: recentCount } = await supabase
        .from("entries")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sevenDaysAgo.toISOString());

      // Get all entries for tag analysis and importance
      const { data: entriesData } = await supabase
        .from("entries")
        .select("tags, importance_score")
        .eq("user_id", userId)
        .eq("archived", false);

      // Calculate top tags
      const tagCounts: { [key: string]: number } = {};
      entriesData?.forEach((entry) => {
        const tags = entry.tags as string[] | null;
        tags?.forEach((tag: string) => {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        });
      });

      const topTags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([tag, count]) => ({ tag, count }));

      // Calculate average importance
      const importanceScores = entriesData
        ?.map((e) => e.importance_score)
        .filter((s): s is number => s !== null) || [];
      const avgImportance = importanceScores.length > 0
        ? importanceScores.reduce((a, b) => a + b, 0) / importanceScores.length
        : 0;

      setStats({
        totalEntries: entryCount || 0,
        topTags,
        recentActivity: recentCount || 0,
        avgImportance: Math.round(avgImportance * 10) / 10,
      });
    } catch (error) {
      console.error("Failed to fetch stats:", error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="p-6 bg-card border-border animate-pulse">
            <div className="h-20 bg-muted rounded" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.totalEntries}</p>
              <p className="text-sm text-muted-foreground">Total Entries</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center">
              <Clock className="w-6 h-6 text-accent" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.recentActivity}</p>
              <p className="text-sm text-muted-foreground">Last 7 Days</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary-glow/10 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-primary-glow" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.avgImportance}</p>
              <p className="text-sm text-muted-foreground">Avg Importance</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-secondary/50 rounded-xl flex items-center justify-center">
              <Hash className="w-6 h-6 text-secondary-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.topTags.length}</p>
              <p className="text-sm text-muted-foreground">Unique Tags</p>
            </div>
          </div>
        </Card>
      </div>

      {stats.topTags.length > 0 && (
        <Card className="p-6 bg-card border-border">
          <h3 className="text-lg font-semibold text-foreground mb-4">Top Tags</h3>
          <div className="space-y-2">
            {stats.topTags.map(({ tag, count }) => (
              <div key={tag} className="flex items-center justify-between">
                <span className="text-sm text-foreground">#{tag}</span>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-32 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{
                        width: `${(count / stats.totalEntries) * 100}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm text-muted-foreground w-8 text-right">{count}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

export default MemoryStats;
