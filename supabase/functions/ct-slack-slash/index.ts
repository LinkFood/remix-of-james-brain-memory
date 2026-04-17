/**
 * ct-slack-slash — Slack slash commands for Co-Trader
 *
 * Commands:
 *   /ct-view      — post a james_view: <direction> <ticker> <horizon> conv <n> "rationale"
 *   /ct-recap     — latest EOD/weekly recap (summary + rabbit hole)
 *   /ct-scorecard — overall precision + recent-week precision from ct_grades
 *   /ct-status    — latest heartbeat status_line + watching list
 *
 * Slack sends application/x-www-form-urlencoded bodies. Signature is HMAC-SHA256
 * of `v0:<timestamp>:<raw-body>` under SLACK_SIGNING_SECRET. We constant-time
 * compare via HMAC-of-HMAC (same pattern as slack-incoming).
 *
 * Responds with ephemeral JSON so only James sees the reply. Must return within 3s.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

// ============================================================================
// HMAC verification (constant-time via subtle HMAC-of-HMAC)
// ============================================================================
async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBasestring));
  const hexSig = 'v0=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  // constant-time compare
  const enc = new TextEncoder();
  const a = enc.encode(hexSig);
  const b = enc.encode(signature);
  if (a.byteLength !== b.byteLength) return false;
  const keyMaterial = await crypto.subtle.importKey('raw', a, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keyMaterial, b));
  const macCheck = new Uint8Array(await crypto.subtle.sign('HMAC', keyMaterial, a));
  return mac.every((byte, i) => byte === macCheck[i]);
}

// ============================================================================
// Horizon → horizon_end
// ============================================================================
function horizonEnd(horizon: string, from = new Date()): Date {
  const d = new Date(from);
  switch (horizon) {
    case '1h':       d.setHours(d.getHours() + 1); return d;
    case '4h':       d.setHours(d.getHours() + 4); return d;
    case 'EOD':      d.setHours(21, 0, 0, 0); if (d <= from) d.setDate(d.getDate() + 1); return d;
    case 'next-day': d.setDate(d.getDate() + 1); d.setHours(21, 0, 0, 0); return d;
    case 'weekly':   d.setDate(d.getDate() + 7); return d;
    default:         d.setHours(d.getHours() + 4); return d;
  }
}

// ============================================================================
// /ct-view parser
//   "bullish SPY EOD conv 3 \"flow support at 542\""
//   "bearish QQQ 4h conv 4 thesis tag invalidation"
// ============================================================================
interface ParsedView {
  direction: string;
  instrument: string;
  horizon: string;
  conviction: number;
  rationale: string;
}

function parseViewText(text: string): ParsedView | { error: string } {
  const validDir = ['bullish', 'bearish', 'neutral', 'volatility'];
  const validHor = ['1h', '4h', 'EOD', 'next-day', 'weekly'];

  // Extract rationale (quoted or trailing after conv N)
  let rationale = '';
  const quoteMatch = text.match(/"([^"]+)"|'([^']+)'/);
  let working = text;
  if (quoteMatch) {
    rationale = quoteMatch[1] || quoteMatch[2] || '';
    working = working.replace(quoteMatch[0], '').trim();
  }

  const tokens = working.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 5) return { error: 'usage: /ct-view <direction> <ticker> <horizon> conv <n> "rationale"' };

  const direction = tokens[0].toLowerCase();
  if (!validDir.includes(direction)) return { error: `direction must be one of: ${validDir.join(', ')}` };

  const instrument = tokens[1].toUpperCase();

  const horizon = tokens[2];
  if (!validHor.includes(horizon)) return { error: `horizon must be one of: ${validHor.join(', ')}` };

  const convIdx = tokens.findIndex(t => t.toLowerCase() === 'conv' || t.toLowerCase() === 'conviction');
  if (convIdx < 0 || convIdx + 1 >= tokens.length) return { error: 'missing `conv <n>` (n = 1..5)' };

  const conviction = parseInt(tokens[convIdx + 1]);
  if (!Number.isFinite(conviction) || conviction < 1 || conviction > 5) {
    return { error: 'conviction must be 1..5' };
  }

  // If no quoted rationale, everything after conv N is rationale
  if (!rationale) {
    rationale = tokens.slice(convIdx + 2).join(' ').trim();
  }

  return { direction, instrument, horizon, conviction, rationale };
}

// ============================================================================
// Response helper
// ============================================================================
function ephemeral(text: string, blocks?: unknown[]): Response {
  return new Response(
    JSON.stringify({ response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) }),
    { headers: { 'Content-Type': 'application/json' }, status: 200 }
  );
}

// ============================================================================
// Main handler
// ============================================================================
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  try {
    const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET');
    if (!signingSecret) {
      console.error('[ct-slack-slash] SLACK_SIGNING_SECRET not configured');
      return new Response('server config error', { status: 500 });
    }

    const rawBody = await req.text();
    const timestamp = req.headers.get('x-slack-request-timestamp') || '';
    const slackSig  = req.headers.get('x-slack-signature') || '';

    const valid = await verifySlackSignature(rawBody, timestamp, slackSig, signingSecret);
    if (!valid) {
      console.warn('[ct-slack-slash] invalid signature');
      return new Response('invalid signature', { status: 401 });
    }

    // Parse form-encoded body
    const params = new URLSearchParams(rawBody);
    const command = (params.get('command') || '').trim();
    const text    = (params.get('text') || '').trim();

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Single-user — grab the one profile
    const { data: profile } = await sb.from('profiles').select('id').limit(1).maybeSingle();
    const userId = profile?.id ?? null;

    // ========== /ct-view ==========
    if (command === '/ct-view') {
      if (!userId) return ephemeral('no user profile — sign in to JAC web once to provision');
      if (!text) {
        return ephemeral('usage: `/ct-view <direction> <ticker> <horizon> conv <n> "rationale"`\n' +
          'direction: bullish | bearish | neutral | volatility\n' +
          'horizon: 1h | 4h | EOD | next-day | weekly');
      }
      const parsed = parseViewText(text);
      if ('error' in parsed) return ephemeral(`parse error: ${parsed.error}`);

      const { error } = await sb.from('ct_james_views').insert({
        user_id: userId,
        instrument: parsed.instrument,
        direction: parsed.direction,
        conviction: parsed.conviction,
        horizon: parsed.horizon,
        horizon_end: horizonEnd(parsed.horizon).toISOString(),
        rationale: parsed.rationale || null,
        source: 'slack',
      });
      if (error) {
        console.error('[ct-slack-slash] insert ct_james_views failed:', error);
        return ephemeral(`failed to save view: ${error.message}`);
      }

      return ephemeral(
        `view logged — *${parsed.direction}* ${parsed.instrument} ${parsed.horizon} conv ${parsed.conviction}` +
        (parsed.rationale ? `\n> ${parsed.rationale}` : '')
      );
    }

    // ========== /ct-recap ==========
    if (command === '/ct-recap') {
      const { data: recap } = await sb
        .from('ct_reports')
        .select('report_type, period_start, summary, rabbit_hole, self_assessment')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!recap) return ephemeral('no recap written yet — EOD runs at 21:30 UTC weekdays');

      const when = new Date(recap.period_start as string).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      const parts = [`*${(recap.report_type as string).toUpperCase()} recap — ${when}*`, '', recap.summary as string];
      if (recap.rabbit_hole)     parts.push('', '*Rabbit hole*', recap.rabbit_hole as string);
      if (recap.self_assessment) parts.push('', '*Self-assessment*', recap.self_assessment as string);
      return ephemeral(parts.join('\n'));
    }

    // ========== /ct-scorecard ==========
    if (command === '/ct-scorecard') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

      const [{ data: allGrades }, { data: recentGrades }] = await Promise.all([
        sb.from('ct_grades').select('verdict').limit(5000),
        sb.from('ct_grades').select('verdict').gte('graded_at', weekAgo).limit(5000),
      ]);

      function precision(rows: Array<{ verdict: string }> | null): { p: number; n: number; right: number } {
        if (!rows || rows.length === 0) return { p: 0, n: 0, right: 0 };
        const right = rows.filter(r => r.verdict === 'right').length;
        return { p: right / rows.length, n: rows.length, right };
      }

      const all = precision(allGrades as Array<{ verdict: string }> | null);
      const wk  = precision(recentGrades as Array<{ verdict: string }> | null);

      const fmt = (x: { p: number; n: number; right: number }) =>
        x.n === 0 ? 'no data' : `${(x.p * 100).toFixed(1)}% (${x.right}/${x.n})`;

      return ephemeral(
        `*Scorecard*\n` +
        `• overall precision: ${fmt(all)}\n` +
        `• last 7 days: ${fmt(wk)}`
      );
    }

    // ========== /ct-status ==========
    if (command === '/ct-status') {
      const { data: hb } = await sb
        .from('ct_heartbeats')
        .select('status_line, watching, created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!hb) return ephemeral('no heartbeat yet — watcher hasn\'t fired');

      const ageSec = Math.round((Date.now() - new Date(hb.created_at as string).getTime()) / 1000);
      const ageStr = ageSec < 60 ? `${ageSec}s ago`
                   : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago`
                   : `${Math.round(ageSec / 3600)}h ago`;
      const watching = Array.isArray(hb.watching) ? (hb.watching as string[]).join(', ') : '';
      return ephemeral(
        `*Watcher status* (${ageStr})\n` +
        `${hb.status_line}\n` +
        (watching ? `watching: ${watching}` : '')
      );
    }

    return ephemeral(`unknown command: ${command}`);
  } catch (err) {
    console.error('[ct-slack-slash] error:', err);
    return ephemeral(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
