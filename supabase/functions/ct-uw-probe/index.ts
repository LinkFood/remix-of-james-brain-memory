/**
 * ct-uw-probe — diagnostic function. Invokes other ct-* functions via their
 * internal service-role path and dumps their response to ct_heartbeats so
 * we can read it from postgres. Also has its original UW endpoint probe.
 *
 * Not for production — delete after weekend scope is settled.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const body = await req.json().catch(() => ({}));
  const target = body?.target as string | undefined;
  const targetBody = body?.target_body ?? {};
  if (!target) return new Response(JSON.stringify({ error: 'pass { target: "ct-fn-name", target_body: {...} }' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${target}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(targetBody),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* raw */ }

    try {
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      await supabase.from('ct_heartbeats').insert({
        status_line: `[uw-probe → ${target}] http=${res.status} bytes=${text.length}`,
        watching: ['uw-probe'],
        current_reads: { _probe_target: target, _probe_status: res.status, _probe_response: parsed ?? text.slice(0, 4000) },
        prompt_version: 'uw-probe',
      });
    } catch (_e) { /* ignore */ }

    return new Response(JSON.stringify({ target, status: res.status, response: parsed ?? text.slice(0, 2000) }, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
