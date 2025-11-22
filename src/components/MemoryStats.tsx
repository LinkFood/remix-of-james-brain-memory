import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Brain, MessageSquare, Hash, TrendingUp } from "lucide-react";

interface MemoryStatsProps {
  userId: string;
}

interface Stats {
  totalMessages: number;
  totalConversations: number;
  topTopics: { topic: string; count: number }[];
  recentActivity: number;
}

const MemoryStats = ({ userId }: MemoryStatsProps) => {
  const [stats, setStats] = useState<Stats>({
    totalMessages: 0,
    totalConversations: 0,
    topTopics: [],
    recentActivity: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, [userId]);

  const fetchStats = async () => {
    try {
      // Total messages
      const { count: messageCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);

      // Total conversations
      const { count: conversationCount } = await supabase
        .from("conversations")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);

      // Recent activity (last 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const { count: recentCount } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", sevenDaysAgo.toISOString());

      // Top topics
      const { data: topicsData } = await supabase
        .from("messages")
        .select("topic")
        .eq("user_id", userId)
        .not("topic", "is", null);

      const topicCounts: { [key: string]: number } = {};
      topicsData?.forEach((msg) => {
        if (msg.topic) {
          topicCounts[msg.topic] = (topicCounts[msg.topic] || 0) + 1;
        }
      });

      const topTopics = Object.entries(topicCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([topic, count]) => ({ topic, count }));

      setStats({
        totalMessages: messageCount || 0,
        totalConversations: conversationCount || 0,
        topTopics,
        recentActivity: recentCount || 0,
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
              <MessageSquare className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.totalMessages}</p>
              <p className="text-sm text-muted-foreground">Total Messages</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center">
              <Brain className="w-6 h-6 text-accent" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.totalConversations}</p>
              <p className="text-sm text-muted-foreground">Conversations</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-primary-glow/10 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-primary-glow" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.recentActivity}</p>
              <p className="text-sm text-muted-foreground">Last 7 Days</p>
            </div>
          </div>
        </Card>

        <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-secondary/50 rounded-xl flex items-center justify-center">
              <Hash className="w-6 h-6 text-secondary-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{stats.topTopics.length}</p>
              <p className="text-sm text-muted-foreground">Topics Discussed</p>
            </div>
          </div>
        </Card>
      </div>

      {stats.topTopics.length > 0 && (
        <Card className="p-6 bg-card border-border">
          <h3 className="text-lg font-semibold text-foreground mb-4">Top Topics</h3>
          <div className="space-y-2">
            {stats.topTopics.map(({ topic, count }) => (
              <div key={topic} className="flex items-center justify-between">
                <span className="text-sm text-foreground capitalize">{topic}</span>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-32 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{
                        width: `${(count / stats.totalMessages) * 100}%`,
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
