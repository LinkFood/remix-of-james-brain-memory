/**
 * ct-specialist-iwm — IWM-only specialist wakeup.
 *
 * Thin wrapper. All logic is in _shared/specialistRunner.ts. See
 * CO_TRADER_V2_SCOPE.md § "Specialist framework".
 *
 * POST body (optional):
 *   { reason: 'scheduled'|'event_driven'|'manual', forced_event_ids?: string[] }
 *
 * Auth: service role only (this is a cron-driven + agent-driven function).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { runSpecialistWakeup } from '../_shared/specialistRunner.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const body = (await req.json().catch(() => ({}))) as {
    reason?: string;
    forced_event_ids?: string[];
  };

  const reason = (body.reason === 'event_driven' || body.reason === 'manual')
    ? body.reason
    : 'scheduled';

  const result = await runSpecialistWakeup({
    supabase,
    ticker: 'IWM',
    reason,
    forcedEventIds: body.forced_event_ids,
  });

  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
