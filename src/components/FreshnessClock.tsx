/**
 * FreshnessClock — shared 1 Hz tick context for FreshnessChip instances.
 *
 * Why this exists:
 *   With 30+ freshness chips mounted across CommandStation / /book / /scorecard,
 *   running one setInterval per chip means ~30 timers firing once a second and
 *   30 independent setState calls reflowing those subtrees.
 *
 *   Instead: ONE timer at the app root publishes the current epoch-ms into
 *   context every 1s. Chips subscribe via useContext — React batches the
 *   re-renders of everything under the provider on each tick.
 *
 *   The chip itself is memoized and only re-computes its display text when the
 *   computed tier/display string actually changes. At-rest cost: 30 cheap
 *   memo'd subtree re-renders per second (only the chips, not their parents).
 *
 * Usage:
 *   Wrap <App> (or at minimum every page that shows Co-Trader panels) in
 *   <FreshnessClockProvider>. Inside, <FreshnessChip> pulls `now` from context.
 *
 * If the provider is missing, useFreshnessClock() falls back to `Date.now()`
 * at call time (static — chip won't live-update). This is intentional: chips
 * render correctly even outside the provider, just without the live ticker.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const FreshnessClockContext = createContext<number | null>(null);

interface Props {
  children: ReactNode;
  /** Tick interval in ms. Default 1000. */
  tickMs?: number;
}

export function FreshnessClockProvider({ children, tickMs = 1000 }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  return (
    <FreshnessClockContext.Provider value={now}>
      {children}
    </FreshnessClockContext.Provider>
  );
}

/** Returns the latest shared tick (epoch ms). Falls back to Date.now() if no provider. */
export function useFreshnessClock(): number {
  const ctx = useContext(FreshnessClockContext);
  return ctx ?? Date.now();
}
