/**
 * JAC Agent Command Center
 *
 * The HQ. Three zones:
 * - Agent Roster (top) — who's in the office, who's working
 * - Chat (left) — talk to JAC, dispatch agents
 * - Operations (right) — live tasks, agent results, activity logs
 *
 * Mobile: tabs for Chat / Ops. Roster always visible.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Bot, Zap, CheckCircle2,
  ListTodo, BookOpen,
} from 'lucide-react';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacChat } from '@/components/jac/JacChat';
import { ActivityFeed } from '@/components/jac/ActivityFeed';
import { AgentRoster } from '@/components/jac/AgentRoster';
import { AgentResultsFeed } from '@/components/jac/AgentResultsFeed';

const Jac = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { messages, tasks, activityLogs, loading, sending, backendReady, sendMessage, loadTaskLogs } = useJacAgent(userId);

  if (!userId) return null;

  const runningCount = tasks.filter(t => t.status === 'running').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container mx-auto px-4 py-2.5 flex items-center gap-3">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              runningCount > 0 ? 'bg-blue-500/10' : 'bg-primary/5'
            }`}>
              <Zap className={`w-5 h-5 ${runningCount > 0 ? 'text-blue-400' : 'text-primary/60'}`} />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Command Center</h1>
              <p className="text-[10px] text-muted-foreground">JAC Agent OS</p>
            </div>
          </div>

          {/* Status indicators */}
          <div className="ml-auto flex items-center gap-3">
            {runningCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs text-blue-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                {runningCount} active
              </div>
            )}
            {completedCount > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3 h-3 text-green-500" />
                {completedCount}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Agent Roster — always visible */}
      <div className="border-b border-border bg-card/20">
        <div className="container mx-auto px-4 py-3">
          <AgentRoster tasks={tasks} />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Desktop: side-by-side */}
        <div className="hidden md:flex flex-1 overflow-hidden">
          {/* Chat panel */}
          <div className="flex-1 border-r border-border flex flex-col min-w-0">
            <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
          </div>

          {/* Operations panel */}
          <div className="w-[400px] flex flex-col bg-card/20">
            <Tabs defaultValue="operations" className="flex-1 flex flex-col">
              <TabsList className="mx-3 mt-2 grid grid-cols-2 h-8">
                <TabsTrigger value="operations" className="text-xs gap-1.5 h-7">
                  <ListTodo className="w-3.5 h-3.5" />
                  Operations
                  {runningCount > 0 && (
                    <span className="ml-0.5 flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                  )}
                </TabsTrigger>
                <TabsTrigger value="results" className="text-xs gap-1.5 h-7">
                  <BookOpen className="w-3.5 h-3.5" />
                  Results
                  {completedCount > 0 && (
                    <span className="ml-0.5 text-[10px] text-muted-foreground">{completedCount}</span>
                  )}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="operations" className="flex-1 m-0 overflow-hidden">
                <ActivityFeed tasks={tasks} activityLogs={activityLogs} loading={loading} onExpandTask={loadTaskLogs} />
              </TabsContent>
              <TabsContent value="results" className="flex-1 m-0 overflow-hidden">
                <AgentResultsFeed tasks={tasks} activityLogs={activityLogs} />
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* Mobile: tabs */}
        <div className="flex-1 flex flex-col md:hidden overflow-hidden">
          <Tabs defaultValue="chat" className="flex-1 flex flex-col">
            <TabsList className="mx-3 mt-2 grid grid-cols-3 h-8">
              <TabsTrigger value="chat" className="text-xs gap-1 h-7">
                <Bot className="w-3.5 h-3.5" />
                Chat
              </TabsTrigger>
              <TabsTrigger value="ops" className="text-xs gap-1 h-7">
                <ListTodo className="w-3.5 h-3.5" />
                Ops
                {runningCount > 0 && (
                  <span className="ml-0.5 flex h-1.5 w-1.5 rounded-full bg-blue-500" />
                )}
              </TabsTrigger>
              <TabsTrigger value="results" className="text-xs gap-1 h-7">
                <BookOpen className="w-3.5 h-3.5" />
                Results
              </TabsTrigger>
            </TabsList>
            <TabsContent value="chat" className="flex-1 m-0 overflow-hidden">
              <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
            </TabsContent>
            <TabsContent value="ops" className="flex-1 m-0 overflow-hidden">
              <ActivityFeed tasks={tasks} activityLogs={activityLogs} loading={loading} onExpandTask={loadTaskLogs} />
            </TabsContent>
            <TabsContent value="results" className="flex-1 m-0 overflow-hidden">
              <AgentResultsFeed tasks={tasks} activityLogs={activityLogs} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
};

export default Jac;
