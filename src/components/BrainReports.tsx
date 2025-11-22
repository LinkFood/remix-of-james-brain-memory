import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Brain, FileText, Loader2, Trash2, Calendar, Sparkles, TrendingUp, Target, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { format, subDays, subWeeks, subMonths, startOfDay, endOfDay } from "date-fns";

interface BrainReportsProps {
  userId: string;
}

interface BrainReport {
  id: string;
  report_type: string;
  start_date: string;
  end_date: string;
  summary: string;
  key_themes: Array<{ theme: string; description: string; frequency?: string }>;
  decisions: Array<{ decision: string; context: string; date?: string }>;
  insights: Array<{ insight: string; significance: string }>;
  conversation_stats: {
    total_messages: number;
    user_messages: number;
    assistant_messages: number;
    conversations: number;
    avg_messages_per_conversation: string;
  };
  created_at: string;
}

const BrainReports = ({ userId }: BrainReportsProps) => {
  const [reports, setReports] = useState<BrainReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedReport, setSelectedReport] = useState<BrainReport | null>(null);

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    try {
      const { data, error } = await supabase
        .from("brain_reports")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setReports((data || []) as unknown as BrainReport[]);
    } catch (error: any) {
      toast.error("Failed to load reports");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const generateReport = async (type: "daily" | "weekly" | "monthly") => {
    setGenerating(true);
    try {
      const now = new Date();
      let startDate: Date;
      let endDate = endOfDay(now);

      switch (type) {
        case "daily":
          startDate = startOfDay(subDays(now, 1));
          break;
        case "weekly":
          startDate = startOfDay(subWeeks(now, 1));
          break;
        case "monthly":
          startDate = startOfDay(subMonths(now, 1));
          break;
      }

      const { data, error } = await supabase.functions.invoke("generate-brain-report", {
        body: {
          userId,
          reportType: type,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
      });

      if (error) throw error;

      if (data.error) {
        if (data.error.includes("Rate limit")) {
          toast.error("Rate limit reached. Please try again in a moment.");
        } else if (data.error.includes("credits")) {
          toast.error("AI credits exhausted. Please add credits to continue.");
        } else {
          toast.error(data.error);
        }
        return;
      }

      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} report generated!`);
      await fetchReports();
      if (data.report) {
        setSelectedReport(data.report as unknown as BrainReport);
      }
    } catch (error: any) {
      toast.error("Failed to generate report");
      console.error(error);
    } finally {
      setGenerating(false);
    }
  };

  const deleteReport = async (reportId: string) => {
    try {
      const { error } = await supabase
        .from("brain_reports")
        .delete()
        .eq("id", reportId);

      if (error) throw error;

      toast.success("Report deleted");
      await fetchReports();
      if (selectedReport?.id === reportId) {
        setSelectedReport(null);
      }
    } catch (error: any) {
      toast.error("Failed to delete report");
      console.error(error);
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto text-center text-muted-foreground py-8">
        <p>Loading brain reports...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
            <Brain className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-foreground">Brain Reports</h2>
            <p className="text-sm text-muted-foreground">AI-powered analysis of your conversations</p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={() => generateReport("daily")}
            disabled={generating}
            className="bg-primary hover:bg-primary-glow text-primary-foreground"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Daily
          </Button>
          <Button
            onClick={() => generateReport("weekly")}
            disabled={generating}
            className="bg-primary hover:bg-primary-glow text-primary-foreground"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Weekly
          </Button>
          <Button
            onClick={() => generateReport("monthly")}
            disabled={generating}
            className="bg-primary hover:bg-primary-glow text-primary-foreground"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Monthly
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Reports List */}
        <div className="lg:col-span-1 space-y-3 max-h-[600px] overflow-y-auto">
          {reports.length === 0 ? (
            <Card className="p-6 text-center bg-card border-border">
              <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No reports yet. Generate your first brain report!</p>
            </Card>
          ) : (
            reports.map((report) => (
              <Card
                key={report.id}
                className={`p-4 cursor-pointer transition-all hover:border-primary/50 ${
                  selectedReport?.id === report.id ? "border-primary bg-primary/5" : "bg-card border-border"
                }`}
                onClick={() => setSelectedReport(report)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-primary" />
                    <span className="font-semibold text-foreground capitalize">
                      {report.report_type}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteReport(report.id);
                    }}
                    className="h-7 w-7 p-0 hover:bg-destructive/10"
                  >
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  {format(new Date(report.start_date), "MMM d")} - {format(new Date(report.end_date), "MMM d, yyyy")}
                </p>
                <p className="text-sm text-foreground mt-2 line-clamp-2">{report.summary}</p>
              </Card>
            ))
          )}
        </div>

        {/* Report Details */}
        <div className="lg:col-span-2">
          {selectedReport ? (
            <Card className="p-6 bg-card border-border">
              <div className="space-y-6">
                {/* Header */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-2xl font-bold text-foreground capitalize">
                      {selectedReport.report_type} Report
                    </h3>
                    <span className="text-sm text-muted-foreground">
                      Generated {format(new Date(selectedReport.created_at), "MMM d, yyyy 'at' h:mm a")}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-4 h-4" />
                    {format(new Date(selectedReport.start_date), "MMMM d, yyyy")} - {format(new Date(selectedReport.end_date), "MMMM d, yyyy")}
                  </p>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-lg font-bold text-foreground">{selectedReport.conversation_stats.total_messages}</p>
                    <p className="text-xs text-muted-foreground">Messages</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-lg font-bold text-foreground">{selectedReport.conversation_stats.conversations}</p>
                    <p className="text-xs text-muted-foreground">Conversations</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-lg font-bold text-foreground">{selectedReport.key_themes.length}</p>
                    <p className="text-xs text-muted-foreground">Themes</p>
                  </div>
                  <div className="p-3 rounded-lg bg-muted/50">
                    <p className="text-lg font-bold text-foreground">{selectedReport.conversation_stats.avg_messages_per_conversation}</p>
                    <p className="text-xs text-muted-foreground">Avg/Conv</p>
                  </div>
                </div>

                {/* Summary */}
                <div>
                  <h4 className="font-semibold text-foreground mb-2 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-primary" />
                    Summary
                  </h4>
                  <p className="text-foreground leading-relaxed">{selectedReport.summary}</p>
                </div>

                {/* Key Themes */}
                {selectedReport.key_themes.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-primary" />
                      Key Themes
                    </h4>
                    <div className="space-y-3">
                      {selectedReport.key_themes.map((theme, idx) => (
                        <div key={idx} className="p-3 rounded-lg bg-muted/50 border-l-2 border-primary">
                          <p className="font-semibold text-foreground">{theme.theme}</p>
                          <p className="text-sm text-muted-foreground mt-1">{theme.description}</p>
                          {theme.frequency && (
                            <p className="text-xs text-primary mt-1">{theme.frequency}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Decisions */}
                {selectedReport.decisions.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                      <Target className="w-4 h-4 text-primary" />
                      Decisions & Actions
                    </h4>
                    <div className="space-y-3">
                      {selectedReport.decisions.map((decision, idx) => (
                        <div key={idx} className="p-3 rounded-lg bg-muted/50 border-l-2 border-accent">
                          <p className="font-semibold text-foreground">{decision.decision}</p>
                          <p className="text-sm text-muted-foreground mt-1">{decision.context}</p>
                          {decision.date && (
                            <p className="text-xs text-muted-foreground mt-1">{decision.date}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Insights */}
                {selectedReport.insights.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                      <Lightbulb className="w-4 h-4 text-primary" />
                      Key Insights
                    </h4>
                    <div className="space-y-3">
                      {selectedReport.insights.map((insight, idx) => (
                        <div key={idx} className="p-3 rounded-lg bg-muted/50 border-l-2 border-primary/50">
                          <p className="font-semibold text-foreground">{insight.insight}</p>
                          <p className="text-sm text-muted-foreground mt-1">{insight.significance}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card className="p-12 text-center bg-card border-border">
              <Brain className="w-16 h-16 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground">Select a report to view details</p>
              <p className="text-sm text-muted-foreground mt-2">
                Or generate a new report to analyze your conversations
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

export default BrainReports;
