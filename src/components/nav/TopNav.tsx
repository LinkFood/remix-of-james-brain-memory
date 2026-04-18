/**
 * TopNav — Fixed top navigation bar for all authenticated routes.
 *
 * Layout:
 *   Left   : "Co-Trader" logo → /
 *   Center : Trade / Review / System / More ▾ dropdowns (NavLink-based)
 *   Right  : BookSparkline · UwUsageBadge · cost popover · health alerts ·
 *            heartbeat · clock · kill switch · settings
 *
 * Mobile  : Dropdowns collapse to a hamburger → full-height Sheet menu.
 *
 * Active-state: uses react-router NavLink. Any path under a dropdown's
 * group lights up the trigger.
 */

import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import {
  Clock, Zap, DollarSign, OctagonX, Settings, Heart, AlertTriangle, X,
  ChevronDown, Menu,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useClock } from '@/hooks/useClock';
import { useKillSwitch } from '@/hooks/useKillSwitch';
import { useTokenCounter } from '@/hooks/useTokenCounter';
import { BookSparkline } from '@/components/BookSparkline';
import { useTickerData } from '@/hooks/useTickerData';
import { UwUsageBadge } from '@/components/command/UwUsageBadge';
import { MarketClock } from '@/components/nav/MarketClock';
import { PreflightChip } from '@/components/nav/PreflightChip';
import { KillSwitchButton } from '@/components/nav/KillSwitchButton';

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

interface NavLinkItem {
  path: string;
  label: string;
}

interface NavGroup {
  label: string;
  items: NavLinkItem[];
}

// Groups match the four dropdowns specified in the plan. Only routes actually
// registered in App.tsx are listed here.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Trade',
    items: [
      { path: '/', label: 'Station' },
      { path: '/book', label: 'Book' },
      { path: '/session', label: 'Timeline' },
    ],
  },
  {
    label: 'Review',
    items: [
      { path: '/scorecard', label: 'Scorecard' },
      { path: '/prompts', label: 'Prompt A/B' },
      { path: '/replay', label: 'Replay' },
    ],
  },
  {
    label: 'System',
    items: [
      { path: '/preflight', label: 'Preflight' },
      { path: '/health', label: 'Health' },
      { path: '/crons', label: 'Crons' },
      { path: '/agents', label: 'Agents' },
    ],
  },
  {
    label: 'More',
    items: [
      { path: '/dashboard', label: 'Dashboard' },
      { path: '/jac', label: 'JAC' },
      { path: '/calendar', label: 'Calendar' },
      { path: '/brain', label: 'Brain' },
      { path: '/activity', label: 'Activity' },
      { path: '/reports', label: 'Reports' },
      { path: '/search', label: 'Search' },
      { path: '/code', label: 'Code' },
      { path: '/ct-settings', label: 'CT Config' },
    ],
  },
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

function isGroupActive(group: NavGroup, pathname: string): boolean {
  return group.items.some((i) => i.path === pathname);
}

/**
 * Unresolved ct_ui_errors in the last 24h — drives the red dot on the
 * Health link so a silent UI crash doesn't go unnoticed.
 */
