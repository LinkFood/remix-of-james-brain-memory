import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface Subscription {
  id: string;
  user_id: string;
  tier: 'free' | 'pro';
  status: 'active' | 'cancelled' | 'past_due';
  monthly_dump_count: number;
  billing_cycle_start: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

interface UseSubscriptionReturn {
  subscription: Subscription | null;
  loading: boolean;
  error: Error | null;
  canDump: boolean;
  dumpsRemaining: number;
  dumpLimit: number;
  refetch: () => Promise<void>;
  incrementDumpCount: () => Promise<void>;
}

const FREE_TIER_LIMIT = 50;

export function useSubscription(userId: string | null): UseSubscriptionReturn {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSubscription = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const { data, error: fetchError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (fetchError) {
        throw new Error(fetchError.message);
      }

      // Cast the data to our Subscription type
      if (data) {
        setSubscription({
          ...data,
          tier: data.tier as 'free' | 'pro',
          status: data.status as 'active' | 'cancelled' | 'past_due',
        });
      } else {
        setSubscription(null);
      }
      setError(null);
    } catch (err) {
      console.error('Error fetching subscription:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch subscription'));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const incrementDumpCount = useCallback(async () => {
    if (!subscription) return;

    // Optimistic update
    setSubscription(prev => prev ? {
      ...prev,
      monthly_dump_count: prev.monthly_dump_count + 1,
    } : null);
  }, [subscription]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  // Derived values
  const isPro = subscription?.tier === 'pro';
  const dumpCount = subscription?.monthly_dump_count ?? 0;
  const dumpLimit = isPro ? Infinity : FREE_TIER_LIMIT;
  const dumpsRemaining = isPro ? Infinity : Math.max(0, FREE_TIER_LIMIT - dumpCount);
  const canDump = isPro || dumpCount < FREE_TIER_LIMIT;

  return {
    subscription,
    loading,
    error,
    canDump,
    dumpsRemaining,
    dumpLimit,
    refetch: fetchSubscription,
    incrementDumpCount,
  };
}
