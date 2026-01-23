/**
 * useRealtimeSubscription - Supabase realtime subscription hook
 * 
 * Encapsulates Postgres change subscriptions for the entries table.
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { RealtimePostgresChangesPayload, RealtimeChannel } from "@supabase/supabase-js";
import type { Entry } from "@/components/EntryCard";

interface UseRealtimeSubscriptionOptions {
  userId: string;
  table?: string;
  onInsert?: (entry: Entry) => void;
  onUpdate?: (entry: Entry) => void;
  onDelete?: (entry: Entry) => void;
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
