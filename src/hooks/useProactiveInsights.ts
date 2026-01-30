/**
 * useProactiveInsights - Jac's proactive insight engine
 * 
 * Queries for forgotten/overdue entries to surface as a banner.
 * Shows one insight per day (dismissible), prioritizing overdue > forgotten.
 */

import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface ProactiveInsight {
  type: 'forgotten' | 'overdue' | 'unchecked';
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
        // Check for overdue reminders/events
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

  const dismiss = () => {
    const dismissKey = `jac-insight-dismissed-${new Date().toDateString()}`;
    localStorage.setItem(dismissKey, 'true');
    setDismissed(true);
    setInsight(null);
  };

  return { insight, dismiss, loading };
}
