import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { TrendingUp, FileText, Hash, Star } from "lucide-react";
import { toast } from "sonner";
import { MemoryUsageStats } from "@/components/MemoryUsageStats";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

interface UsageAnalyticsProps {
  userId: string;
}

interface ContentTypeUsage {
  type: string;
  count: number;
}

interface DailyActivity {
  date: string;
  count: number;
}

const COLORS = [
  "hsl(180, 100%, 50%)",
  "hsl(280, 70%, 55%)",
  "hsl(120, 70%, 45%)",
  "hsl(40, 90%, 55%)",
  "hsl(0, 70%, 55%)",
  "hsl(200, 80%, 50%)",
];

const UsageAnalytics = ({ userId }: UsageAnalyticsProps) => {
  const [contentTypeUsage, setContentTypeUsage] = useState<ContentTypeUsage[]>([]);
  const [dailyActivity, setDailyActivity] = useState<DailyActivity[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [totalTags, setTotalTags] = useState(0);
  const [starredCount, setStarredCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsageData();
  }, [userId]);

  const fetchUsageData = async () => {
    try {
      // Get all entries
      const { data: entries, error } = await supabase
        .from("entries")
        .select("content_type, tags, starred, created_at")
        .eq("user_id", userId)
        .eq("archived", false);

      if (error) throw error;

      // Calculate content type distribution
      const typeStats: Record<string, number> = {};
      const allTags = new Set<string>();
      let starred = 0;

      entries?.forEach((entry) => {
        const type = entry.content_type || 'note';
        typeStats[type] = (typeStats[type] || 0) + 1;
        
        const tags = entry.tags as string[] | null;
        tags?.forEach((tag: string) => allTags.add(tag));
        
        if (entry.starred) starred++;
      });

      const typeArray = Object.entries(typeStats)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);

      // Calculate daily activity (last 30 days)
      const dailyStats: Record<string, number> = {};
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      entries?.forEach((entry) => {
        const date = new Date(entry.created_at);
        if (date >= thirtyDaysAgo) {
          const dateKey = date.toLocaleDateString();
          dailyStats[dateKey] = (dailyStats[dateKey] || 0) + 1;
        }
      });

      const dailyArray = Object.entries(dailyStats)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      setContentTypeUsage(typeArray);
      setDailyActivity(dailyArray);
      setTotalEntries(entries?.length || 0);
      setTotalTags(allTags.size);
      setStarredCount(starred);
    } catch (error) {
      console.error("Failed to fetch usage data:", error);
      toast.error("Failed to load analytics");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="p-6 bg-card border-border animate-pulse">
              <div className="h-24 bg-muted rounded" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-2 max-w-md">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="memory">Memory Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
                  <FileText className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{totalEntries}</p>
                  <p className="text-sm text-muted-foreground">Total Entries</p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center">
                  <TrendingUp className="w-6 h-6 text-accent" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{contentTypeUsage.length}</p>
                  <p className="text-sm text-muted-foreground">Content Types</p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-primary-glow/10 rounded-xl flex items-center justify-center">
                  <Hash className="w-6 h-6 text-primary-glow" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{totalTags}</p>
                  <p className="text-sm text-muted-foreground">Unique Tags</p>
                </div>
              </div>
            </Card>

            <Card className="p-6 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-secondary/50 rounded-xl flex items-center justify-center">
                  <Star className="w-6 h-6 text-secondary-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{starredCount}</p>
                  <p className="text-sm text-muted-foreground">Starred</p>
                </div>
              </div>
            </Card>
          </div>

          {/* Content Type Distribution */}
          {contentTypeUsage.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card className="p-6 bg-card border-border">
                <h3 className="text-lg font-semibold text-foreground mb-4">Content Types</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={contentTypeUsage}
                      dataKey="count"
                      nameKey="type"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={({ type, count }) => `${type}: ${count}`}
                    >
                      {contentTypeUsage.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(220 25% 8%)', 
                        border: '1px solid hsl(220 20% 18%)',
                        borderRadius: '8px'
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </Card>

              <Card className="p-6 bg-card border-border">
                <h3 className="text-lg font-semibold text-foreground mb-4">Content Breakdown</h3>
                <div className="space-y-4">
                  {contentTypeUsage.map((usage, idx) => (
                    <div key={usage.type} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                          />
                          <span className="text-sm capitalize text-foreground">{usage.type}</span>
                        </div>
                        <span className="text-lg font-bold text-foreground">{usage.count}</span>
                      </div>
                      <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${(usage.count / totalEntries) * 100}%`,
                            backgroundColor: COLORS[idx % COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}

          {/* Daily Activity */}
          {dailyActivity.length > 0 && (
            <Card className="p-6 bg-card border-border">
              <h3 className="text-lg font-semibold text-foreground mb-4">Activity (Last 30 Days)</h3>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={dailyActivity}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 20% 18%)" />
                  <XAxis 
                    dataKey="date" 
                    stroke="hsl(180 30% 60%)"
                    style={{ fontSize: '10px' }}
                    tickFormatter={(value) => new Date(value).getDate().toString()}
                  />
                  <YAxis 
                    stroke="hsl(180 30% 60%)"
                    style={{ fontSize: '12px' }}
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(220 25% 8%)', 
                      border: '1px solid hsl(220 20% 18%)',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value} entries`, 'Count']}
                  />
                  <Bar 
                    dataKey="count" 
                    fill="hsl(180 100% 50%)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="memory" className="space-y-6 mt-6">
          <MemoryUsageStats userId={userId} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default UsageAnalytics;
