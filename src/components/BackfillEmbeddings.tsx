import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Sparkles, Loader2, CheckCircle } from "lucide-react";
import { toast } from "sonner";

interface BackfillEmbeddingsProps {
  userId: string;
}

const BackfillEmbeddings = ({ userId }: BackfillEmbeddingsProps) => {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalProcessed, setTotalProcessed] = useState(0);
  const [complete, setComplete] = useState(false);

  const handleBackfill = async () => {
    setLoading(true);
    setProgress(0);
    setTotalProcessed(0);
    setComplete(false);

    try {
      let hasMore = true;
      let batchCount = 0;

      while (hasMore) {
        const { data, error } = await supabase.functions.invoke("backfill-embeddings", {
          body: { userId, batchSize: 50 },
        });

        if (error) throw error;

        setTotalProcessed((prev) => prev + (data.processed || 0));
        batchCount++;

        if (data.remaining > 0) {
          const estimatedTotal = totalProcessed + data.remaining;
          setProgress((totalProcessed / estimatedTotal) * 100);
          
          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        hasMore = data.hasMore;

        if (!hasMore) {
          setProgress(100);
          setComplete(true);
          toast.success(`Successfully processed ${totalProcessed + data.processed} messages!`);
        }
      }
    } catch (error: any) {
      toast.error("Failed to backfill embeddings: " + error.message);
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  if (complete) {
    return (
      <Card className="p-6 bg-card border-border">
        <div className="flex items-center gap-4">
          <CheckCircle className="w-8 h-8 text-green-500" />
          <div>
            <h3 className="text-lg font-semibold text-foreground">Embeddings Updated!</h3>
            <p className="text-sm text-muted-foreground">
              Successfully processed {totalProcessed} messages. Semantic search is now available for all your conversations.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6 bg-card border-border">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Enable Semantic Search</h3>
            <p className="text-sm text-muted-foreground">
              Generate AI embeddings for your existing messages to enable powerful semantic search
            </p>
          </div>
        </div>

        {loading && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Processing messages...</span>
              <span className="text-foreground font-medium">{totalProcessed} processed</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        <Button
          onClick={handleBackfill}
          disabled={loading}
          className="w-full bg-primary hover:bg-primary-glow text-primary-foreground"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Embeddings
            </>
          )}
        </Button>

        <p className="text-xs text-muted-foreground">
          This process may take a few minutes depending on how many messages you have. 
          You can close this and continue using the app while it processes in the background.
        </p>
      </div>
    </Card>
  );
};

export default BackfillEmbeddings;
