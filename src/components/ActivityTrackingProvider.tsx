/**
 * ActivityTrackingProvider — Centralized activity intelligence for JAC Agent OS
 *
 * MILITARY METAPHOR: This is the field intelligence officer embedded in every
 * operation. It observes, records, and reports — without interfering.
 *
 * Instead of wiring tracking into every component individually (fragile),
 * this provider intercepts at key system boundaries:
 * - Supabase RPC/function calls (via fetch interceptor)
 * - Route changes (via navigation listener)
 * - Window events (focus, blur, visibility)
 *
 * The optimization agent reads this data daily to:
 * - Identify usage patterns (what types of content saved most)
 * - Surface underused features
 * - Detect friction points (searches with no results)
 * - Build a user profile for better AI responses
 */

import { useEffect, useRef, useCallback } from 'react';
import type { ActivityCategory } from '@/hooks/useActivityTracker';
import { useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useActivityTracker } from '@/hooks/useActivityTracker';

interface Props {
  userId: string;
  children: React.ReactNode;
}

export function ActivityTrackingProvider({ userId, children }: Props) {
  const { track } = useActivityTracker(userId);
  const location = useLocation();
  const prevPathRef = useRef<string>('');

  // Track page navigation
  useEffect(() => {
    if (location.pathname !== prevPathRef.current) {
      prevPathRef.current = location.pathname;
      track('page_view', 'navigate', {
        path: location.pathname,
        search: location.search,
      });
    }
  }, [location.pathname, location.search, track]);

  // Track session start/end
  useEffect(() => {
    track('session_start', 'navigate', {
      userAgent: navigator.userAgent,
      screenWidth: window.innerWidth,
      screenHeight: window.innerHeight,
    });

    const handleVisibilityChange = () => {
      if (document.hidden) {
        track('tab_hidden', 'navigate');
      } else {
        track('tab_visible', 'navigate');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [track]);

  // Intercept Supabase edge function calls to auto-log them
  useEffect(() => {
    const originalFetch = window.fetch;
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

    if (!supabaseUrl) return;

    const functionsBase = `${supabaseUrl}/functions/v1/`;

    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      // Only intercept Supabase edge function calls
      if (url.startsWith(functionsBase)) {
        const functionName = url.replace(functionsBase, '').split('?')[0];
        const startTime = Date.now();

        // Map function names to activity categories
        const categoryMap: Record<string, { event: string; category: ActivityCategory }> = {
          'smart-save': { event: 'dump_saved', category: 'content' },
          'assistant-chat': { event: 'chat_message', category: 'chat' },
          'search-memory': { event: 'brain_search', category: 'search' },
          'jac-web-search': { event: 'web_search', category: 'search' },
          'jac-dispatcher': { event: 'jac_command', category: 'agent' },
          'classify-content': { event: 'content_classified', category: 'content' },
          'calculate-importance': { event: 'importance_scored', category: 'content' },
          'enrich-entry': { event: 'entry_enriched', category: 'content' },
          'find-related-entries': { event: 'relations_found', category: 'search' },
          'jac-dashboard-query': { event: 'dashboard_query', category: 'chat' },
          'export-all-data': { event: 'data_exported', category: 'settings' },
        };

        const mapping = categoryMap[functionName];

        try {
          const response = await originalFetch.call(window, input, init);

          if (mapping) {
            // Parse body for context (best-effort, don't block)
            let bodyDetail: Record<string, unknown> = {};
            try {
              if (init?.body && typeof init.body === 'string') {
                const parsed = JSON.parse(init.body);
                // Extract safe, non-sensitive fields
                bodyDetail = {
                  ...(parsed.content && { contentLength: parsed.content.length }),
                  ...(parsed.message && { messageLength: parsed.message.length }),
                  ...(parsed.query && { queryLength: parsed.query.length, query: parsed.query.slice(0, 100) }),
                  ...(parsed.format && { format: parsed.format }),
                };
              }
            } catch {
              // Body not JSON or other parse error — ignore
            }

            track(mapping.event, mapping.category, {
              function: functionName,
              status: response.ok ? 'success' : 'error',
              statusCode: response.status,
              durationMs: Date.now() - startTime,
              ...bodyDetail,
            });
          }

          return response;
        } catch (err) {
          if (mapping) {
            track(mapping.event, mapping.category, {
              function: functionName,
              status: 'error',
              error: err instanceof Error ? err.message : 'unknown',
              durationMs: Date.now() - startTime,
            });
          }
          throw err;
        }
      }

      // Non-Supabase requests pass through unmodified
      return originalFetch.call(window, input, init);
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [track]);

  return <>{children}</>;
}
