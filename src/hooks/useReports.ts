/**
 * useReports — Queries brain_reports for the Reports page and widget.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface BrainReport {
  id: string;
  report_type: string;
  source: string;
  title: string | null;
  summary: string | null;
  body_markdown: string | null;
  key_themes: string[];
  decisions: string[];
  insights: string[];
  metadata: Record<string, unknown>;
  entry_id: string | null;
  task_id: string | null;
  created_at: string;
}

export type ReportFilter = 'all' | 'morning_brief' | 'research' | 'market_snapshot' | 'generated';

interface UseReportsOptions {
  userId: string;
  filter?: ReportFilter;
  limit?: number;
}

export function useReports({ userId, filter = 'all', limit = 50 }: UseReportsOptions) {
  const [reports, setReports] = useState<BrainReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  const fetchReports = useCallback(async () => {
    if (!userId) return;

    let query = (supabase
      .from('brain_reports' as any)
      .select('id, report_type, source, title, summary, body_markdown, key_themes, decisions, insights, metadata, entry_id, task_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit) as any);

    if (filter === 'morning_brief') {
      query = query.eq('report_type', 'morning_brief');
    } else if (filter === 'research') {
      query = query.eq('report_type', 'research');
    } else if (filter === 'market_snapshot') {
      query = query.eq('report_type', 'market_snapshot');
    } else if (filter === 'generated') {
      query = query.in('report_type', ['daily', 'weekly', 'monthly']);
    }

    const { data } = await query;

    if (data) {
      setReports((data as unknown as any[]).map((r: any) => ({
        id: r.id,
        report_type: r.report_type,
        source: r.source || 'generate-brain-report',
        title: r.title,
        summary: r.summary,
        body_markdown: r.body_markdown,
        key_themes: Array.isArray(r.key_themes) ? r.key_themes : [],
        decisions: Array.isArray(r.decisions) ? r.decisions : [],
        insights: Array.isArray(r.insights) ? r.insights : [],
        metadata: r.metadata || {},
        entry_id: r.entry_id,
        task_id: r.task_id,
        created_at: r.created_at,
      })));
    }
  }, [userId, filter, limit]);

  useEffect(() => {
    if (!userId) return;
    setIsLoading(true);
    fetchReports().finally(() => setIsLoading(false));
  }, [userId, fetchReports]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`brain-reports-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'brain_reports',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchReports(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchReports]);

  const generateReport = useCallback(async (reportType: 'daily' | 'weekly' | 'monthly') => {
    setIsGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');

      const res = await supabase.functions.invoke('generate-brain-report', {
        body: { reportType },
      });

      if (res.error) throw res.error;
      await fetchReports();
      return res.data;
    } finally {
      setIsGenerating(false);
    }
  }, [fetchReports]);

  return { reports, isLoading, isGenerating, generateReport, refetch: fetchReports };
}
