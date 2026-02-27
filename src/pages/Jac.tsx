/**
 * JAC — Chat-first AI interface
 *
 * Chat fills the viewport. Everything else is behind a toggle.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  ArrowLeft, Zap, PanelRight, Square,
  ListTodo, BookOpen, Users,
} from 'lucide-react';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacChat } from '@/components/jac/JacChat';
import { ActivityFeed } from '@/components/jac/ActivityFeed';
import { AgentRoster } from '@/components/jac/AgentRoster';
import { AgentResultsFeed } from '@/components/jac/AgentResultsFeed';

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

const Jac = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [opsOpen, setOpsOpen] = useState(false);

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

  if (!userId) return null;

  const runningTasks = tasks.filter(t => t.status === 'running');
  const runningCount = runningTasks.length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;

  // Derive active agent labels for the working bar
  const activeAgentLabels = [...new Set(
    runningTasks.map(t => AGENT_LABELS[t.agent] || t.agent).filter(Boolean)
  )];

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* Slim header */}
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
              onClick={() => setOpsOpen(true)}
            >
              <PanelRight className="w-4 h-4" />
              {(runningCount > 0 || completedCount > 0) && (
                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-blue-500" />
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* Backend not deployed warning */}
      {!backendReady && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-center text-xs text-amber-400 shrink-0">
          Backend not deployed yet. Deploy edge functions to activate agents.
        </div>
      )}

      {/* Working bar — only when agents are running */}
      {runningCount > 0 && (
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
      )}

      {/* Chat — fills remaining space */}
      <div className="flex-1 overflow-hidden">
        <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
      </div>

      {/* Ops Sheet — slides from right */}
      <Sheet open={opsOpen} onOpenChange={setOpsOpen}>
        <SheetContent side="right" className="w-[400px] sm:max-w-[400px] p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-0 shrink-0">
            <SheetTitle className="text-sm">Operations</SheetTitle>
          </SheetHeader>
          <Tabs defaultValue="ops" className="flex-1 flex flex-col overflow-hidden">
            <TabsList className="mx-4 mt-2 grid grid-cols-3 h-8 shrink-0">
              <TabsTrigger value="ops" className="text-xs gap-1 h-7">
                <ListTodo className="w-3 h-3" />
                Ops
                {runningCount > 0 && (
                  <span className="ml-0.5 flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                )}
              </TabsTrigger>
              <TabsTrigger value="results" className="text-xs gap-1 h-7">
                <BookOpen className="w-3 h-3" />
                Results
                {completedCount > 0 && (
                  <span className="ml-0.5 text-[10px] text-muted-foreground">{completedCount}</span>
                )}
              </TabsTrigger>
              <TabsTrigger value="agents" className="text-xs gap-1 h-7">
                <Users className="w-3 h-3" />
                Agents
              </TabsTrigger>
            </TabsList>
            <TabsContent value="ops" className="flex-1 m-0 overflow-hidden">
              <ActivityFeed tasks={tasks} activityLogs={activityLogs} loading={loading} onExpandTask={loadTaskLogs} onStopTask={stopTask} onStopAll={stopAllTasks} />
            </TabsContent>
            <TabsContent value="results" className="flex-1 m-0 overflow-hidden">
              <AgentResultsFeed tasks={tasks} activityLogs={activityLogs} />
            </TabsContent>
            <TabsContent value="agents" className="flex-1 m-0 overflow-hidden p-4 overflow-y-auto">
              <AgentRoster tasks={tasks} activityLogs={activityLogs} />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default Jac;
