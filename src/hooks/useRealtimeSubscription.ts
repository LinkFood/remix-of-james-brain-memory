/**
 * useRealtimeSubscription - Supabase realtime subscription hook
 * 
 * Encapsulates Postgres change subscriptions for live data synchronization.
 * Enables instant updates across all browser tabs and devices for the same user.
 * 
 * @module hooks/useRealtimeSubscription
 * 
 * @example
 * ```tsx
 * useRealtimeSubscription({
 *   userId: user.id,
 *   table: 'entries',
 *   onInsert: (entry) => addToLocalState(entry),
 *   onUpdate: (entry) => updateLocalState(entry),
 *   onDelete: (entry) => removeFromLocalState(entry.id),
 * });
 * ```
 * 
 * Features:
 * - Automatic channel cleanup on unmount
 * - User-scoped filtering to prevent cross-user data leaks
 * - Configurable table targeting
 * - Enable/disable toggle for conditional subscriptions
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { RealtimePostgresChangesPayload, RealtimeChannel } from "@supabase/supabase-js";
import type { Entry } from "@/components/EntryCard";

/**
 * Configuration options for realtime subscription
 */
interface UseRealtimeSubscriptionOptions {
  /** The authenticated user's ID for filtering */
  userId: string;
  /** Table to subscribe to (default: 'entries') */
  table?: string;
  /** Callback when a new row is inserted */
  onInsert?: (entry: Entry) => void;
  /** Callback when a row is updated */
  onUpdate?: (entry: Entry) => void;
  /** Callback when a row is deleted */
  onDelete?: (entry: Entry) => void;
  /** Enable/disable the subscription (default: true) */
  enabled?: boolean;
}

export function useRealtimeSubscription({
  userId,
  table = "entries",
  onInsert,
  onUpdate,
  onDelete,
  enabled = true,
}: UseRealtimeSubscriptionOptions): void {
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!enabled || !userId) return;

    const channel = supabase
      .channel(`${table}-realtime-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: `user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<Entry>) => {
          if (payload.eventType === 'INSERT') {
            onInsert?.(payload.new as Entry);
          } else if (payload.eventType === 'UPDATE') {
            onUpdate?.(payload.new as Entry);
          } else if (payload.eventType === 'DELETE') {
            onDelete?.(payload.old as Entry);
          }
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [userId, table, onInsert, onUpdate, onDelete, enabled]);
}
