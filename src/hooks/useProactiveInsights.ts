/**
 * useProactiveInsights - Jac's proactive insight engine
 *
 * Queries the brain_insights table (populated by AI cron job).
 * Falls back to simple overdue/forgotten queries if no AI insights exist.
 * Returns all active insights (not just one).
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type InsightType = 'pattern' | 'overdue' | 'stale' | 'schedule' | 'suggestion' | 'forgotten' | 'unchecked' | 'heartbeat' | 'activity';

export interface BrainInsight {
  id: string;
  type: InsightType;
  title: string;
  body: string;
  priority: number;
  entryIds: string[];
}

export function useProactiveInsights(userId: string | undefined) {
  const [insights, setInsights] = useState<BrainInsight[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchInsights = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Fetch all active AI-generated insights
      const { data: aiInsights, error: aiError } = await supabase
        .from('brain_insights')
        .select('id, type, title, body, priority, entry_ids')
        .eq('user_id', userId)
        .eq('dismissed', false)
        .gt('expires_at', new Date().toISOString())
        .order('priority', { ascending: true });

      const results: BrainInsight[] = [];

      if (!aiError && aiInsights && aiInsights.length > 0) {
        for (const ai of aiInsights) {
          results.push({
            id: ai.id,
            type: ai.type as InsightType,
            title: ai.title,
            body: ai.body,
            priority: ai.priority,
            entryIds: (ai.entry_ids as string[]) || [],
          });
        }
      }

      // Fallback: generate synthetic insights from overdue + stale entries
      if (results.length === 0) {
        const today = new Date().toISOString().split('T')[0];
        const { data: overdue } = await supabase
          .from('entries')
          .select('id, title')
          .eq('user_id', userId)
          .eq('archived', false)
          .lt('event_date', today)
          .in('content_type', ['reminder', 'event'])
          .limit(10);

        if (overdue && overdue.length > 0) {
          results.push({
            id: 'fallback-overdue',
            type: 'overdue',
            title: `${overdue.length} overdue item${overdue.length === 1 ? '' : 's'}`,
            body: overdue.length === 1
              ? `"${overdue[0].title || 'Untitled'}" is past due`
              : `You have ${overdue.length} items past their due date`,
            priority: 1,
            entryIds: overdue.map(e => e.id),
          });
        }

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const { data: stale } = await supabase
          .from('entries')
          .select('id, title')
          .eq('user_id', userId)
          .eq('archived', false)
          .gte('importance_score', 7)
          .lt('updated_at', twoWeeksAgo.toISOString())
          .order('importance_score', { ascending: false })
          .limit(5);

        if (stale && stale.length > 0) {
          results.push({
            id: 'fallback-stale',
            type: 'stale',
            title: `${stale.length} important item${stale.length === 1 ? '' : 's'} going stale`,
            body: `"${stale[0].title || 'Untitled'}" hasn't been touched in 2+ weeks`,
            priority: 2,
            entryIds: stale.map(e => e.id),
          });
        }
      }

      setInsights(results);
    } catch (error) {
      console.error('Failed to check proactive insights:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  const dismiss = useCallback(async (insightId: string) => {
    // Optimistic: remove from local state immediately
    const prev = insights;
    setInsights(curr => curr.filter(i => i.id !== insightId));

    // If it's a real DB insight, persist the dismissal
    if (!insightId.startsWith('fallback-')) {
      const { error } = await supabase
        .from('brain_insights')
        .update({ dismissed: true })
        .eq('id', insightId)
        .eq('user_id', userId);

      if (error) {
        // Rollback on failure
        console.error('Failed to dismiss insight:', error);
        setInsights(prev);
      }
    }
  }, [insights, userId]);

  return { insights, dismiss, loading, refetch: fetchInsights };
}
