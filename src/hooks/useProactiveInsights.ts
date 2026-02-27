/**
 * useProactiveInsights - Jac's proactive insight engine
 *
 * Queries the brain_insights table (populated by AI cron job).
 * Falls back to simple overdue/forgotten queries if no AI insights exist.
 * Shows one insight at a time (dismissible).
 */

import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export type InsightType = 'pattern' | 'overdue' | 'stale' | 'schedule' | 'suggestion' | 'forgotten' | 'unchecked';

export interface ProactiveInsight {
  id?: string;
  type: InsightType;
  message: string;
  count: number;
  entryIds: string[];
}

export function useProactiveInsights(userId: string | undefined) {
  const [insight, setInsight] = useState<ProactiveInsight | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || dismissed) {
      setLoading(false);
      return;
    }

    // Check localStorage for today's dismissal
    const dismissKey = `jac-insight-dismissed-${new Date().toDateString()}`;
    if (localStorage.getItem(dismissKey)) {
      setDismissed(true);
      setLoading(false);
      return;
    }

    const checkInsights = async () => {
      try {
        // First: try AI-generated insights from brain_insights table
        const { data: aiInsights, error: aiError } = await supabase
          .from('brain_insights')
          .select('id, type, title, body, priority, entry_ids')
          .eq('user_id', userId)
          .eq('dismissed', false)
          .gt('expires_at', new Date().toISOString())
          .order('priority', { ascending: true })
          .limit(1);

        if (!aiError && aiInsights && aiInsights.length > 0) {
          const ai = aiInsights[0];
          setInsight({
            id: ai.id,
            type: ai.type as InsightType,
            message: `${ai.title}: ${ai.body}`,
            count: (ai.entry_ids as string[])?.length || 0,
            entryIds: (ai.entry_ids as string[]) || [],
          });
          setLoading(false);
          return;
        }

        // Fallback: simple overdue/forgotten queries (same as before)
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
          setInsight({
            type: 'overdue',
            message: overdue.length === 1
              ? `"${overdue[0].title || 'Untitled'}" is overdue`
              : `You have ${overdue.length} overdue items`,
            count: overdue.length,
            entryIds: overdue.map(e => e.id),
          });
          setLoading(false);
          return;
        }

        // Check for forgotten entries (not touched in 14 days)
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const { data: forgotten } = await supabase
          .from('entries')
          .select('id, title')
          .eq('user_id', userId)
          .eq('archived', false)
          .eq('starred', false)
          .lt('updated_at', twoWeeksAgo.toISOString())
          .order('importance_score', { ascending: false })
          .limit(3);

        if (forgotten && forgotten.length > 0) {
          setInsight({
            type: 'forgotten',
            message: `"${forgotten[0].title || 'Untitled'}" hasn't been touched in 2 weeks`,
            count: forgotten.length,
            entryIds: forgotten.map(e => e.id),
          });
        }
      } catch (error) {
        console.error('Failed to check proactive insights:', error);
      } finally {
        setLoading(false);
      }
    };

    checkInsights();
  }, [userId, dismissed]);

  const dismiss = async () => {
    // If it's an AI insight with a DB ID, mark dismissed in DB
    if (insight?.id) {
      await supabase
        .from('brain_insights')
        .update({ dismissed: true })
        .eq('id', insight.id)
        .catch(() => {});
    }

    const dismissKey = `jac-insight-dismissed-${new Date().toDateString()}`;
    localStorage.setItem(dismissKey, 'true');
    setDismissed(true);
    setInsight(null);
  };

  return { insight, dismiss, loading };
}
