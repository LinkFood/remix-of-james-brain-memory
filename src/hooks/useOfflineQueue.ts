/**
 * useOfflineQueue - Persist failed saves and retry when online
 */

import { useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface QueuedEntry {
  id: string;
  content: string;
  userId: string;
  source: string;
  imageUrl: string | null;
  timestamp: number;
  retryCount: number;
}

const QUEUE_KEY = "brain-dump-offline-queue";
const MAX_RETRIES = 5;

function getQueue(): QueuedEntry[] {
  try {
    const stored = localStorage.getItem(QUEUE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedEntry[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.error("Failed to save offline queue:", e);
  }
}

export function addToQueue(entry: Omit<QueuedEntry, "id" | "timestamp" | "retryCount">): void {
  const queue = getQueue();
  queue.push({
    ...entry,
    id: `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    retryCount: 0,
  });
  saveQueue(queue);
  console.log(`[OfflineQueue] Added entry, queue size: ${queue.length}`);
}

export function useOfflineQueue(
  onSyncSuccess?: (entry: unknown) => void
): {
  queueLength: number;
  flushQueue: () => Promise<void>;
} {
  const isFlushing = useRef(false);
  const queueLengthRef = useRef(getQueue().length);

  const flushQueue = useCallback(async () => {
    if (isFlushing.current) return;
    
    const queue = getQueue();
    if (queue.length === 0) return;

    isFlushing.current = true;
    console.log(`[OfflineQueue] Flushing ${queue.length} entries...`);

    const remainingQueue: QueuedEntry[] = [];
    let successCount = 0;

    for (const entry of queue) {
      try {
        const { data, error } = await supabase.functions.invoke("smart-save", {
          body: {
            content: entry.content,
            userId: entry.userId,
            source: entry.source,
            imageUrl: entry.imageUrl,
          },
        });

        if (error) throw error;
        if (data.error) throw new Error(data.error);

        successCount++;
        console.log(`[OfflineQueue] Successfully synced entry ${entry.id}`);
        
        if (onSyncSuccess && data.entry) {
          onSyncSuccess(data.entry);
        }
      } catch (e) {
        console.error(`[OfflineQueue] Failed to sync entry ${entry.id}:`, e);
        
        entry.retryCount++;
        if (entry.retryCount < MAX_RETRIES) {
          remainingQueue.push(entry);
        } else {
          console.warn(`[OfflineQueue] Dropping entry ${entry.id} after ${MAX_RETRIES} retries`);
        }
      }
    }

    saveQueue(remainingQueue);
    queueLengthRef.current = remainingQueue.length;
    isFlushing.current = false;

    if (successCount > 0) {
      toast.success(`Synced ${successCount} pending ${successCount === 1 ? "entry" : "entries"}`);
    }

    if (remainingQueue.length > 0) {
      console.log(`[OfflineQueue] ${remainingQueue.length} entries still pending`);
    }
  }, [onSyncSuccess]);

  // Flush queue when coming online
  useEffect(() => {
    const handleOnline = () => {
      console.log("[OfflineQueue] Connection restored, flushing queue...");
      flushQueue();
    };

    window.addEventListener("online", handleOnline);
    
    // Also try to flush on mount if online
    if (navigator.onLine) {
      flushQueue();
    }

    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [flushQueue]);

  return {
    queueLength: queueLengthRef.current,
    flushQueue,
  };
}
