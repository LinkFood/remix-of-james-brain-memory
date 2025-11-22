import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Brain, TrendingUp, MessageSquare, Activity } from "lucide-react";
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

interface BrainInsightsDashboardProps {
  userId: string;
}

interface TopicData {
  topic: string;
  count: number;
}

interface SentimentData {
  date: string;
  positive: number;
  neutral: number;
  negative: number;
}

interface ModelUsageData {
  model: string;
  count: number;
  provider: string;
}

interface ConversationFlowData {
  hour: string;
  messages: number;
}

const COLORS = ['hsl(var(--primary))', 'hsl(var(--secondary))', 'hsl(var(--accent))', 'hsl(var(--muted))', 'hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

export default function BrainInsightsDashboard({ userId }: BrainInsightsDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [topicData, setTopicData] = useState<TopicData[]>([]);
  const [sentimentData, setSentimentData] = useState<SentimentData[]>([]);
  const [modelUsageData, setModelUsageData] = useState<ModelUsageData[]>([]);
  const [conversationFlowData, setConversationFlowData] = useState<ConversationFlowData[]>([]);

  useEffect(() => {
    if (userId) {
      fetchInsightsData();
    }
  }, [userId]);

  const analyzeSentiment = (text: string): 'positive' | 'neutral' | 'negative' => {
    const lowerText = text.toLowerCase();
    const positiveWords = ['good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic', 'love', 'best', 'perfect', 'awesome', 'happy', 'thank'];
    const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'worst', 'poor', 'disappointed', 'frustrat', 'angry', 'sad', 'problem', 'issue', 'error', 'fail'];
    
    let positiveCount = 0;
    let negativeCount = 0;
    
    positiveWords.forEach(word => {
      if (lowerText.includes(word)) positiveCount++;
    });
    
    negativeWords.forEach(word => {
      if (lowerText.includes(word)) negativeCount++;
    });
    
    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  };

  const fetchInsightsData = async () => {
    setLoading(true);
    try {
      // Fetch messages for analysis
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Process Topic Distribution
      const topicCounts: Record<string, number> = {};
      messages?.forEach(msg => {
        const topic = msg.topic || 'Uncategorized';
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      });
      const topics = Object.entries(topicCounts)
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      setTopicData(topics);

      // Process Sentiment Trends (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const sentimentByDate: Record<string, { positive: number; neutral: number; negative: number }> = {};
      messages?.forEach(msg => {
        const msgDate = new Date(msg.created_at);
        if (msgDate >= thirtyDaysAgo && msg.role === 'user') {
          const dateKey = msgDate.toISOString().split('T')[0];
          if (!sentimentByDate[dateKey]) {
            sentimentByDate[dateKey] = { positive: 0, neutral: 0, negative: 0 };
          }
          const sentiment = analyzeSentiment(msg.content);
          sentimentByDate[dateKey][sentiment]++;
        }
      });
      
      const sentiments = Object.entries(sentimentByDate)
        .map(([date, counts]) => ({ date, ...counts }))
        .sort((a, b) => a.date.localeCompare(b.date));
      setSentimentData(sentiments);

      // Process Model Usage Patterns
      const modelCounts: Record<string, { count: number; provider: string }> = {};
      messages?.forEach(msg => {
        if (msg.model_used && msg.role === 'assistant') {
          const key = msg.model_used;
          if (!modelCounts[key]) {
            modelCounts[key] = { count: 0, provider: msg.provider || 'Unknown' };
          }
          modelCounts[key].count++;
        }
      });
      const models = Object.entries(modelCounts)
        .map(([model, data]) => ({ model, count: data.count, provider: data.provider }))
        .sort((a, b) => b.count - a.count);
      setModelUsageData(models);

      // Process Conversation Flow (messages by hour of day)
      const flowByHour: Record<string, number> = {};
      for (let i = 0; i < 24; i++) {
        flowByHour[i.toString().padStart(2, '0')] = 0;
      }
      messages?.forEach(msg => {
        const hour = new Date(msg.created_at).getHours().toString().padStart(2, '0');
        flowByHour[hour]++;
      });
      const flow = Object.entries(flowByHour)
        .map(([hour, messages]) => ({ hour: `${hour}:00`, messages }));
      setConversationFlowData(flow);

    } catch (error) {
      console.error('Error fetching insights:', error);
    } finally {
      setLoading(false);
    }
  };

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="h-6 w-6 text-primary" />
        <h2 className="text-2xl font-bold">Brain Insights Dashboard</h2>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Topic Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Topic Distribution
            </CardTitle>
            <CardDescription>Most discussed topics in your conversations</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                count: {
                  label: "Messages",
                  color: "hsl(var(--primary))",
                },
              }}
              className="h-[300px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topicData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="topic" 
                    angle={-45}
                    textAnchor="end"
                    height={100}
                    fontSize={12}
                  />
                  <YAxis />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Sentiment Trends */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Sentiment Trends
            </CardTitle>
            <CardDescription>Emotional tone of your messages over time</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                positive: {
                  label: "Positive",
                  color: "hsl(142, 76%, 36%)",
                },
                neutral: {
                  label: "Neutral",
                  color: "hsl(var(--muted-foreground))",
                },
                negative: {
                  label: "Negative",
                  color: "hsl(0, 84%, 60%)",
                },
              }}
              className="h-[300px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sentimentData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" fontSize={12} />
                  <YAxis />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend />
                  <Line type="monotone" dataKey="positive" stroke="hsl(142, 76%, 36%)" strokeWidth={2} />
                  <Line type="monotone" dataKey="neutral" stroke="hsl(var(--muted-foreground))" strokeWidth={2} />
                  <Line type="monotone" dataKey="negative" stroke="hsl(0, 84%, 60%)" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Model Usage Patterns */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5" />
              Model Usage Patterns
            </CardTitle>
            <CardDescription>AI models you've interacted with</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                count: {
                  label: "Usage Count",
                  color: "hsl(var(--primary))",
                },
              }}
              className="h-[300px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={modelUsageData}
                    dataKey="count"
                    nameKey="model"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    label={(entry) => `${entry.model.split('/').pop()}: ${entry.count}`}
                  >
                    {modelUsageData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Conversation Flow Analysis */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Conversation Flow
            </CardTitle>
            <CardDescription>Message activity by hour of day</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                messages: {
                  label: "Messages",
                  color: "hsl(var(--accent))",
                },
              }}
              className="h-[300px]"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={conversationFlowData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="hour" fontSize={12} />
                  <YAxis />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="messages" fill="hsl(var(--accent))" />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
