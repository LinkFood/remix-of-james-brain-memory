/**
 * AuthLayout — Layout wrapper for all authenticated routes.
 *
 * Structure: TopNav (top) + JacSidebar (left) + Page Content (center) + Ticker (bottom).
 * Provides single useJacAgent instance shared across all pages via JacContext.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useJacAgent } from '@/hooks/useJacAgent';
import { JacContext } from '@/contexts/JacContext';
import { TopNav } from '@/components/TopNav';
import { JacSidebar } from '@/components/JacSidebar';
import { useSidebarState } from '@/hooks/useSidebarState';

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
}

export function AuthLayout({ children }: AuthLayoutProps) {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const isMobile = useMediaQuery('(max-width: 768px)');
  const { isCollapsed, toggleCollapsed } = useSidebarState();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const jacAgent = useJacAgent(userId);

  if (!userId) return null;

  return (
    <JacContext.Provider value={jacAgent}>
      <div className="h-screen flex flex-col bg-background overflow-hidden">
        {/* TopNav */}
        <TopNav userId={userId} />

        {/* Main area: sidebar + page content */}
        <div className="flex-1 flex overflow-hidden">
          {/* JacSidebar — desktop: inline panel, mobile: FAB + Sheet */}
          <JacSidebar
            isCollapsed={isCollapsed}
            onToggleCollapsed={toggleCollapsed}
            isMobile={isMobile}
          />

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
