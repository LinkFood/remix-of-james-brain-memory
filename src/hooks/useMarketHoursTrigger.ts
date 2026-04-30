/**
 * useMarketHoursTrigger — single global watcher that invalidates every
 * query when the NY market crosses 09:30 or 16:00 ET.
 *
 * Why this exists: many hooks gate `refetchInterval` on
 * `isMarketHoursET()`. React Query reads that callback only when a refetch
 * is initiated — pre-bell it returns `false`, so polling never starts. After
 * the bell, the new `30_000` value never gets re-read until window-focus or
 * a hard refresh. James saw this 2026-04-29 + 2026-04-30 mornings: loaded
 * /tape pre-bell, Flow Butterfly stayed empty after 9:30 even though backend
 * was healthy.
 *
 * Original v1 (2026-04-29) only invalidated `queryKey[0]` starting with
 * `ct_`, but actual query keys use prefixes like `flow-pulse`, `net-premium`,
 * `tape-reader` — zero matches, hook dead-on-arrival. Caught 2026-04-30
 * 09:35 ET (Flow Butterfly stuck on yesterday despite hook firing).
 *
 * v2 fix: invalidate ALL queries on bell crossing. Single-user app, twice
 * per day, zero downside. No coupling to query-key naming convention —
 * adding new hooks won't silently bypass the bell trigger. Tenet 15: this
 * class of failure becomes impossible going forward.
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
        queryClient.invalidateQueries();
      }
    };
    const id = setInterval(tick, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [queryClient]);
}
