/**
 * TopNav — The Deck. Always visible, full width.
 *
 * Left: navigation links (Dashboard, Code, Calendar, Search, Activity, Brain).
 * Right: token counter, clock + overdue badge, kill switch.
 */

import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  LayoutDashboard, Code2, CalendarDays, Search, Activity, Users, Brain, Timer,
  Clock, Zap, DollarSign, OctagonX, Settings, Heart, FileBarChart, MessageSquare,
  AlertTriangle, X,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useClock } from '@/hooks/useClock';
import { useKillSwitch } from '@/hooks/useKillSwitch';
import { useTokenCounter } from '@/hooks/useTokenCounter';
import { useTickerData } from '@/hooks/useTickerData';

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/jac', label: 'JAC', icon: <MessageSquare className="w-4 h-4" /> },
  { path: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-4 h-4" /> },
  { path: '/code', label: 'Code', icon: <Code2 className="w-4 h-4" /> },
  { path: '/calendar', label: 'Calendar', icon: <CalendarDays className="w-4 h-4" /> },
  { path: '/search', label: 'Search', icon: <Search className="w-4 h-4" /> },
  { path: '/activity', label: 'Activity', icon: <Activity className="w-4 h-4" /> },
  { path: '/agents', label: 'Agents', icon: <Users className="w-4 h-4" /> },
  { path: '/brain', label: 'Brain', icon: <Brain className="w-4 h-4" /> },
  { path: '/crons', label: 'Crons', icon: <Timer className="w-4 h-4" /> },
  { path: '/reports', label: 'Reports', icon: <FileBarChart className="w-4 h-4" /> },
];

interface TopNavProps {
  userId: string;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function TopNav({ userId }: TopNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const time = useClock();
  const { killAll, isKilling } = useKillSwitch();
  const { totalCostToday, recentTasks } = useTokenCounter(userId);
  const { runningTasks, reminders } = useTickerData(userId);

  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [healthAlerts, setHealthAlerts] = useState<{ id: string; title: string; body: string }[]>([]);

  // Check for last heartbeat insight
  useEffect(() => {
    if (!userId) return;
    supabase
      .from('brain_insights')
      .select('created_at')
      .eq('user_id', userId)
      .eq('type', 'heartbeat')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          setLastHeartbeat((data[0] as { created_at: string }).created_at);
        }
      });
  }, [userId]);

  // Check for active system_health alerts
  useEffect(() => {
    if (!userId) return;
    const fetchAlerts = () => {
      supabase
        .from('brain_insights')
        .select('id, title, body')
        .eq('user_id', userId)
        .eq('type', 'system_health')
        .eq('dismissed', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(5)
        .then(({ data }) => {
          setHealthAlerts((data as { id: string; title: string; body: string }[]) || []);
        });
    };
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 60_000); // refresh every minute
    return () => clearInterval(interval);
  }, [userId]);

  const dismissHealthAlert = async (id: string) => {
    setHealthAlerts(prev => prev.filter(a => a.id !== id));
    await supabase
      .from('brain_insights')
      .update({ dismissed: true })
      .eq('id', id)
      .eq('user_id', userId);
  };

  return (
    <nav className="h-10 border-b border-border bg-card/80 backdrop-blur-sm flex items-center px-3 shrink-0 z-50">
      {/* Left — Nav links */}
      <div className="flex items-center gap-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }`}
            >
              {item.icon}
              <span className="hidden lg:inline">{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Right — System vitals */}
      <div className="ml-auto flex items-center gap-2">
        {/* Token counter */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
              <DollarSign className="w-3 h-3" />
              <span>{formatCost(totalCostToday)} today</span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="end">
            <div className="text-xs font-medium mb-2">Today's costs</div>
            <div className="text-lg font-bold mb-3">{formatCost(totalCostToday)}</div>
            {recentTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tasks today.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {recentTasks.map((task) => (
                  <div key={task.id} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-muted-foreground shrink-0">
                        {task.agent ? (AGENT_LABELS[task.agent] || task.agent) : '?'}
                      </span>
                      <span className="truncate text-foreground/70">
                        {task.intent?.slice(0, 40) || 'task'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-muted-foreground">{timeAgo(task.created_at)}</span>
                      <span className="font-mono">{task.cost_usd ? formatCost(task.cost_usd) : '--'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {/* System health alerts */}
        {healthAlerts.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-400 hover:bg-red-500/10 transition-colors animate-pulse">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{healthAlerts.length} alert{healthAlerts.length > 1 ? 's' : ''}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0 bg-zinc-900 border-red-500/30" align="end">
              <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                <span className="text-xs font-medium text-red-400">System Health</span>
              </div>
              <div className="divide-y divide-white/5 max-h-64 overflow-y-auto">
                {healthAlerts.map(alert => (
                  <div key={alert.id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-white/80">{alert.title}</div>
                        <div className="text-[11px] text-white/50 mt-1 whitespace-pre-line">{alert.body}</div>
                      </div>
                      <button
                        onClick={() => dismissHealthAlert(alert.id)}
                        className="shrink-0 p-0.5 text-white/20 hover:text-white/50 transition-colors"
                        title="Dismiss"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Heartbeat indicator */}
        {lastHeartbeat && (
          <div className="flex items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground" title={`Last heartbeat: ${new Date(lastHeartbeat).toLocaleTimeString()}`}>
            <Heart className="w-3 h-3 text-pink-400 animate-pulse" />
          </div>
        )}

        {/* Clock + overdue badge */}
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span className="font-mono">{time}</span>
          {reminders.overdueCount > 0 && (
            <span className="flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
              {reminders.overdueCount}
            </span>
          )}
        </div>

        {/* Kill Switch */}
        <Button
          variant="ghost"
          size="sm"
          className={`h-7 px-2 text-xs gap-1.5 ${
            runningTasks.count > 0
              ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={killAll}
          disabled={isKilling || runningTasks.count === 0}
          title={runningTasks.count > 0 ? 'Kill all running agents' : 'No agents running'}
        >
          {runningTasks.count > 0 ? (
            <>
              <OctagonX className="w-3.5 h-3.5" />
              <span>{runningTasks.count} agent{runningTasks.count > 1 ? 's' : ''}</span>
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5" />
              <span>0 agents</span>
            </>
          )}
        </Button>

        {/* Settings */}
        <button
          onClick={() => navigate('/settings')}
          className={`p-1.5 rounded-md transition-colors ${
            location.pathname === '/settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          }`}
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </nav>
  );
}
