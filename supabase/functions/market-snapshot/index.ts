/**
 * market-snapshot — Daily Market Close Summary
 *
 * Cron: Weekdays at 5 PM Eastern (21:00 UTC during EDT).
 * Fetches market quotes and saves a formatted summary to the brain
 * via smart-save (triggers classify -> embed -> relationship pipeline).
 *
 * Auth: Service role only (cron call).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // Get all users from profiles (single-user system, same pattern as morning brief)
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id');

    if (usersError || !users || users.length === 0) {
      console.log('[market-snapshot] No users found');
      return new Response(JSON.stringify({ message: 'No users found' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch market quotes (pass userId for auth — market-quotes uses extractUserIdWithServiceRole)
    const marketRes = await fetch(`${supabaseUrl}/functions/v1/market-quotes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: users[0].id }),
    });
    const marketData = await marketRes.json();

    if (!marketRes.ok) {
      console.error(`[market-snapshot] market-quotes returned ${marketRes.status}`);
    }
    if (!marketData?.quotes?.length) {
      console.error('[market-snapshot] No market data — market-quotes failed or returned empty');
      return new Response(JSON.stringify({ error: 'No market data available' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'America/New_York',
    });

    // Build markdown content
    const title = `Market Close — ${dateStr}`;
    const lines = ['| Asset | Price | Change | % |', '|-------|-------|--------|---|'];
    for (const q of marketData.quotes) {
      const sign = q.change >= 0 ? '+' : '';
      lines.push(`| ${q.name} | $${q.price.toFixed(2)} | ${sign}${q.change.toFixed(2)} | ${sign}${q.changePercent.toFixed(2)}% |`);
    }
    const content = `# ${title}\n\n${lines.join('\n')}`;

    let saved = 0;

    for (const user of users) {
      const userId = user.id as string;

      // Save via smart-save (triggers classify -> embed -> relationship pipeline)
      let entryId: string | undefined;
      try {
        const saveRes = await fetch(`${supabaseUrl}/functions/v1/smart-save`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceRoleKey}`,
            'apikey': serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId,
            content,
            source: 'market-snapshot',
          }),
        });
        if (saveRes.ok) {
          const saveData = await saveRes.json();
          entryId = saveData.entry?.id;
        }
        saved++;
        console.log(`[market-snapshot] Saved for user ${userId}`);
      } catch (saveErr) {
        console.error(`[market-snapshot] Save failed for user ${userId}:`, saveErr);
      }

      // Archive to brain_reports
      try {
        await supabase.from('brain_reports').insert({
          user_id: userId,
          report_type: 'market_snapshot',
          source: 'market-snapshot',
          title,
          summary: `Market close: ${marketData.quotes.length} assets tracked`,
          body_markdown: content,
          metadata: { quotes: marketData.quotes },
          entry_id: entryId || null,
        });
      } catch (reportErr) {
        console.warn(`[market-snapshot] brain_reports insert failed for user ${userId}:`, reportErr);
      }
    }

    console.log(`[market-snapshot] Done: ${saved} snapshots saved across ${users.length} users`);

    return new Response(JSON.stringify({ success: true, title, saved }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[market-snapshot] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Market snapshot failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
