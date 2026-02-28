/**
 * ContextPanel — Reactive right panel in the Nerve Center
 *
 * Shows Activity, Results, Brain, and Code tabs. Auto-switches based
 * on what's happening — manual selection overrides for 10 seconds.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { ActivityFeed } from './ActivityFeed';
import { AgentResultsFeed } from './AgentResultsFeed';
import {
  ListTodo, BookOpen, Brain, Code2,
  FileText, ExternalLink, GitBranch,
} from 'lucide-react';
import type { AgentTask, ActivityLogEntry } from '@/types/agent';

type TabValue = 'activity' | 'results' | 'brain' | 'code';

interface BrainEntry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  tags: string[];
  created_at: string;
}

interface CodeSessionInfo {
  id: string;
  branch_name: string;
  status: string;
  intent: string;
  pr_url: string | null;
  pr_number: number | null;
  files_written: string[] | null;
  updated_at: string;
}

interface ContextPanelProps {
  tasks: AgentTask[];
  activityLogs: Map<string, ActivityLogEntry[]>;
  loading: boolean;
  onExpandTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
  onStopAll: () => void;
  userId: string;
  lastMessageType?: string;
}

const TYPE_BADGES: Record<string, string> = {
  note: 'bg-blue-500/10 text-blue-400',
  idea: 'bg-violet-500/10 text-violet-400',
  link: 'bg-cyan-500/10 text-cyan-400',
  code: 'bg-indigo-500/10 text-indigo-400',
  contact: 'bg-emerald-500/10 text-emerald-400',
  event: 'bg-amber-500/10 text-amber-400',
  reminder: 'bg-red-500/10 text-red-400',
  list: 'bg-orange-500/10 text-orange-400',
  document: 'bg-slate-500/10 text-slate-400',
  image: 'bg-pink-500/10 text-pink-400',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ContextPanel({
  tasks,
  activityLogs,
  loading,
  onExpandTask,
  onStopTask,
  onStopAll,
  userId,
  lastMessageType,
}: ContextPanelProps) {
  const [activeTab, setActiveTab] = useState<TabValue>('activity');
  const [brainEntries, setBrainEntries] = useState<BrainEntry[]>([]);
  const [codeSessions, setCodeSessions] = useState<CodeSessionInfo[]>([]);
  const [brainLoading, setBrainLoading] = useState(false);
  const [codeLoading, setCodeLoading] = useState(false);
  const manualSelectRef = useRef<number>(0);

  const runningCount = useMemo(() => tasks.filter(t => t.status === 'running').length, [tasks]);
  const completedCount = useMemo(
    () => tasks.filter(t => (t.status === 'completed' || t.status === 'failed') && t.agent !== 'jac-dispatcher').length,
    [tasks]
  );

  // Fetch recent brain entries
  const fetchBrainEntries = useCallback(async () => {
    setBrainLoading(true);
    const { data } = await supabase
      .from('entries')
      .select('id, title, content, content_type, tags, created_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(5);

    if (data) {
      setBrainEntries(data as BrainEntry[]);
    }
    setBrainLoading(false);
  }, [userId]);

  // Fetch recent code sessions
  const fetchCodeSessions = useCallback(async () => {
    setCodeLoading(true);
    const { data } = await supabase
      .from('code_sessions')
      .select('id, branch_name, status, intent, pr_url, pr_number, files_written, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(5);

    if (data) {
      setCodeSessions(data as CodeSessionInfo[]);
    }
    setCodeLoading(false);
  }, [userId]);

  // Load brain + code data on mount
  useEffect(() => {
    fetchBrainEntries();
    fetchCodeSessions();
  }, [fetchBrainEntries, fetchCodeSessions]);

  // Auto-switch tabs based on context
  useEffect(() => {
    const now = Date.now();
    // If user manually selected a tab within the last 10 seconds, don't auto-switch
    if (now - manualSelectRef.current < 10_000) return;

    if (runningCount > 0) {
      setActiveTab('activity');
    } else if (lastMessageType === 'save' || lastMessageType === 'search') {
      setActiveTab('brain');
      fetchBrainEntries();
    } else if (lastMessageType === 'code') {
      setActiveTab('code');
      fetchCodeSessions();
    }
  }, [runningCount, lastMessageType, fetchBrainEntries, fetchCodeSessions]);

  // Auto-switch to results briefly when a task completes
  useEffect(() => {
    if (completedCount > 0 && runningCount === 0 && Date.now() - manualSelectRef.current >= 10_000) {
      setActiveTab('results');
    }
  }, [completedCount, runningCount]);

  const handleTabChange = (value: string) => {
    manualSelectRef.current = Date.now();
    setActiveTab(value as TabValue);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="mx-2 mt-2 grid grid-cols-4 h-8 shrink-0">
          <TabsTrigger value="activity" className="text-[10px] gap-1 h-7 px-1">
            <ListTodo className="w-3 h-3" />
            Ops
            {runningCount > 0 && (
              <span className="flex h-1.5 w-1.5 rounded-full bg-blue-500" />
            )}
          </TabsTrigger>
          <TabsTrigger value="results" className="text-[10px] gap-1 h-7 px-1">
            <BookOpen className="w-3 h-3" />
            Results
            {completedCount > 0 && (
              <span className="text-[9px] text-muted-foreground">{completedCount}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="brain" className="text-[10px] gap-1 h-7 px-1">
            <Brain className="w-3 h-3" />
            Brain
          </TabsTrigger>
          <TabsTrigger value="code" className="text-[10px] gap-1 h-7 px-1">
            <Code2 className="w-3 h-3" />
            Code
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="flex-1 m-0 overflow-hidden">
          <ActivityFeed
            tasks={tasks}
            activityLogs={activityLogs}
            loading={loading}
            onExpandTask={onExpandTask}
            onStopTask={onStopTask}
            onStopAll={onStopAll}
          />
        </TabsContent>

        <TabsContent value="results" className="flex-1 m-0 overflow-hidden">
          <AgentResultsFeed tasks={tasks} activityLogs={activityLogs} />
        </TabsContent>

        <TabsContent value="brain" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-2">
              {brainLoading ? (
                <p className="text-xs text-muted-foreground text-center py-8">Loading entries...</p>
              ) : brainEntries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Brain className="w-8 h-8 opacity-20 mb-2" />
                  <p className="text-sm">No brain entries yet</p>
                  <p className="text-xs opacity-60 mt-1">Save something to see it here</p>
                </div>
              ) : (
                brainEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="p-3 rounded-lg border border-border bg-card/50 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {entry.title || entry.content.slice(0, 60)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {entry.content.slice(0, 120)}
                        </p>
                      </div>
                      <Badge
                        variant="secondary"
                        className={`text-[9px] shrink-0 ${TYPE_BADGES[entry.content_type] || 'bg-muted text-muted-foreground'}`}
                      >
                        {entry.content_type}
                      </Badge>
                    </div>
                    {entry.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {entry.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                        {entry.tags.length > 3 && (
                          <span className="text-[9px] text-muted-foreground/50">+{entry.tags.length - 3}</span>
                        )}
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground/50 mt-1.5">{timeAgo(entry.created_at)}</p>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="code" className="flex-1 m-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-2">
              {codeLoading ? (
                <p className="text-xs text-muted-foreground text-center py-8">Loading sessions...</p>
              ) : codeSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Code2 className="w-8 h-8 opacity-20 mb-2" />
                  <p className="text-sm">No code sessions yet</p>
                  <p className="text-xs opacity-60 mt-1">Ask JAC to write some code</p>
                </div>
              ) : (
                codeSessions.map((session) => (
                  <div
                    key={session.id}
                    className="p-3 rounded-lg border border-border bg-card/50 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <GitBranch className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span className="text-sm font-mono truncate">{session.branch_name}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {session.intent}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={`text-[9px] shrink-0 ${
                          session.status === 'completed' ? 'text-green-500 border-green-500/30' :
                          session.status === 'active' ? 'text-blue-400 border-blue-500/30' :
                          session.status === 'failed' ? 'text-red-400 border-red-500/30' :
                          'text-amber-400 border-amber-500/30'
                        }`}
                      >
                        {session.status}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                      {session.files_written && session.files_written.length > 0 && (
                        <span className="flex items-center gap-1">
                          <FileText className="w-3 h-3" />
                          {session.files_written.length} file{session.files_written.length > 1 ? 's' : ''}
                        </span>
                      )}
                      {session.pr_url && (
                        <a
                          href={session.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-primary hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          PR #{session.pr_number}
                        </a>
                      )}
                      <span>{timeAgo(session.updated_at)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
