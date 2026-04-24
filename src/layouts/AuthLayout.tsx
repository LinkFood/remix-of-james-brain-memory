/**
 * AuthLayout — Layout wrapper for all authenticated routes.
 *
 * Structure: TopNav (top) + JacSidebar (left) + Page Content (center) + Ticker (bottom).
 * Provides single useJacAgent instance shared across all pages via JacContext.
 */

import { useCallback, useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacContext } from '@/contexts/JacContext';
import { TopNav } from '@/components/nav/TopNav';
import { JacSidebar } from '@/components/JacSidebar';
import { useSidebarState } from '@/hooks/useSidebarState';
import { ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';

const CHAT_SIDEBAR_STORAGE_KEY = 'ct-chat-sidebar-collapsed';

/**
 * CollapsibleSidebar — Wraps the per-page custom sidebar (e.g. Co-Trader ChatPanel)
 * with a hide/show toggle. Persists collapsed state in localStorage so the user
 * can banish the chat when they want tape real estate.
 */
function CollapsibleSidebar({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(CHAT_SIDEBAR_STORAGE_KEY) === '1'; }
    catch { return false; }
  });

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(CHAT_SIDEBAR_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <div className="w-9 shrink-0 border-r border-border bg-card/60 flex flex-col items-center py-2">
        <button
          onClick={toggle}
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Open chat"
          title="Open Claude chat"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <MessageSquare className="w-3.5 h-3.5 text-muted-foreground/40 mt-2" />
      </div>
    );
  }

  return (
    <div className="relative shrink-0 transition-all duration-150">
      <button
        onClick={toggle}
        className="absolute top-1.5 right-1.5 z-10 w-6 h-6 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Hide chat"
        title="Hide Claude chat"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      {children}
    </div>
  );
}

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

interface AuthLayoutProps {
  children: React.ReactNode;
  /** When true, suppress the JacSidebar (for routes that bring their own chat). */
  hideSidebar?: boolean;
  /** Custom sidebar to render in place of JacSidebar (e.g. Co-Trader ChatPanel). */
  sidebar?: React.ReactNode;
}

export function AuthLayout({ children, hideSidebar = false, sidebar }: AuthLayoutProps) {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [authLoading, setAuthLoading] = useState(true);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const { isCollapsed, toggleCollapsed } = useSidebarState();
  const initialCheckDone = useRef(false);

  useEffect(() => {
    // Use getUser() instead of getSession() — server-validated, no stale tokens
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        navigate('/auth');
        return;
      }
      setUserId(user.id);
      setAuthLoading(false);
      initialCheckDone.current = true;
    }).catch(() => {
      navigate('/auth');
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Don't redirect during initial mount — getUser() handles that
      if (!initialCheckDone.current) return;

      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const jacAgent = useJacAgent(userId);

  // Show nothing while auth is loading — prevents flash redirect
  if (authLoading || !userId) return null;

  return (
    <JacContext.Provider value={jacAgent}>
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* TopNav */}
        <TopNav userId={userId} />

        {/* Main area: sidebar + page content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Custom sidebar takes priority (e.g. Co-Trader ChatPanel); else JacSidebar unless hidden */}
          {sidebar ? (
            <CollapsibleSidebar>{sidebar}</CollapsibleSidebar>
          ) : !hideSidebar ? (
            <JacSidebar
              isCollapsed={isCollapsed}
              onToggleCollapsed={toggleCollapsed}
              isMobile={isMobile}
            />
          ) : null}

          {/* Page content */}
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>

        {/* Ticker is still rendered in App.tsx at the TrackedRoutes level */}
      </div>
    </JacContext.Provider>
  );
}
