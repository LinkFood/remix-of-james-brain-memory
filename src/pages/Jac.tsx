import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Bot, Activity } from 'lucide-react';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacChat } from '@/components/jac/JacChat';
import { ActivityFeed } from '@/components/jac/ActivityFeed';

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

  const { messages, tasks, activityLogs, loading, sending, sendMessage, loadTaskLogs } = useJacAgent(userId);

  if (!userId) return null;

  return (
    <div className="min-h-screen bg-gradient-bg flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">JAC</h1>
              <p className="text-xs text-muted-foreground">Agent Command Center</p>
            </div>
          </div>

          {/* Running task count */}
          {tasks.filter((t) => t.status === 'running').length > 0 && (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-blue-500">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {tasks.filter((t) => t.status === 'running').length} running
            </div>
          )}
        </div>
      </header>

      {/* Desktop: side-by-side / Mobile: tabs */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Desktop layout */}
        <div className="hidden md:flex flex-1 overflow-hidden">
          <div className="flex-1 border-r border-border flex flex-col">
            <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
          </div>
          <div className="w-96 flex flex-col bg-card/30">
            <div className="p-3 border-b border-border flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium">Activity</span>
              <span className="text-xs text-muted-foreground ml-auto">{tasks.length} tasks</span>
            </div>
            <ActivityFeed tasks={tasks} activityLogs={activityLogs} loading={loading} onExpandTask={loadTaskLogs} />
          </div>
        </div>

        {/* Mobile layout: tabs */}
        <div className="flex-1 flex flex-col md:hidden overflow-hidden">
          <Tabs defaultValue="chat" className="flex-1 flex flex-col">
            <TabsList className="mx-4 mt-2 grid grid-cols-2">
              <TabsTrigger value="chat" className="gap-1.5">
                <Bot className="w-4 h-4" />
                Chat
              </TabsTrigger>
              <TabsTrigger value="activity" className="gap-1.5">
                <Activity className="w-4 h-4" />
                Activity
                {tasks.filter((t) => t.status === 'running').length > 0 && (
                  <span className="ml-1 flex h-2 w-2 rounded-full bg-blue-500" />
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="chat" className="flex-1 m-0 overflow-hidden">
              <JacChat messages={messages} tasks={tasks} sending={sending} onSend={sendMessage} />
            </TabsContent>
            <TabsContent value="activity" className="flex-1 m-0 overflow-hidden">
              <ActivityFeed tasks={tasks} activityLogs={activityLogs} loading={loading} onExpandTask={loadTaskLogs} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
};

export default Jac;
