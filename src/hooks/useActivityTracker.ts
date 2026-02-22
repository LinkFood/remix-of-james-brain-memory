/**
 * useActivityTracker — Universal activity logging for JAC Agent OS
 *
 * MILITARY METAPHOR: This is field intelligence. Every meaningful user
 * interaction is captured so the optimization agent can learn patterns,
 * surface insights, and improve the system over time.
 *
 * Design:
 * - Fire-and-forget: never blocks UI, never throws
 * - Batched: collects events and flushes every 2s (or on page unload)
 * - Lightweight: single hook, import anywhere
 * - Session-aware: groups activity by browser session
 *
 * Events are categorized:
 *   content  — dumps, saves, edits, deletes
 *   search   — queries, result clicks
 *   chat     — assistant messages, jac commands
 *   navigate — page views, entry opens
 *   agent    — task dispatches, completions
 *   settings — config changes
 */

import { useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type ActivityCategory = 'content' | 'search' | 'chat' | 'navigate' | 'agent' | 'settings';

export interface ActivityEvent {
  event: string;
  category: ActivityCategory;
  detail?: Record<string, unknown>;
  entryId?: string;
}

// Session ID persists per browser tab
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Global buffer + flush timer (shared across all hook instances)
let eventBuffer: Array<ActivityEvent & { user_id: string; session_id: string; created_at: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let isFlushing = false;

const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER_SIZE = 20;

async function flushBuffer() {
  if (isFlushing || eventBuffer.length === 0) return;
  isFlushing = true;

  const batch = [...eventBuffer];
  eventBuffer = [];

  try {
    const rows = batch.map((e) => ({
      user_id: e.user_id,
      event: e.event,
      category: e.category,
      detail: e.detail || {},
      entry_id: e.entryId || null,
      session_id: e.session_id,
      created_at: e.created_at,
    }));

    const { error } = await supabase.from('user_activity').insert(rows);
    if (error) {
      console.warn('[activity-tracker] Flush failed:', error.message);
      // Put back failed events (but cap to prevent infinite growth)
      if (eventBuffer.length < MAX_BUFFER_SIZE * 2) {
        eventBuffer = [...batch, ...eventBuffer];
      }
    }
  } catch (err) {
    console.warn('[activity-tracker] Flush error:', err);
  } finally {
    isFlushing = false;
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

// Flush on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (eventBuffer.length > 0) {
      // Use sendBeacon for reliability on unload
      const rows = eventBuffer.map((e) => ({
        user_id: e.user_id,
        event: e.event,
        category: e.category,
        detail: e.detail || {},
        entry_id: e.entryId || null,
        session_id: e.session_id,
        created_at: e.created_at,
      }));

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (supabaseUrl && supabaseKey) {
        navigator.sendBeacon(
          `${supabaseUrl}/rest/v1/user_activity`,
          new Blob(
            [JSON.stringify(rows)],
            { type: 'application/json' }
          )
        );
      }
      eventBuffer = [];
    }
  });
}

/**
 * Hook for tracking user activity. Call track() to log an event.
 * Events are batched and flushed every 2 seconds.
 */
export function useActivityTracker(userId: string) {
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // Cleanup timer on unmount of last consumer
  useEffect(() => {
    return () => {
      // Don't clear timer here — other components may still be using it
    };
  }, []);

  const track = useCallback(
    (event: string, category: ActivityCategory, detail?: Record<string, unknown>, entryId?: string) => {
      if (!userIdRef.current) return;

      eventBuffer.push({
        user_id: userIdRef.current,
        event,
        category,
        detail,
        entryId,
        session_id: SESSION_ID,
        created_at: new Date().toISOString(),
      });

      // Flush immediately if buffer is full
      if (eventBuffer.length >= MAX_BUFFER_SIZE) {
        flushBuffer();
      } else {
        scheduleFlush();
      }
    },
    []
  );

  return { track, sessionId: SESSION_ID };
}
