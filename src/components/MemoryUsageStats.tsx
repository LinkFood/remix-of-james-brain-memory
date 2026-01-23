import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Brain, TrendingUp, FileText, Star, Database, Clock } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

interface MemoryUsageStatsProps {
  userId: string;
}

export const MemoryUsageStats = ({ userId }: MemoryUsageStatsProps) => {
  const [stats, setStats] = useState({
    totalEntries: 0,
    averageImportance: 0,
    starredEntries: 0,
    entriesWithEmbeddings: 0,
    topTags: [] as { tag: string; count: number }[],
    importanceDistribution: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    contentTypeDistribution: {} as Record<string, number>,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, [userId]);

  const loadStats = async () => {
    try {
      // Total entries
      const { count: entryCount } = await supabase
        .from('entries')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('archived', false);

      // Entries with embeddings
      const { count: embeddingCount } = await supabase
        .from('entries')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('archived', false)
        .not('embedding', 'is', null);

      // Starred entries
      const { count: starredCount } = await supabase
        .from('entries')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('starred', true);

      // Get all entries for analysis
      const { data: entriesData } = await supabase
        .from('entries')
        .select('importance_score, tags, content_type')
        .eq('user_id', userId)
        .eq('archived', false);

      // Average importance
      const importanceScores = entriesData
        ?.map((e) => e.importance_score)
        .filter((s): s is number => s !== null) || [];
      const avgImportance = importanceScores.length > 0
        ? importanceScores.reduce((sum, s) => sum + s, 0) / importanceScores.length
        : 0;

      // Top tags
      const tagCounts: Record<string, number> = {};
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

      // Importance distribution (0-10 scale)
      const distribution = {
        critical: importanceScores.filter(s => s >= 8).length,
        high: importanceScores.filter(s => s >= 6 && s < 8).length,
        medium: importanceScores.filter(s => s >= 4 && s < 6).length,
        low: importanceScores.filter(s => s < 4).length,
      };

      // Content type distribution
      const typeDistribution: Record<string, number> = {};
      entriesData?.forEach((entry) => {
        const type = entry.content_type || 'note';
        typeDistribution[type] = (typeDistribution[type] || 0) + 1;
      });

      setStats({
        totalEntries: entryCount || 0,
        averageImportance: Math.round(avgImportance * 10) / 10,
        starredEntries: starredCount || 0,
        entriesWithEmbeddings: embeddingCount || 0,
        topTags,
        importanceDistribution: distribution,
        contentTypeDistribution: typeDistribution,
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

  const embeddingPercentage = stats.totalEntries > 0
    ? (stats.entriesWithEmbeddings / stats.totalEntries) * 100
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Brain Dump Overview</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <FileText className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Total Entries</span>
            </div>
            <p className="text-3xl font-bold">{stats.totalEntries.toLocaleString()}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Avg Importance</span>
            </div>
            <p className="text-3xl font-bold">{stats.averageImportance}/10</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Star className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Starred</span>
            </div>
            <p className="text-3xl font-bold">{stats.starredEntries.toLocaleString()}</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Brain className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">With Embeddings</span>
            </div>
            <p className="text-3xl font-bold">{stats.entriesWithEmbeddings.toLocaleString()}</p>
            <Progress value={embeddingPercentage} className="mt-2 h-1" />
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Database className="w-5 h-5 text-primary" />
              <span className="text-sm text-muted-foreground">Content Types</span>
            </div>
            <p className="text-3xl font-bold">{Object.keys(stats.contentTypeDistribution).length}</p>
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
                    <span className="text-muted-foreground">{count} entries</span>
                  </div>
                  <Progress value={percentage} className="h-2" />
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-6">
          <h4 className="font-semibold mb-4">Top Tags</h4>
          <div className="space-y-3">
            {stats.topTags.length > 0 ? (
              stats.topTags.map((item) => (
                <div key={item.tag} className="flex justify-between items-center">
                  <span className="text-sm truncate flex-1">#{item.tag}</span>
                  <span className="text-sm font-semibold text-primary ml-2">
                    {item.count}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No tags yet</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
