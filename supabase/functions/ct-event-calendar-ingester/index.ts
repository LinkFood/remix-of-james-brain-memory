/**
 * ct-event-calendar-ingester — earnings (pre + after), FDA, econ calendar.
 *
 * Calendars change rarely, so cadence is every 4 hours. Deduplicated via
 * UNIQUE (event_type, ticker, event_date, title) on ct_events.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  getEarningsAfterhours,
  getEarningsPremarket,
  getFdaCalendar,
  getEconomicCalendar,
} from '../_shared/uwClient.ts';

type EventRow = {
  event_type: 'earnings' | 'fda' | 'econ';
  ticker: string | null;
  event_date: string;       // YYYY-MM-DD
  event_time: string | null; // HH:MM:SSZ or null
  title: string | null;
  importance: number | null;
  raw: Record<string, unknown>;
};

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function extractData(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { data?: unknown }).data;
  return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
}

/** Coerce a UW row into a YYYY-MM-DD string or null. */
function pickDate(r: Record<string, unknown>): string | null {
  const candidates = [r.event_date, r.date, r.report_date, r.pdufa_date, r.earnings_date, r.announce_date];
  for (const c of candidates) {
    if (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c)) return c.slice(0, 10);
  }
  return null;
}

/** Extract HH:MM:SS+00 style time string, or null. */
function pickTime(r: Record<string, unknown>): string | null {
  const candidates = [r.event_time, r.time, r.report_time, r.release_time];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    // HH:MM or HH:MM:SS — accept either, normalize to HH:MM:SS+00
    const m = c.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return `${m[1]}:${m[2]}:${m[3] ?? '00'}+00`;
  }
  return null;
}

function pickTicker(r: Record<string, unknown>): string | null {
  const t = r.ticker ?? r.ticker_symbol ?? r.symbol;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

async function ingestEarnings(
  supabase: SupabaseClient,
  session: 'premarket' | 'afterhours',
): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = session === 'premarket' ? await getEarningsPremarket() : await getEarningsAfterhours();
    const data = extractData(raw);
    if (data.length === 0) return { seen: 0, inserted: 0 };

    const rows: EventRow[] = data
      .map((r) => {
        const date = pickDate(r);
        const ticker = pickTicker(r);
        if (!date) return null;
        const title = (r.company as string | undefined)
          ?? (r.name as string | undefined)
          ?? (ticker ? `${ticker} earnings (${session})` : `earnings (${session})`);
        return {
          event_type: 'earnings' as const,
          ticker,
          event_date: date,
          event_time: pickTime(r),
          title,
          importance: null,
          raw: { session, ...r },
        };
      })
      .filter((r): r is EventRow => r !== null);

    if (rows.length === 0) return { seen: data.length, inserted: 0 };

    const { error, count } = await supabase
      .from('ct_events')
      .upsert(rows, { onConflict: 'event_type,ticker,event_date,title', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-events] earnings ${session} upsert failed:`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-events] earnings ${session} pull failed:`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestFda(supabase: SupabaseClient): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getFdaCalendar();
    const data = extractData(raw);
    if (data.length === 0) return { seen: 0, inserted: 0 };

    const rows: EventRow[] = data
      .map((r) => {
        const date = pickDate(r);
        const ticker = pickTicker(r);
        if (!date) return null;
        const title = (r.drug as string | undefined)
          ?? (r.catalyst as string | undefined)
          ?? (r.title as string | undefined)
          ?? (r.description as string | undefined)
          ?? (ticker ? `${ticker} FDA event` : 'FDA event');
        return {
          event_type: 'fda' as const,
          ticker,
          event_date: date,
          event_time: pickTime(r),
          title,
          importance: null,
          raw: r,
        };
      })
      .filter((r): r is EventRow => r !== null);

    if (rows.length === 0) return { seen: data.length, inserted: 0 };

    const { error, count } = await supabase
      .from('ct_events')
      .upsert(rows, { onConflict: 'event_type,ticker,event_date,title', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn('[ct-events] fda upsert failed:', error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn('[ct-events] fda pull failed:', e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestEcon(supabase: SupabaseClient): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getEconomicCalendar();
    const data = extractData(raw);
    if (data.length === 0) return { seen: 0, inserted: 0 };

    const rows: EventRow[] = data
      .map((r) => {
        const date = pickDate(r);
        if (!date) return null;
        const title = (r.event as string | undefined)
          ?? (r.title as string | undefined)
          ?? (r.name as string | undefined)
          ?? 'econ event';
        return {
          event_type: 'econ' as const,
          ticker: null,  // econ is market-wide
          event_date: date,
          event_time: pickTime(r),
          title,
          importance: intOrNull(r.importance ?? r.impact ?? r.severity),
          raw: r,
        };
      })
      .filter((r): r is EventRow => r !== null);

    if (rows.length === 0) return { seen: data.length, inserted: 0 };

    const { error, count } = await supabase
      .from('ct_events')
      .upsert(rows, { onConflict: 'event_type,ticker,event_date,title', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn('[ct-events] econ upsert failed:', error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn('[ct-events] econ pull failed:', e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function countToday(supabase: SupabaseClient, event_type: 'earnings' | 'fda' | 'econ'): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { count } = await supabase
    .from('ct_events')
    .select('id', { count: 'estimated', head: true })
    .eq('event_type', event_type)
    .eq('event_date', today);
  return count ?? 0;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    const [premarket, afterhours, fda, econ] = await Promise.all([
      ingestEarnings(supabase, 'premarket'),
      ingestEarnings(supabase, 'afterhours'),
      ingestFda(supabase),
      ingestEcon(supabase),
    ]);

    const [earnings_today, fda_today, econ_today] = await Promise.all([
      countToday(supabase, 'earnings'),
      countToday(supabase, 'fda'),
      countToday(supabase, 'econ'),
    ]);

    const inserted = premarket.inserted + afterhours.inserted + fda.inserted + econ.inserted;

    return new Response(JSON.stringify({
      success: true,
      earnings_today,
      fda_today,
      econ_today,
      inserted,
      breakdown: {
        earnings_premarket: premarket,
        earnings_afterhours: afterhours,
        fda,
        econ,
      },
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[ct-event-calendar-ingester] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
