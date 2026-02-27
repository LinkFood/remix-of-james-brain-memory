/**
 * useSubscription — Stubbed out (single-user personal app)
 *
 * All subscription/pricing code removed. Always returns canDump: true.
 */

export interface Subscription {
  tier: 'pro';
  monthly_dump_count: number;
}

interface UseSubscriptionReturn {
  subscription: Subscription | null;
  loading: boolean;
  error: null;
  canDump: boolean;
  dumpsRemaining: number;
  dumpLimit: number;
  refetch: () => Promise<void>;
  incrementDumpCount: () => Promise<void>;
}

export function useSubscription(_userId: string | null): UseSubscriptionReturn {
  return {
    subscription: null,
    loading: false,
    error: null,
    canDump: true,
    dumpsRemaining: Infinity,
    dumpLimit: Infinity,
    refetch: async () => {},
    incrementDumpCount: async () => {},
  };
}
