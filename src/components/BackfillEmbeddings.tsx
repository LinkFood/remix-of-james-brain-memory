import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Sparkles, Loader2, CheckCircle2, Brain, Clock } from "lucide-react";
import { toast } from "sonner";

interface BackfillEmbeddingsProps {
  userId: string;
}

const BackfillEmbeddings = ({ userId }: BackfillEmbeddingsProps) => {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalProcessed, setTotalProcessed] = useState(0);
  const [totalFailed, setTotalFailed] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [coveragePercentage, setCoveragePercentage] = useState<number | null>(null);

  useEffect(() => {
    fetchCoverage();
  }, [userId]);

  const fetchCoverage = async () => {
    try {
      const { count: totalCount } = await supabase
        .from("messages")
        .select("*", { count: 'exact', head: true })
        .eq("user_id", userId);

      const { count: withEmbedding } = await supabase
        .from("messages")
        .select("*", { count: 'exact', head: true })
        .eq("user_id", userId)
        .not("embedding", "is", null);

      if (totalCount && totalCount > 0) {
        const percentage = Math.round((withEmbedding || 0) / totalCount * 100);
        setCoveragePercentage(percentage);
      }
    } catch (error) {
      console.error("Error fetching embedding coverage:", error);
    }
  };

  const handleBackfill = async () => {
    setLoading(true);
    setProgress(0);
    setTotalProcessed(0);
    setTotalFailed(0);
    setCompleted(false);

    try {
      let hasMore = true;
      let processedCount = 0;
      let failedCount = 0;

      while (hasMore) {
        const { data, error } = await supabase.functions.invoke(
          "backfill-embeddings",
          {
            body: { userId, batchSize: 100 },
          }
        );

        if (error) throw error;

        processedCount += data.processed || 0;
        failedCount += data.failed || 0;
        hasMore = data.hasMore || false;

        setTotalProcessed(processedCount);
        setTotalFailed(failedCount);
        setProgress(hasMore ? 50 : 100);

        if (data.processed > 0) {
          toast.success(`Processed ${data.processed} messages (${failedCount} failed)`);
        }
      }

      setCompleted(true);
      setProgress(100);
      await fetchCoverage();
      toast.success(`Backfill complete! Processed ${processedCount} messages with ${failedCount} failures`);
    } catch (error: any) {
      toast.error("Failed to backfill embeddings");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {completed ? (
        <Card className="p-6 bg-card border-border">
          <div className="flex items-center gap-3 mb-2">
            <CheckCircle2 className="w-6 h-6 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">Embeddings Generated Successfully</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Processed {totalProcessed} messages with {totalFailed} failures. Semantic search is now enabled!
          </p>
          {coveragePercentage !== null && (
            <div className="mt-3 p-3 bg-primary/10 rounded-lg">
              <p className="text-sm font-medium text-primary">
                Embedding Coverage: {coveragePercentage}%
              </p>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-6 bg-card border-border">
          <div className="flex items-center gap-3 mb-2">
            <Brain className="w-6 h-6 text-primary" />
            <h3 className="text-lg font-semibold text-foreground">Generate AI Embeddings</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Generate AI embeddings for your existing messages to enable semantic search and memory recall.
            This process analyzes your conversations and creates vector representations for intelligent search.
          </p>

          {coveragePercentage !== null && (
            <div className="mb-4 p-3 bg-muted rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Current Coverage</span>
                <span className="text-sm font-bold text-primary">{coveragePercentage}%</span>
              </div>
              <Progress value={coveragePercentage} className="h-2" />
            </div>
          )}

          {loading && (
            <div className="space-y-3 mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Processing messages...</span>
                <span className="text-primary font-medium">
                  {totalProcessed} processed {totalFailed > 0 && `• ${totalFailed} failed`}
                </span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          )}

          <Button
            onClick={handleBackfill}
            disabled={loading}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating Embeddings... ({totalProcessed})
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Start Embedding Generation
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Processing in batches of 100. Failed embeddings will be retried automatically.
          </p>
        </Card>
      )}
    </>
  );
};

export default BackfillEmbeddings;
