/**
 * useSlackToggleStatus — reads ct_config.signature_alarm_slack_enabled +
 * ct_config.signature_alarm_slack_min_tier so the /alarms page can show a
 * status pill ("Slack: ON gold+" / "Slack: OFF") without giving James a
 * mutate-from-here surface (calibration UX).
 *
 * Refetches every 60s — this is a manual flip operation, not real-time.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface SlackToggleStatus {
  enabled: boolean;
  minTier: string;
  isLoading: boolean;
  isError: boolean;
}

const REFETCH_MS = 60_000;

export function useSlackToggleStatus(): SlackToggleStatus {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [minTier, setMinTier] = useState<string>('gold');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isError, setIsError] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_config' as never) as any)
        .select('key, value')
        .in('key', ['signature_alarm_slack_enabled', 'signature_alarm_slack_min_tier']);
      if (cancelled) return;
      if (error) {
        console.warn('[useSlackToggleStatus]', error.message);
        setIsError(true);
        setIsLoading(false);
        return;
      }
      const map = new Map<string, unknown>();
      for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
        map.set(row.key, row.value);
      }
      // value is JSONB — booleans/strings come through directly.
      const rawEnabled = map.get('signature_alarm_slack_enabled');
      const rawMinTier = map.get('signature_alarm_slack_min_tier');
      setEnabled(rawEnabled === true);
      setMinTier(typeof rawMinTier === 'string' ? rawMinTier : 'gold');
      setIsError(false);
      setIsLoading(false);
    };

    fetchStatus();
    const id = setInterval(fetchStatus, REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { enabled, minTier, isLoading, isError };
}
