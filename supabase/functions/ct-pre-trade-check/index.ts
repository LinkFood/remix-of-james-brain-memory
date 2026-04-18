/**
 * ct-pre-trade-check — UI-facing read endpoint that runs the pre-trade gate
 * against a hypothetical draft trade and returns the full checklist.
 *
 * Called by <PreTradeChecklist /> on the frontend. Does NOT commit anything.
 * Pure evaluation of the 7-check compliance gate so James can see what would
 * happen before pressing Commit.
 *
 * Input:  { trade: { instrument, side, size_pct, contract_type?, size_usd?, thesis_theme?, source? } }
 * Output: { passed, checks: Check[], blockers: Check[] }
 *
 * Auth: JWT (user) or service role. Single-user system so no RLS concerns —
 * the checks query system-wide state (ct_biases, ct_drawdown_alerts, ct_trades).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { preTradeCheck, type TradeLike } from '../_shared/preTradeGate.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: { trade?: TradeLike; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — we'll default the trade shape below.
  }

  // Safe defaults so a totally empty draft still renders 7 rows (kill/draw
  // downshift/concentration etc. still evaluate; bias/cooldown will pass
  // with a "skipped — not specified" detail).
  const trade: TradeLike = {
    instrument:    body.trade?.instrument ?? null,
    side:          body.trade?.side ?? null,
    size_pct:      body.trade?.size_pct ?? 0,
    source:        body.trade?.source ?? 'chat',
    session_date:  new Date().toISOString().slice(0, 10),
    thesis_theme:  body.trade?.thesis_theme ?? null,
    contract_type: body.trade?.contract_type ?? 'underlying',
    size_usd:      body.trade?.size_usd ?? null,
  };

  const result = await preTradeCheck(supabase, trade, { force: !!body.force });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
