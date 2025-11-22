import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar, TrendingUp, MessageSquare, Clock, ArrowLeft, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { format, startOfYear, endOfYear, eachDayOfInterval, isSameDay, subYears } from "date-fns";

interface TimelineViewProps {
  userId: string;
}

interface ActivityData {
  date: string;
  count: number;
  conversations: number;
}

interface YearStats {
  year: number;
  totalMessages: number;
  totalConversations: number;
  avgMessagesPerDay: number;
  mostActiveDay: { date: string; count: number };
}

const TimelineView = ({ userId }: TimelineViewProps) => {
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [activityData, setActivityData] = useState<ActivityData[]>([]);
  const [yearStats, setYearStats] = useState<YearStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTimelineData();
  }, [selectedYear]);

  const fetchTimelineData = async () => {
    setLoading(true);
    try {
      const yearStart = startOfYear(new Date(selectedYear, 0, 1));
      const yearEnd = endOfYear(new Date(selectedYear, 11, 31));

      // Fetch messages for the selected year
      const { data: messages, error } = await supabase
        .from("messages")
        .select("id, created_at, conversation_id")
        .eq("user_id", userId)
        .gte("created_at", yearStart.toISOString())
        .lte("created_at", yearEnd.toISOString())
        .order("created_at", { ascending: true });

      if (error) throw error;

      // Generate activity heatmap data
      const days = eachDayOfInterval({ start: yearStart, end: yearEnd });
      const activityMap = new Map<string, { count: number; conversations: Set<string> }>();

      messages?.forEach((msg) => {
        const dateKey = format(new Date(msg.created_at), "yyyy-MM-dd");
        if (!activityMap.has(dateKey)) {
          activityMap.set(dateKey, { count: 0, conversations: new Set() });
        }
        const entry = activityMap.get(dateKey)!;
        entry.count++;
        entry.conversations.add(msg.conversation_id);
      });

      const activity = days.map((day) => {
        const dateKey = format(day, "yyyy-MM-dd");
        const data = activityMap.get(dateKey);
        return {
          date: dateKey,
          count: data?.count || 0,
          conversations: data?.conversations.size || 0,
        };
      });

      setActivityData(activity);

      // Fetch year-over-year stats
      await fetchYearOverYearStats();
    } catch (error: any) {
      toast.error("Failed to load timeline data");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const fetchYearOverYearStats = async () => {
    try {
      const years = [selectedYear, selectedYear - 1, selectedYear - 2];
      const statsPromises = years.map(async (year) => {
        const yearStart = startOfYear(new Date(year, 0, 1));
        const yearEnd = endOfYear(new Date(year, 11, 31));

        const { data: messages, error } = await supabase
          .from("messages")
          .select("id, created_at, conversation_id")
          .eq("user_id", userId)
          .gte("created_at", yearStart.toISOString())
          .lte("created_at", yearEnd.toISOString());

        if (error) throw error;

        const conversationIds = new Set(messages?.map((m) => m.conversation_id));
        const days = eachDayOfInterval({ start: yearStart, end: yearEnd });
        const dailyCounts = new Map<string, number>();

        messages?.forEach((msg) => {
          const dateKey = format(new Date(msg.created_at), "yyyy-MM-dd");
          dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        });

        const maxDay = Array.from(dailyCounts.entries()).reduce(
          (max, [date, count]) => (count > max.count ? { date, count } : max),
          { date: "", count: 0 }
        );

        return {
          year,
          totalMessages: messages?.length || 0,
          totalConversations: conversationIds.size,
          avgMessagesPerDay: messages?.length ? messages.length / days.length : 0,
          mostActiveDay: maxDay,
        };
      });

      const stats = await Promise.all(statsPromises);
      setYearStats(stats);
    } catch (error: any) {
      console.error("Failed to fetch year-over-year stats:", error);
    }
  };

  const getHeatmapColor = (count: number) => {
    if (count === 0) return "bg-muted";
    if (count <= 2) return "bg-primary/20";
    if (count <= 5) return "bg-primary/40";
    if (count <= 10) return "bg-primary/60";
    if (count <= 20) return "bg-primary/80";
    return "bg-primary";
  };

  const getHeatmapSize = (count: number) => {
    if (count === 0) return "h-2";
    if (count <= 5) return "h-3";
    if (count <= 10) return "h-4";
    return "h-5";
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto text-center text-muted-foreground py-8">
        <p>Loading timeline...</p>
      </div>
    );
  }

  const currentYearData = yearStats.find((s) => s.year === selectedYear);
  const previousYearData = yearStats.find((s) => s.year === selectedYear - 1);

  const calculateChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Year Selector */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedYear((y) => y - 1)}
            className="border-border hover:bg-secondary"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h2 className="text-2xl font-bold text-foreground">{selectedYear}</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedYear((y) => y + 1)}
            disabled={selectedYear >= new Date().getFullYear()}
            className="border-border hover:bg-secondary"
          >
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="heatmap" className="w-full">
        <TabsList className="grid w-full max-w-md mx-auto grid-cols-3 bg-card border border-border">
          <TabsTrigger
            value="heatmap"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Calendar className="w-4 h-4 mr-2" />
            Activity
          </TabsTrigger>
          <TabsTrigger
            value="timeline"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Clock className="w-4 h-4 mr-2" />
            Timeline
          </TabsTrigger>
          <TabsTrigger
            value="comparison"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <TrendingUp className="w-4 h-4 mr-2" />
            Compare
          </TabsTrigger>
        </TabsList>

        <TabsContent value="heatmap" className="space-y-6 animate-fade-in">
          <Card className="p-6 bg-card border-border">
            <h3 className="text-lg font-semibold text-foreground mb-4">Activity Heatmap</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Your conversation activity throughout {selectedYear}
            </p>

            {/* Heatmap Grid */}
            <div className="space-y-4">
              {/* Month labels */}
              <div className="flex gap-1 pl-12">
                {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(
                  (month, idx) => (
                    <div key={month} className="flex-1 text-xs text-muted-foreground text-center">
                      {month}
                    </div>
                  )
                )}
              </div>

              {/* Heatmap by week */}
              <div className="space-y-1">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, dayIdx) => (
                  <div key={day} className="flex items-center gap-1">
                    <div className="w-10 text-xs text-muted-foreground">{day}</div>
                    <div className="flex gap-1 flex-1">
                      {activityData
                        .filter((d) => new Date(d.date).getDay() === dayIdx)
                        .map((activity) => (
                          <div
                            key={activity.date}
                            className={`flex-1 rounded ${getHeatmapColor(activity.count)} ${getHeatmapSize(
                              activity.count
                            )} hover:ring-2 hover:ring-primary transition-all cursor-pointer group relative`}
                            title={`${format(new Date(activity.date), "MMM d, yyyy")}: ${activity.count} messages in ${
                              activity.conversations
                            } conversations`}
                          >
                            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-popover border border-border rounded text-xs text-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                              {format(new Date(activity.date), "MMM d, yyyy")}
                              <br />
                              {activity.count} messages
                              <br />
                              {activity.conversations} conversations
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Legend */}
              <div className="flex items-center gap-2 pt-4">
                <span className="text-xs text-muted-foreground">Less</span>
                <div className="flex gap-1">
                  <div className="w-3 h-3 rounded bg-muted" />
                  <div className="w-3 h-3 rounded bg-primary/20" />
                  <div className="w-3 h-3 rounded bg-primary/40" />
                  <div className="w-3 h-3 rounded bg-primary/60" />
                  <div className="w-3 h-3 rounded bg-primary/80" />
                  <div className="w-3 h-3 rounded bg-primary" />
                </div>
                <span className="text-xs text-muted-foreground">More</span>
              </div>
            </div>
          </Card>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="p-4 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-3">
                <MessageSquare className="w-8 h-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">
                    {currentYearData?.totalMessages || 0}
                  </p>
                  <p className="text-sm text-muted-foreground">Total Messages</p>
                </div>
              </div>
            </Card>

            <Card className="p-4 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-3">
                <Calendar className="w-8 h-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">
                    {currentYearData?.totalConversations || 0}
                  </p>
                  <p className="text-sm text-muted-foreground">Conversations</p>
                </div>
              </div>
            </Card>

            <Card className="p-4 bg-card border-border hover:border-primary/50 transition-all">
              <div className="flex items-center gap-3">
                <TrendingUp className="w-8 h-8 text-primary" />
                <div>
                  <p className="text-2xl font-bold text-foreground">
                    {currentYearData?.avgMessagesPerDay.toFixed(1) || 0}
                  </p>
                  <p className="text-sm text-muted-foreground">Avg/Day</p>
                </div>
              </div>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="timeline" className="space-y-4 animate-fade-in">
          <Card className="p-6 bg-card border-border">
            <h3 className="text-lg font-semibold text-foreground mb-4">Monthly Timeline</h3>
            <div className="space-y-4">
              {Array.from({ length: 12 }, (_, i) => i).map((monthIdx) => {
                const monthData = activityData.filter(
                  (d) => new Date(d.date).getMonth() === monthIdx
                );
                const monthTotal = monthData.reduce((sum, d) => sum + d.count, 0);
                const monthConversations = new Set(
                  monthData.filter((d) => d.conversations > 0).map((d) => d.date)
                ).size;

                return (
                  <div
                    key={monthIdx}
                    className="flex items-center gap-4 p-4 rounded-lg bg-muted/50 hover:bg-muted transition-all"
                  >
                    <div className="w-20 text-sm font-semibold text-foreground">
                      {format(new Date(selectedYear, monthIdx, 1), "MMMM")}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <div
                          className="h-2 bg-primary rounded-full transition-all"
                          style={{ width: `${(monthTotal / Math.max(...activityData.map((d) => d.count))) * 100}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {monthTotal} messages · {monthConversations} active days
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-foreground">{monthTotal}</p>
                      <p className="text-xs text-muted-foreground">messages</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="comparison" className="space-y-6 animate-fade-in">
          <Card className="p-6 bg-card border-border">
            <h3 className="text-lg font-semibold text-foreground mb-4">Year-over-Year Comparison</h3>
            <div className="space-y-6">
              {yearStats.map((yearData, idx) => {
                const isCurrentYear = yearData.year === selectedYear;
                const previousYear = yearStats[idx + 1];
                const messageChange = previousYear
                  ? calculateChange(yearData.totalMessages, previousYear.totalMessages)
                  : 0;

                return (
                  <div key={yearData.year} className={isCurrentYear ? "order-first" : ""}>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-xl font-bold text-foreground">{yearData.year}</h4>
                      {previousYear && (
                        <div
                          className={`flex items-center gap-1 text-sm font-semibold ${
                            messageChange >= 0 ? "text-green-500" : "text-red-500"
                          }`}
                        >
                          <TrendingUp className={`w-4 h-4 ${messageChange < 0 ? "rotate-180" : ""}`} />
                          {Math.abs(messageChange)}% vs {previousYear.year}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="p-4 rounded-lg bg-muted/50">
                        <p className="text-2xl font-bold text-foreground">{yearData.totalMessages}</p>
                        <p className="text-sm text-muted-foreground">Messages</p>
                      </div>
                      <div className="p-4 rounded-lg bg-muted/50">
                        <p className="text-2xl font-bold text-foreground">{yearData.totalConversations}</p>
                        <p className="text-sm text-muted-foreground">Conversations</p>
                      </div>
                      <div className="p-4 rounded-lg bg-muted/50">
                        <p className="text-2xl font-bold text-foreground">
                          {yearData.avgMessagesPerDay.toFixed(1)}
                        </p>
                        <p className="text-sm text-muted-foreground">Avg/Day</p>
                      </div>
                      <div className="p-4 rounded-lg bg-muted/50">
                        <p className="text-2xl font-bold text-foreground">{yearData.mostActiveDay.count}</p>
                        <p className="text-sm text-muted-foreground">Peak Day</p>
                        {yearData.mostActiveDay.date && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {format(new Date(yearData.mostActiveDay.date), "MMM d")}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default TimelineView;
