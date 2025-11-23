import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Brain, TrendingUp, MessageSquare, Star, Database, Clock } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

interface MemoryUsageStatsProps {
  userId: string;
}

export const MemoryUsageStats = ({ userId }: MemoryUsageStatsProps) => {
  const [stats, setStats] = useState({
    totalMessages: 0,
    totalConversations: 0,
    averageImportance: 0,
    starredMessages: 0,
    messagesWithEmbeddings: 0,
    topTopics: [] as { topic: string; count: number }[],
    importanceDistribution: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    recentActivity: [] as { date: string; count: number }[],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, [userId]);

  const loadStats = async () => {
    try {
      // Total messages
      const { count: msgCount } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      // Total conversations
      const { count: convCount } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

      // Messages with embeddings
      const { count: embeddingCount } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .not('embedding', 'is', null);

      // Starred messages
      const { count: starredCount } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('starred', true);

      // Average importance
      const { data: avgData } = await supabase
        .from('messages')
        .select('importance_score')
        .eq('user_id', userId)
        .not('importance_score', 'is', null);

      const avgImportance = avgData && avgData.length > 0
        ? avgData.reduce((sum, m) => sum + (m.importance_score || 0), 0) / avgData.length
        : 0;

      // Top topics
      const { data: topicsData } = await supabase
        .from('messages')
        .select('topic')
        .eq('user_id', userId)
        .not('topic', 'is', null);

      const topicCounts = topicsData?.reduce((acc, m) => {
        const topic = m.topic || 'Uncategorized';
        acc[topic] = (acc[topic] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const topTopics = Object.entries(topicCounts || {})
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([topic, count]) => ({ topic, count }));

      // Importance distribution
      const { data: importanceData } = await supabase
        .from('messages')
        .select('importance_score')
        .eq('user_id', userId)
        .not('importance_score', 'is', null);

      const distribution = {
        critical: importanceData?.filter(m => (m.importance_score || 0) >= 80).length || 0,
        high: importanceData?.filter(m => (m.importance_score || 0) >= 60 && (m.importance_score || 0) < 80).length || 0,
        medium: importanceData?.filter(m => (m.importance_score || 0) >= 40 && (m.importance_score || 0) < 60).length || 0,
        low: importanceData?.filter(m => (m.importance_score || 0) < 40).length || 0,
      };

      setStats({
        totalMessages: msgCount || 0,
        totalConversations: convCount || 0,
        averageImportance: Math.round(avgImportance),
        starredMessages: starredCount || 0,
        messagesWithEmbeddings: embeddingCount || 0,
        topTopics,
        importanceDistribution: distribution,
        recentActivity: [],
      });
    } catch (error) {
      console.error('Error loading stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse">Loading stats...</div>;
  }

  const embeddingPercentage = stats.totalMessages > 0
    ? (stats.messagesWithEmbeddings / stats.totalMessages) * 100
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Memory System Overview</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <MessageSquare className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Total Messages</span>
            </div>
            <p className="text-3xl font-bold">{stats.totalMessages.toLocaleString()}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Database className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Conversations</span>
            </div>
            <p className="text-3xl font-bold">{stats.totalConversations.toLocaleString()}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Avg Importance</span>
            </div>
            <p className="text-3xl font-bold">{stats.averageImportance}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Star className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Starred</span>
            </div>
            <p className="text-3xl font-bold">{stats.starredMessages.toLocaleString()}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Brain className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">With Embeddings</span>
            </div>
            <p className="text-3xl font-bold">{stats.messagesWithEmbeddings.toLocaleString()}</p>
            <Progress value={embeddingPercentage} className="mt-2 h-1" />
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Clock className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Memory Coverage</span>
            </div>
            <p className="text-3xl font-bold">{Math.round(embeddingPercentage)}%</p>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <h4 className="font-semibold mb-4">Importance Distribution</h4>
          <div className="space-y-3">
            {Object.entries(stats.importanceDistribution).map(([level, count]) => {
              const total = Object.values(stats.importanceDistribution).reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={level}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="capitalize">{level}</span>
                    <span className="text-muted-foreground">{count} messages</span>
                  </div>
                  <Progress value={percentage} className="h-2" />
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-6">
          <h4 className="font-semibold mb-4">Top Topics</h4>
          <div className="space-y-3">
            {stats.topTopics.length > 0 ? (
              stats.topTopics.map((topic) => (
                <div key={topic.topic} className="flex justify-between items-center">
                  <span className="text-sm truncate flex-1">{topic.topic}</span>
                  <span className="text-sm font-semibold text-primary ml-2">
                    {topic.count}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No topics yet</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
