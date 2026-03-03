/**
 * ReportsWidget — Dashboard widget for the unified reports hub.
 *
 * Two tabs (managed by WidgetChrome):
 *  - Latest: Full markdown-rendered latest report
 *  - Feed: Scrollable list of recent reports
 */

import { useState, useEffect } from 'react';
import { FileBarChart, ChevronRight, Sunrise, FlaskConical, TrendingUp, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { useReports, type BrainReport } from '@/hooks/useReports';
import type { WidgetProps } from '@/types/widget';

const TYPE_BADGE: Record<string, { label: string; color: string; icon: typeof FileText }> = {
  morning_brief: { label: 'Brief', color: 'bg-yellow-500/20 text-yellow-400', icon: Sunrise },
  research: { label: 'Research', color: 'bg-cyan-500/20 text-cyan-400', icon: FlaskConical },
  market_snapshot: { label: 'Market', color: 'bg-emerald-500/20 text-emerald-400', icon: TrendingUp },
  daily: { label: 'Daily', color: 'bg-blue-500/20 text-blue-400', icon: FileText },
  weekly: { label: 'Weekly', color: 'bg-indigo-500/20 text-indigo-400', icon: FileText },
  monthly: { label: 'Monthly', color: 'bg-purple-500/20 text-purple-400', icon: FileText },
};

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

export default function ReportsWidget({ compact, activeTab, onNavigate, expanded }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const tab = activeTab || 'latest';

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) setUserId(session.user.id);
      });
    });
  }, []);

  const { reports, isLoading } = useReports({ userId, limit: 10 });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-[10px] text-white/30">Loading...</span>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
        <FileBarChart className="w-6 h-6" />
        <span className="text-[11px]">No reports yet</span>
      </div>
    );
  }

  // --- FEED TAB ---
  if (tab === 'feed') {
    const limit = compact ? 3 : expanded ? reports.length : 5;
    const visible = reports.slice(0, limit);

    return (
      <div className="flex flex-col h-full overflow-y-auto">
        {visible.map((report) => {
          const badge = TYPE_BADGE[report.report_type] || { label: report.report_type, color: 'bg-white/10 text-white/50', icon: FileText };
          const BadgeIcon = badge.icon;

          return (
            <button
              key={report.id}
              onClick={() => onNavigate(`/reports?reportId=${report.id}`)}
              className="flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0 group"
            >
              <BadgeIcon className="w-3.5 h-3.5 text-white/30 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn('text-[9px] px-1 py-0.5 rounded font-medium uppercase tracking-wide shrink-0', badge.color)}>
                    {badge.label}
                  </span>
                  <span className="text-[9px] text-white/25">{timeAgo(report.created_at)}</span>
                </div>
                <p className="text-[11px] text-white/70 line-clamp-1 mt-0.5">
                  {report.title || 'Untitled'}
                </p>
              </div>
              <ChevronRight className="w-3 h-3 text-white/20 group-hover:text-white/40 shrink-0" />
            </button>
          );
        })}

        {reports.length > limit && (
          <button
            onClick={() => onNavigate('/reports')}
            className="px-3 py-2 text-[10px] text-blue-400/70 hover:text-blue-400 text-center"
          >
            View all reports
          </button>
        )}
      </div>
    );
  }

  // --- LATEST TAB ---
  const latest = reports[0];
  const markdown = latest.body_markdown || latest.summary || 'No content.';
  const displayMarkdown = compact && !expanded && markdown.length > 300
    ? markdown.slice(0, 300) + '...'
    : markdown;

  const badge = TYPE_BADGE[latest.report_type] || { label: latest.report_type, color: 'bg-white/10 text-white/50', icon: FileText };

  return (
    <div className="flex flex-col h-full overflow-y-auto px-3 py-2 gap-2">
      {/* Title */}
      <div className="flex items-center gap-2">
        <span className={cn('text-[9px] px-1 py-0.5 rounded font-medium uppercase tracking-wide', badge.color)}>
          {badge.label}
        </span>
        <span className="text-[9px] text-white/25">{timeAgo(latest.created_at)}</span>
      </div>
      <h3 className="text-xs font-semibold text-white/80 leading-snug">
        {latest.title || 'Untitled Report'}
      </h3>

      {/* Markdown body */}
      <div className="prose prose-sm dark:prose-invert max-w-none
        prose-headings:text-white/80 prose-headings:text-xs prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1
        prose-p:text-[11px] prose-p:text-white/60 prose-p:leading-relaxed prose-p:my-1
        prose-li:text-[11px] prose-li:text-white/60
        prose-ul:my-1 prose-ol:my-1
        prose-strong:text-white/80
        prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
        prose-hr:border-white/10 prose-hr:my-2
        prose-table:text-[11px]
        prose-th:text-white/60 prose-th:font-medium
        prose-td:text-white/50">
        <ReactMarkdown>{displayMarkdown}</ReactMarkdown>
      </div>

      {/* View full report link */}
      <button
        onClick={() => onNavigate(`/reports?reportId=${latest.id}`)}
        className="flex items-center gap-1.5 text-[10px] text-blue-400/70 hover:text-blue-400 mt-1"
      >
        <FileBarChart className="w-3 h-3" />
        View in Reports
      </button>
    </div>
  );
}