function useUnresolvedUiErrors24h() {
  return useQuery<number>({
    queryKey: ['ct_ui_errors_unresolved_24h'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_ui_errors' as any)
        .select('id', { count: 'estimated', head: true })
        .eq('resolved', false)
        .gte('created_at', since);
      if (error) {
        console.warn('[TopNav] ct_ui_errors count failed:', error);
        return 0;
      }
      return count ?? 0;
    },
  });
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
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: uiErrorCount = 0 } = useUnresolvedUiErrors24h();

  // Last heartbeat insight
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

  // Active system_health alerts
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
    const interval = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(interval);
  }, [userId]);

  const dismissHealthAlert = async (id: string) => {
    setHealthAlerts((prev) => prev.filter((a) => a.id !== id));
    await supabase
      .from('brain_insights')
      .update({ dismissed: true })
      .eq('id', id)
      .eq('user_id', userId);
  };

  // Shared classes for dropdown items — NavLink active state.
  const itemClass = ({ isActive }: { isActive: boolean }) =>
    `block w-full px-2 py-1.5 rounded-md text-xs transition-colors ${
      isActive
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
    }`;

  return (
    <nav className="h-11 border-b border-border bg-card/80 backdrop-blur-sm flex items-center px-3 shrink-0 z-50">
      {/* Mobile: hamburger. Shown < md. */}
      <div className="md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <button
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              aria-label="Open navigation menu"
            >
              <Menu className="w-4 h-4" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0 bg-card">
            <div className="px-4 py-3 border-b border-border">
              <NavLink
                to="/"
                onClick={() => setMobileOpen(false)}
                className="text-sm font-semibold text-primary"
              >
                Co-Trader
              </NavLink>
            </div>
            <div className="p-3 space-y-4 overflow-y-auto">
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 px-2 mb-1">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.path}
                        to={item.path}
                        end={item.path === '/'}
                        onClick={() => setMobileOpen(false)}
                        className={itemClass}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {item.label}
                          {item.path === '/health' && uiErrorCount > 0 && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-red-500"
                              title={`${uiErrorCount} unresolved UI crash${uiErrorCount > 1 ? 'es' : ''}`}
                            />
                          )}
                        </span>
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Left — Logo. Links to /. */}
      <NavLink
        to="/"
        end
        className="hidden md:flex items-center gap-2 mr-4 text-sm font-semibold text-primary hover:text-primary/80 transition-colors"
      >
        Co-Trader
      </NavLink>

      {/* Center — Dropdown groups. Hidden on mobile. */}
      <div className="hidden md:flex items-center gap-0.5">
        {NAV_GROUPS.map((group) => {
          const active = isGroupActive(group, location.pathname);
          const triggerLabel = group.label === 'More' ? 'More' : group.label;
          // Red dot: System contains Health, so show group-level indicator
          // when there are unresolved UI crashes in the last 24h.
          const showCrashDot = group.label === 'System' && uiErrorCount > 0;
          return (
            <DropdownMenu key={group.label}>
              <DropdownMenuTrigger asChild>
                <button
                  className={`relative flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }`}
                >
                  <span>{triggerLabel}</span>
                  <ChevronDown className="w-3 h-3 opacity-60" />
                  {showCrashDot && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 ring-2 ring-card"
                      title={`${uiErrorCount} unresolved UI crash${uiErrorCount > 1 ? 'es' : ''} in the last 24h`}
                    />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40 p-1">
                {group.items.map((item) => (
                  <DropdownMenuItem key={item.path} asChild className="p-0 focus:bg-transparent">
                    <NavLink
                      to={item.path}
                      end={item.path === '/'}
                      className={itemClass}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {item.label}
                        {item.path === '/health' && uiErrorCount > 0 && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-red-500"
                            title={`${uiErrorCount} unresolved UI crash${uiErrorCount > 1 ? 'es' : ''}`}
                          />
                        )}
                      </span>
                    </NavLink>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      </div>

      {/* Right — System vitals */}
      <div className="ml-auto flex items-center gap-2">
        {/* Claude kill switch — emergency halt for watcher/book/alerts/chat commits.
            NOT the same as the "stop agents" button below (that cancels JAC tasks). */}
        <KillSwitchButton />

        {/* Preflight readiness — overall green/yellow/red at a glance */}
        <PreflightChip />

        {/* Claude's book — sparkline of today's closed-trade P&L */}
        <BookSparkline />

        {/* Unusual Whales usage — moved from CommandStation header */}
        <UwUsageBadge />

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
                {healthAlerts.map((alert) => (
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
          <div
            className="flex items-center gap-1 px-1.5 py-1 text-xs text-muted-foreground"
            title={`Last heartbeat: ${new Date(lastHeartbeat).toLocaleTimeString()}`}
          >
            <Heart className="w-3 h-3 text-pink-400 animate-pulse" />
          </div>
        )}

        {/* Clock + overdue badge */}
        <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span className="font-mono">{time}</span>
          {reminders.overdueCount > 0 && (
            <span className="flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
              {reminders.overdueCount}
            </span>
          )}
        </div>

        {/* Kill switch */}
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
              <span className="hidden sm:inline">0 agents</span>
            </>
          )}
        </Button>

        {/* Market clock — NYSE state + countdown */}
        <MarketClock />

        {/* Settings */}
        <button
          onClick={() => navigate('/settings')}
          className={`p-1.5 rounded-md transition-colors ${
            location.pathname === '/settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          }`}
          aria-label="Settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </nav>
  );
}
