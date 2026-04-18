/**
 * useCtKillSwitch — Co-Trader emergency kill switch hook.
 *
 * Polls ct_kill_switch every 10s so multiple tabs stay in sync, and exposes
 * engage/disarm actions that call the ct_killswitch_engage / ct_killswitch_disarm
 * RPCs.
 *
 * NOT to be confused with useKillSwitch (JAC agent-task cancel). This one
 * halts Claude-calling + trade-writing functions via the ct_kill_switch
 * singleton row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface CtKillSwitchState {
  active: boolean;
  engagedAt: string | null;
  engagedBy: string | null;
  engagedReason: string | null;
  autoReleaseAt: string | null;
  disarmedAt: string | null;
  disarmedBy: string | null;
}

export interface UseCtKillSwitchResult {
  state: CtKillSwitchState | null;
  loading: boolean;
  /** `minutes` null → manual disarm only. */
  engage: (reason: string, minutes: number | null) => Promise<void>;
  disarm: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Seconds until auto-release, or null if no auto-release scheduled. */
  secondsUntilAutoRelease: number | null;
}

const POLL_MS = 10_000;

export function useCtKillSwitch(): UseCtKillSwitchResult {
  const [state, setState] = useState<CtKillSwitchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from('ct_kill_switch')
      // ct_kill_switch not in generated types yet — cast.
      .select('active, engaged_at, engaged_by, engaged_reason, auto_release_at, disarmed_at, disarmed_by' as '*')
      .eq('id', 1)
      .maybeSingle();

    if (!mounted.current) return;

    if (error) {
      console.warn('[useCtKillSwitch] read error:', error.message);
      setLoading(false);
      return;
    }

    if (!data) {
      setState(null);
      setLoading(false);
      return;
    }

    const row = data as unknown as {
      active: boolean;
      engaged_at: string | null;
      engaged_by: string | null;
      engaged_reason: string | null;
      auto_release_at: string | null;
      disarmed_at: string | null;
      disarmed_by: string | null;
    };

    setState({
      active: row.active,
      engagedAt: row.engaged_at,
      engagedBy: row.engaged_by,
      engagedReason: row.engaged_reason,
      autoReleaseAt: row.auto_release_at,
      disarmedAt: row.disarmed_at,
      disarmedBy: row.disarmed_by,
    });
    setLoading(false);
  }, []);

  // Initial + 10s polling
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  // 1-second clock for countdown rendering
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const engage = useCallback(async (reason: string, minutes: number | null) => {
    const { error } = await supabase.rpc('ct_killswitch_engage' as never, {
      reason: reason.trim() || '(no reason given)',
      minutes_until_auto_release: minutes,
    } as never);
    if (error) {
      toast.error(`Failed to engage kill switch: ${error.message}`);
      return;
    }
    toast.error(
      minutes
        ? `KILL ENGAGED — auto-release in ${minutes} min`
        : 'KILL ENGAGED — manual disarm only',
      { duration: 6000 }
    );
    await refresh();
  }, [refresh]);

  const disarm = useCallback(async () => {
    const { error } = await supabase.rpc('ct_killswitch_disarm' as never);
    if (error) {
      toast.error(`Failed to disarm: ${error.message}`);
      return;
    }
    toast.success('Kill switch DISARMED', { duration: 4000 });
    await refresh();
  }, [refresh]);

  const secondsUntilAutoRelease = (() => {
    if (!state?.active || !state.autoReleaseAt) return null;
    const ms = new Date(state.autoReleaseAt).getTime() - nowTick;
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  })();

  return { state, loading, engage, disarm, refresh, secondsUntilAutoRelease };
}
