import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Brain, TrendingUp, Tag, Star, Clock, Lightbulb, Code, List, Link, User, Calendar, Bell, FileText, Activity } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';

interface Entry {
  id: string;
  content_type: string;
  tags: string[] | null;
  importance_score: number | null;
  starred: boolean;
  created_at: string;
}

interface BrainInsightsDashboardProps {
  userId: string;
}

const contentTypeIcons: Record<string, React.ElementType> = {
  code: Code,
  list: List,
  idea: Lightbulb,
  link: Link,
  contact: User,
  event: Calendar,
  reminder: Bell,
  note: FileText,
};

const contentTypeColors: Record<string, string> = {
  code: '#10b981',
  list: '#f59e0b',
  idea: '#8b5cf6',
  link: '#3b82f6',
  contact: '#ec4899',
  event: '#14b8a6',
  reminder: '#ef4444',
  note: '#6b7280',
};

export default function BrainInsightsDashboard({ userId }: BrainInsightsDashboardProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchEntries() {
      setLoading(true);
      const { data, error } = await supabase
        .from('entries')
        .select('id, content_type, tags, importance_score, starred, created_at')
        .eq('user_id', userId)
        .eq('archived', false)
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) {
        console.error('Error fetching entries:', error);
      } else {
        setEntries(data || []);
      }
      setLoading(false);
    }

    fetchEntries();
  }, [userId]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-[400px]" />
          <Skeleton className="h-[400px]" />
          <Skeleton className="h-[400px]" />
          <Skeleton className="h-[400px]" />
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Brain className="h-6 w-6 text-primary" />
          <h2 className="text-2xl font-bold">Brain Insights Dashboard</h2>
        </div>
        <Card className="p-8 text-center text-muted-foreground">
          <Lightbulb className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No entries yet. Start dumping to see insights!</p>
        </Card>
      </div>
    );
  }

  // Calculate insights
  const contentTypeCounts = entries.reduce((acc, e) => {
    acc[e.content_type] = (acc[e.content_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const pieData = Object.entries(contentTypeCounts).map(([name, value]) => ({
    name,
    value,
    color: contentTypeColors[name] || '#6b7280',
  }));

  const tagCounts: Record<string, number> = {};
  entries.forEach(e => {
    (e.tags || []).forEach(tag => {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    });
  });
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const avgImportance = entries.reduce((sum, e) => sum + (e.importance_score || 0), 0) / entries.length;
  const highPriorityCount = entries.filter(e => (e.importance_score || 0) >= 8).length;
  const starredCount = entries.filter(e => e.starred).length;

  // Activity by hour
  const hourCounts: Record<number, number> = {};
  entries.forEach(e => {
    const hour = new Date(e.created_at).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  });
  const activityData = Array.from({ length: 24 }, (_, i) => ({
    hour: `${i.toString().padStart(2, '0')}:00`,
    count: hourCounts[i] || 0,
  }));

  // Recent activity (last 7 days)
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayCounts: Record<string, number> = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dayName = dayNames[date.getDay()];
    dayCounts[dayName] = 0;
  }
  entries.forEach(e => {
    const date = new Date(e.created_at);
    const daysAgo = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (daysAgo < 7) {
      const dayName = dayNames[date.getDay()];
      dayCounts[dayName] = (dayCounts[dayName] || 0) + 1;
    }
  });
  const weeklyData = Object.entries(dayCounts).map(([day, count]) => ({ day, count }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="h-6 w-6 text-primary" />
        <h2 className="text-2xl font-bold">Brain Insights Dashboard</h2>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              <div>
                <p className="text-2xl font-bold">{entries.length}</p>
                <p className="text-sm text-muted-foreground">Total Entries</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-orange-500" />
              <div>
                <p className="text-2xl font-bold">{avgImportance.toFixed(1)}</p>
                <p className="text-sm text-muted-foreground">Avg Importance</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{highPriorityCount}</p>
                <p className="text-sm text-muted-foreground">High Priority</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Star className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="text-2xl font-bold">{starredCount}</p>
                <p className="text-sm text-muted-foreground">Starred</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Content Type Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Content Types
            </CardTitle>
            <CardDescription>Distribution of entry types</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                value: {
                  label: 'Entries',
                  color: 'hsl(var(--primary))',
                },
              }}
              className="h-[300px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ResponsiveContainer>
            </ChartContainer>
            <div className="flex flex-wrap gap-2 mt-4">
              {Object.entries(contentTypeCounts).map(([type, count]) => {
                const Icon = contentTypeIcons[type] || FileText;
                return (
                  <Badge key={type} variant="outline" className="flex items-center gap-1">
                    <Icon className="h-3 w-3" style={{ color: contentTypeColors[type] }} />
                    {type}: {count}
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Weekly Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Weekly Activity
            </CardTitle>
            <CardDescription>Entries created in the last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                count: {
                  label: 'Entries',
                  color: 'hsl(var(--primary))',
                },
              }}
              className="h-[300px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" />
                  <YAxis />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {/* Top Tags */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Top Tags
          </CardTitle>
          <CardDescription>Most frequently used tags across your entries</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {topTags.map(([tag, count]) => (
              <Badge key={tag} variant="secondary" className="text-sm">
                {tag}
                <span className="ml-2 text-muted-foreground">({count})</span>
              </Badge>
            ))}
            {topTags.length === 0 && (
              <p className="text-muted-foreground text-sm">No tags yet. Add tags to your entries!</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Activity by Hour */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Activity by Hour
          </CardTitle>
          <CardDescription>When you're most active during the day</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={{
              count: {
                label: 'Entries',
                color: 'hsl(var(--accent))',
              },
            }}
            className="h-[200px]"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={activityData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="hour" 
                  interval={2}
                  fontSize={12}
                />
                <YAxis />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="hsl(var(--accent))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
