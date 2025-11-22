import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Star, Loader2 } from "lucide-react";

interface ScoreExistingMessagesProps {
  userId: string;
}

export default function ScoreExistingMessages({ userId }: ScoreExistingMessagesProps) {
  const [isScoring, setIsScoring] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [processed, setProcessed] = useState(0);

  const scoreMessages = async () => {
    setIsScoring(true);
    setProgress(0);
    setProcessed(0);

    try {
      // Fetch all messages without importance scores
      const { data: messages, error } = await supabase
        .from('messages')
        .select('id, content, role')
        .eq('user_id', userId)
        .is('importance_score', null);

      if (error) throw error;

      if (!messages || messages.length === 0) {
        toast.info("All messages already have importance scores!");
        setIsScoring(false);
        return;
      }

      setTotal(messages.length);
      toast.info(`Starting to score ${messages.length} messages...`);

      let successCount = 0;
      let failCount = 0;

      // Process messages in batches to avoid rate limiting
      const batchSize = 5;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        
        await Promise.all(
          batch.map(async (message) => {
            try {
              const { error: scoreError } = await supabase.functions.invoke('calculate-importance', {
                body: { messageId: message.id }
              });

              if (scoreError) {
                console.error(`Error scoring message ${message.id}:`, scoreError);
                failCount++;
              } else {
                successCount++;
              }
            } catch (err) {
              console.error(`Exception scoring message ${message.id}:`, err);
              failCount++;
            }
          })
        );

        setProcessed(i + batch.length);
        setProgress(((i + batch.length) / messages.length) * 100);

        // Small delay between batches to avoid rate limiting
        if (i + batchSize < messages.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      toast.success(`Scored ${successCount} messages successfully!${failCount > 0 ? ` ${failCount} failed.` : ''}`);
    } catch (error) {
      console.error('Error scoring messages:', error);
      toast.error("Failed to score messages. Please try again.");
    } finally {
      setIsScoring(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Star className="h-5 w-5" />
          Score Existing Messages
        </CardTitle>
        <CardDescription>
          Automatically assign importance scores to messages that don't have them yet
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isScoring ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>Processing messages...</span>
              <span>{processed} / {total}</span>
            </div>
            <Progress value={progress} />
            <p className="text-xs text-muted-foreground">
              This may take a few minutes. Please don't close this page.
            </p>
          </div>
        ) : (
          <Button onClick={scoreMessages} className="w-full" disabled={isScoring}>
            {isScoring ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Scoring Messages...
              </>
            ) : (
              <>
                <Star className="mr-2 h-4 w-4" />
                Score All Unscored Messages
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
