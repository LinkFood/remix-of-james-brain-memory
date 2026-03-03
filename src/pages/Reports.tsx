/**
 * Reports — Unified report hub for all JAC-generated reports.
 *
 * Two-column layout: report list (left 50%) + selected report detail (right 50%).
 * Tabs: All, Briefs, Research, Markets, Generated.
 * Deep linking via ?reportId=xxx and ?tab=xxx.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  FileBarChart,
  Loader2,
  ChevronDown,
  BookOpen,
  ExternalLink,
  Sunrise,
  FlaskConical,
  TrendingUp,
  FileText,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import ReactMarkdown from 'react-markdown';
import { useReports, type BrainReport, type ReportFilter } from '@/hooks/useReports';

// --------------- Constants ---------------

const TYPE_BADGE: Record<string, { label: string; color: string; icon: typeof FileText }> = {
  morning_brief: { label: 'Brief', color: 'bg-yellow-500/20 text-yellow-400', icon: Sunrise },
  research: { label: 'Research', color: 'bg-cyan-500/20 text-cyan-400', icon: FlaskConical },
  market_snapshot: { label: 'Market', color: 'bg-emerald-500/20 text-emerald-400', icon: TrendingUp },
  daily: { label: 'Daily', color: 'bg-blue-500/20 text-blue-400', icon: FileText },
  weekly: { label: 'Weekly', color: 'bg-indigo-500/20 text-indigo-400', icon: FileText },
  monthly: { label: 'Monthly', color: 'bg-purple-500/20 text-purple-400', icon: FileText },
};

const TABS: { key: ReportFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'morning_brief', label: 'Briefs' },
  { key: 'research', label: 'Research' },
  { key: 'market_snapshot', label: 'Markets' },
  { key: 'generated', label: 'Generated' },
];

// --------------- Helpers ---------------

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// --------------- Sub-components ---------------

function ReportCard({
  report,
  isSelected,
  onSelect,
}: {
  report: BrainReport;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const badge = TYPE_BADGE[report.report_type] || { label: report.report_type, color: 'bg-white/10 text-white/50', icon: FileText };
  const BadgeIcon = badge.icon;

  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-2.5 border-b border-white/5 hover:bg-white/[0.03] transition-colors flex items-start gap-2',
        isSelected && 'bg-white/[0.05] border-l-2 border-l-blue-500',
      )}
    >
      <BadgeIcon className="w-3.5 h-3.5 text-white/30 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-[9px] px-1 py-0.5 rounded font-medium uppercase tracking-wide shrink-0', badge.color)}>
            {badge.label}
          </span>
          <span className="text-[10px] text-white/25">{timeAgo(report.created_at)}</span>
        </div>
        <p className="text-xs text-white/70 mt-0.5 line-clamp-1">
          {report.title || 'Untitled Report'}
        </p>
        {report.summary && (
          <p className="text-[10px] text-white/30 mt-0.5 line-clamp-1">
            {report.summary.slice(0, 80)}
          </p>
        )}
      </div>
    </button>
  );
}

function ReportDetail({
  report,
  onNavigate,
}: {
  report: BrainReport;
  onNavigate: (path: string) => void;
}) {
  const badge = TYPE_BADGE[report.report_type] || { label: report.report_type, color: 'bg-white/10 text-white/50', icon: FileText };

  // Determine content to render
  const markdown = report.body_markdown
    || report.summary
    || 'No content available.';

  // Research sources from metadata
  const sources = Array.isArray(report.metadata?.sources)
    ? (report.metadata.sources as Array<{ title?: string; url?: string }>).filter(s => s.url && isSafeUrl(s.url))
    : [];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide', badge.color)}>
            {badge.label}
          </span>
          <span className="text-[10px] text-white/25">
            {new Date(report.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {' '}
            {new Date(report.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
        <h2 className="text-sm font-medium text-white/80">
          {report.title || 'Untitled Report'}
        </h2>
      </div>

      {/* Markdown body */}
      <div className="px-4 py-3 flex-1">
        <div className="prose prose-sm dark:prose-invert max-w-none
          prose-headings:text-white/80 prose-headings:text-xs prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1
          prose-p:text-[11px] prose-p:text-white/60 prose-p:leading-relaxed prose-p:my-1
          prose-li:text-[11px] prose-li:text-white/60
          prose-ul:my-1 prose-ol:my-1
          prose-strong:text-white/80
          prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
          prose-hr:border-white/10 prose-hr:my-2
          prose-table:text-[11px]
          prose-th:text-white/60 prose-th:font-medium prose-th:px-2 prose-th:py-1
          prose-td:text-white/50 prose-td:px-2 prose-td:py-1">
          <ReactMarkdown>{markdown}</ReactMarkdown>
        </div>

        {/* Key themes / decisions / insights for generated reports */}
        {report.key_themes.length > 0 && !report.body_markdown && (
          <div className="mt-3 space-y-2">
            <div>
              <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Key Themes</span>
              <ul className="mt-1 space-y-0.5">
                {report.key_themes.map((t, i) => (
                  <li key={i} className="text-[11px] text-white/60 pl-3 relative before:content-[''] before:absolute before:left-0 before:top-1.5 before:w-1.5 before:h-1.5 before:rounded-full before:bg-indigo-400/40">
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            {report.decisions.length > 0 && (
              <div>
                <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Decisions</span>
                <ul className="mt-1 space-y-0.5">
                  {report.decisions.map((d, i) => (
                    <li key={i} className="text-[11px] text-white/60 pl-3 relative before:content-[''] before:absolute before:left-0 before:top-1.5 before:w-1.5 before:h-1.5 before:rounded-full before:bg-emerald-400/40">
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.insights.length > 0 && (
              <div>
                <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Insights</span>
                <ul className="mt-1 space-y-0.5">
                  {report.insights.map((ins, i) => (
                    <li key={i} className="text-[11px] text-white/60 pl-3 relative before:content-[''] before:absolute before:left-0 before:top-1.5 before:w-1.5 before:h-1.5 before:rounded-full before:bg-yellow-400/40">
                      {ins}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Sources for research reports */}
        {sources.length > 0 && (
          <div className="pt-3 mt-3 border-t border-white/5 space-y-1">
            <span className="text-[9px] text-white/30 uppercase tracking-wider">Sources</span>
            {sources.slice(0, 10).map((s, i) => (
              <a
                key={i}
                href={s.url!}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-[10px] text-cyan-400/70 hover:text-cyan-400 hover:underline truncate"
              >
                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                {s.title || s.url}
              </a>
            ))}
          </div>
        )}

        {/* View in Brain link */}
        {report.entry_id && (
          <button
            onClick={() => onNavigate(`/brain?entryId=${report.entry_id}`)}
            className="flex items-center gap-1.5 text-[10px] text-purple-400/70 hover:text-purple-400 mt-3"
          >
            <BookOpen className="w-3 h-3" />
            View in Brain
          </button>
        )}
      </div>
    </div>
  );
}

// --------------- Page ---------------

const Reports = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [userId, setUserId] = useState('');
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);

  const tabParam = (searchParams.get('tab') || 'all') as ReportFilter;
  const filter = TABS.some(t => t.key === tabParam) ? tabParam : 'all';

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        navigate('/auth');
        return;
      }
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) setUserId(session.user.id);
      });
    });
  }, [navigate]);

  const { reports, isLoading, isGenerating, generateReport } = useReports({
    userId,
    filter,
  });

  // Deep link: ?reportId=xxx
  useEffect(() => {
    const reportId = searchParams.get('reportId');
    if (reportId && reports.length > 0) {
      const found = reports.find(r => r.id === reportId);
      if (found) {
        setSelectedReportId(found.id);
        searchParams.delete('reportId');
        setSearchParams(searchParams, { replace: true });
      }
    }
  }, [reports, searchParams, setSearchParams]);

  // Auto-select first report
  useEffect(() => {
    if (!selectedReportId && reports.length > 0) {
      setSelectedReportId(reports[0].id);
    }
  }, [reports, selectedReportId]);

  const selectedReport = reports.find(r => r.id === selectedReportId);

  const handleTabChange = (tab: ReportFilter) => {
    setSelectedReportId(null);
    setSearchParams({ tab }, { replace: true });
  };

  if (!userId) return null;

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <FileBarChart className="w-4 h-4 text-white/40" />
        <span className="text-sm font-medium text-white/70">Reports</span>
        <span className="text-[10px] text-white/30 font-mono">
          {reports.length} report{reports.length !== 1 ? 's' : ''}
        </span>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <FileBarChart className="w-3 h-3" />
                )}
                Generate
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => generateReport('daily')}>
                Daily Report
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => generateReport('weekly')}>
                Weekly Report
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => generateReport('monthly')}>
                Monthly Report
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 border-b border-white/10 flex">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={cn(
              'px-4 py-2 text-xs font-medium transition-colors border-b-2',
              filter === t.key
                ? 'text-white/80 border-blue-500'
                : 'text-white/40 border-transparent hover:text-white/60',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left column: Report list (50%) */}
        <div className="w-1/2 border-r border-white/10 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
              </div>
            ) : reports.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2">
                <FileBarChart className="w-6 h-6 text-white/20" />
                <span className="text-sm text-white/30">No reports yet</span>
                <span className="text-[10px] text-white/20">
                  Generate one or wait for automated reports
                </span>
              </div>
            ) : (
              reports.map((report) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  isSelected={selectedReportId === report.id}
                  onSelect={() => setSelectedReportId(report.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right column: Report detail (50%) */}
        <div className="w-1/2 flex flex-col overflow-hidden bg-white/[0.01]">
          {selectedReport ? (
            <ReportDetail report={selectedReport} onNavigate={navigate} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <FileBarChart className="w-8 h-8 text-white/10" />
              <span className="text-xs text-white/20">
                Select a report to view
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Reports;
