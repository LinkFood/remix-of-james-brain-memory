/**
 * JAC — The Nerve Center
 *
 * Split layout: chat on the left, reactive context panel on the right.
 * Mobile: context panel behind a Sheet (same as before).
 * The context panel auto-reacts to what's happening — agents, brain, code.
 */

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';
import {
  ArrowLeft, Zap, PanelRight, PanelRightClose, Square,
} from 'lucide-react';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacChat } from '@/components/jac/JacChat';
import { ContextPanel } from '@/components/jac/ContextPanel';

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

const Jac = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { messages, tasks, activityLogs, loading, sending, backendReady, sendMessage, loadTaskLogs, stopTask, stopAllTasks } = useJacAgent(userId);

  // Derive the type of the most recent task for context auto-switching
  const lastMessageType = useMemo(() => {
    const recentTasks = tasks
      .filter(t => t.agent !== 'jac-dispatcher' && (t.status === 'running' || t.status === 'completed'))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return recentTasks[0]?.type || undefined;
  }, [tasks]);

  if (!userId) return null;

  const runningTasks = tasks.filter(t => t.status === 'running');
  const runningCount = runningTasks.length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;

  const activeAgentLabels = [...new Set(
    runningTasks.map(t => AGENT_LABELS[t.agent] || t.agent).filter(Boolean)
  )];

  const contextPanelProps = {
    tasks,
    activityLogs,
    loading,
    onExpandTask: loadTaskLogs,
    onStopTask: stopTask,
    onStopAll: stopAllTasks,
    userId,
    lastMessageType,
  };

  const header = (
    <header className="border-b border-border bg-card/50 backdrop-blur-sm shrink-0 z-40">
      <div className="flex items-center gap-3 px-3 h-10">
        <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7" onClick={() => navigate('/dashboard')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>

        <div className="flex items-center gap-2">
          <Zap className={`w-4 h-4 ${runningCount > 0 ? 'text-blue-400' : 'text-primary/60'}`} />
          <span className="text-sm font-semibold">JAC</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {runningCount > 0 && (
            <span className="text-xs text-blue-400 flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
              </span>
              {runningCount} active
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="relative h-7 w-7"
            onClick={() => {
              if (isMobile) {
                setPanelOpen(true);
              } else {
                setPanelCollapsed(prev => !prev);
              }
            }}
          >
            {panelCollapsed || isMobile ? (
              <PanelRight className="w-4 h-4" />
            ) : (
              <PanelRightClose className="w-4 h-4" />
            )}
            {(runningCount > 0 || completedCount > 0) && (
              <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
            )}
          </Button>
        </div>
      </div>
    </header>
  );

  const workingBar = runningCount > 0 ? (
    <div className="border-b border-border bg-blue-500/5 px-3 flex items-center gap-2 h-8 shrink-0">
      <div className="flex items-center gap-1.5 text-xs text-blue-400 min-w-0 flex-1">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
        <span className="truncate">{activeAgentLabels.join(' · ')}</span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[10px] text-muted-foreground hover:text-red-400 shrink-0"
        onClick={stopAllTasks}
      >
        <Square className="w-3 h-3 mr-1" />
        Stop all
      </Button>
    </div>
  ) : null;

  const backendWarning = !backendReady ? (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-center text-xs text-amber-400 shrink-0">
      Backend not deployed yet. Deploy edge functions to activate agents.
    </div>
  ) : null;

  // Mobile layout — context panel behind a Sheet
  if (isMobile) {
    return (
      <div className="h-[calc(100vh-2rem)] bg-background flex flex-col overflow-hidden">
        {header}
        {backendWarning}
        {workingBar}

        <div className="flex-1 overflow-hidden">
          <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
        </div>

        <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
          <SheetContent side="right" className="w-[400px] sm:max-w-[400px] p-0 flex flex-col">
            <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
              <SheetTitle className="text-sm">Operations</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-hidden">
              <ContextPanel {...contextPanelProps} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  // Desktop layout — resizable split panels
  return (
    <div className="h-[calc(100vh-2rem)] bg-background flex flex-col overflow-hidden">
      {header}
      {backendWarning}
      {workingBar}

      <div className="flex-1 overflow-hidden">
        {panelCollapsed ? (
          // Full-width chat when panel collapsed
          <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
        ) : (
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel defaultSize={65} minSize={40}>
              <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={35} minSize={20}>
              <ContextPanel {...contextPanelProps} />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
};

export default Jac;
