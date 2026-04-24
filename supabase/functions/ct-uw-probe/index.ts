/**
 * ct-uw-probe — diagnostic function. Two modes:
 *
 *   Mode A (target fn): Invokes another ct-* function via its internal
 *   service-role path and dumps its response to ct_heartbeats.
 *     body: { target: "ct-fn-name", target_body: {...} }
 *
 *   Mode B (raw UW REST): Hits UW REST directly with arbitrary path + params
 *   using Deno.env UW_API_KEY. Returns full body + selected response headers.
 *     body: { uw_path: "/api/option-trades/flow-alerts", uw_params: {...} }
 *
 * Not for production — delete after weekend scope is settled.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const UW_BASE_URL = 'https://api.unusualwhales.com';
const UW_CLIENT_API_ID = '100001';

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const body = await req.json().catch(() => ({}));

  // Mode B: raw UW REST probe
  if (body?.uw_path) {
    const uwKey = Deno.env.get('UW_API_KEY');
    if (!uwKey) return new Response(JSON.stringify({ error: 'UW_API_KEY not set' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const url = new URL(UW_BASE_URL + body.uw_path);
    const params = body.uw_params ?? {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
    try {
      const t0 = Date.now();
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${uwKey}`,
          'UW-CLIENT-API-ID': UW_CLIENT_API_ID,
          'Accept': 'application/json',
          'User-Agent': 'co-trader/1.0 (linkjac.cloud)',
        },
      });
      const ms = Date.now() - t0;
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* raw */ }

      const headers_of_interest: Record<string, string | null> = {};
      for (const h of [
        'x-uw-daily-req-count',
        'x-uw-token-req-limit',
        'x-uw-minute-req-counter',
        'x-uw-req-per-minute-remaining',
        'x-uw-req-per-minute-reset',
        'content-type',
      ]) {
        headers_of_interest[h] = res.headers.get(h);
      }

      return new Response(JSON.stringify({
        mode: 'uw-raw',
        url: url.toString(),
        status: res.status,
        ms,
        headers: headers_of_interest,
        body_bytes: text.length,
        body: parsed ?? text.slice(0, 8000),
      }, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Mode A: invoke another edge function
  const target = body?.target as string | undefined;
  const targetBody = body?.target_body ?? {};
  if (!target) return new Response(JSON.stringify({ error: 'pass { target: "ct-fn-name", target_body: {...} } OR { uw_path: "/api/...", uw_params: {...} }' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

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
