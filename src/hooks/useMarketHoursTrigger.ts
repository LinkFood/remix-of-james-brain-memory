/**
 * useMarketHoursTrigger — single global watcher that invalidates every
 * Co-Trader query when the NY market crosses 09:30 or 16:00 ET.
 *
 * Why this exists: many CT hooks gate `refetchInterval` on
 * `isMarketHoursET()`. React Query reads that callback only when a refetch
 * is initiated — pre-bell it returns `false`, so polling never starts. After
 * the bell, the new `30_000` value never gets re-read until window-focus or
 * a hard refresh. James saw this 2026-04-29 morning: loaded /tape pre-bell,
 * Flow Butterfly stayed empty after 9:30 even though backend was healthy.
 *
 * Structural fix per CO-TRADER THESIS tenet 15 — "does this class of
 * failure become impossible going forward?". Mounting this hook once at
 * app root forces every `ct_*` query to refetch on the bell crossing,
 * picking up the live `refetchInterval`. Every gated hook now upgrades
 * for free without remembering to wire up listeners individually.
 *
 * Mounted once in App.tsx inside the QueryClientProvider.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isMarketHoursET } from '@/lib/marketHours';

const CHECK_INTERVAL_MS = 30_000;

export function useMarketHoursTrigger(): void {
  const queryClient = useQueryClient();
  const wasOpen = useRef<boolean>(isMarketHoursET());

  useEffect(() => {
    const tick = () => {
      const isOpen = isMarketHoursET();
      if (isOpen !== wasOpen.current) {
        wasOpen.current = isOpen;
        // Invalidate every CT query so refetchInterval gets re-read.
        queryClient.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey[0];
            return typeof k === 'string' && k.startsWith('ct_');
          },
        });
      }
    };
    const id = setInterval(tick, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [queryClient]);
}
