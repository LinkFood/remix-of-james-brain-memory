/**
 * useKillSwitch — Standalone kill switch hook.
 *
 * Calls jac-kill-switch edge function with stop_all action.
 * Pattern extracted from useJacAgent.stopAllTasks.
 */

import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const JAC_KILL_SWITCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jac-kill-switch`;

export function useKillSwitch() {
  const [isKilling, setIsKilling] = useState(false);

  const killAll = useCallback(async () => {
    setIsKilling(true);
    try {
      await supabase.auth.getUser();
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) throw new Error('Not authenticated');

      const res = await fetch(JAC_KILL_SWITCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session.access_token}`,
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ action: 'stop_all' }),
      });

      const data = await res.json();
      toast.info(
        `Stopped ${data.cancelled ?? 0} task${(data.cancelled ?? 0) !== 1 ? 's' : ''}`,
        { style: { backgroundColor: '#f97316', color: 'white' } }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Failed to stop tasks: ${msg}`);
      console.error('[useKillSwitch] error:', err);
    } finally {
      setIsKilling(false);
    }
  }, []);

  return { killAll, isKilling };
}
