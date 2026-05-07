// get_jac_brief — Tier 1 v2 tool (was get_morning_brief, renamed 2026-05-07
// per scoping doc Path C — to disambiguate from the Co-Trader market brief
// which now owns the `get_morning_brief` name).
//
// Returns JAC's life-management self-review brief for a given ET date
// (default: today's brief if it has already fired, else yesterday's). Reads
// `brain_reports` filtered to `report_type='morning_brief'`, single row.
// Source: `jac-morning-brief` cron — schedule + overdue items + brain
// reflections. Distinct from Co-Trader's market brief (see
// `get_morning_brief.ts` → `ct_daily_briefs`).
//
// Per Phase A audit (`docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md`):
//   - Brief fires daily ~10:00 UTC (~6 AM ET) via `jac-morning-brief` cron.
//   - `created_at` is UTC. Date arg refers to the ET session date — translate
//     to a UTC window via _shared/clock.ts helpers.
//   - PII surface: brief body may carry personal scheduling content. README
//     warns terminal-Claude transcripts containing brief output should be
//     treated as private. No additional code-level redaction here.
//
// Read-only (SELECT). Best-effort telemetry to `ct_mcp_tool_calls` (separate
// table from organ telemetry per PR #11 review 2026-05-05).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { todayInET } from '../../../supabase/functions/_shared/clock.ts';
import { emitToolTelemetry } from '../lib/tool_telemetry.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'get_jac_brief';
const ET_TZ = 'America/New_York';

export interface GetJacBriefArgs {
  date?: string; // YYYY-MM-DD in ET. Default: today ET (or yesterday if before 6 AM ET).
}

export interface JacBriefRow {
  id: string;
  report_type: string;
  title: string | null;
  summary: string | null;
  body_markdown: string | null;
  key_themes: unknown;
  decisions: unknown;
  insights: unknown;
  conversation_stats: unknown;
  metadata: unknown;
  source: string | null;
  created_at: string;
}

export interface GetJacBriefResult {
  brief: JacBriefRow | null;
  meta: {
    consumerName: string;
    tool: string;
    requestedEtDate: string;
    etWindowStartUtc: string;
    etWindowEndUtc: string;
    rowCount: number;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

/**
 * Convert an ET-local YYYY-MM-DD to a UTC window [start, end) covering the
 * full ET day. DST-aware via Intl.
 */
function etDayWindowToUtc(etYmd: string): { startUtc: Date; endUtc: Date } {
  // Build "midnight ET on day N" by binary-search-style adjustment.
  // Initial guess: the date plus a 5-hour offset (UTC-5 = EST). Adjust if DST
  // pushed it. Same technique as marketClock.ts buildNyDate.
  const buildEtMidnight = (ymd: string): Date => {
    const [y, m, d] = ymd.split('-').map(Number);
    let guess = new Date(Date.UTC(y, m - 1, d, 5, 0, 0)); // 00:00 EST guess
    for (let i = 0; i < 3; i++) {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: ET_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(guess)) {
        if (p.type !== 'literal') parts[p.type] = p.value;
      }
      const gotY = Number(parts.year);
      const gotM = Number(parts.month);
      const gotD = Number(parts.day);
      const gotH = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
      const gotMin = Number(parts.minute);
      if (gotY === y && gotM === m && gotD === d && gotH === 0 && gotMin === 0) {
        return guess;
      }
      const target = y * 525600 + (m - 1) * 43800 + d * 1440;
      const got = gotY * 525600 + (gotM - 1) * 43800 + gotD * 1440 + gotH * 60 + gotMin;
      const driftMin = target - got;
      guess = new Date(guess.getTime() + driftMin * 60_000);
    }
    return guess;
  };

  const startUtc = buildEtMidnight(etYmd);
  // End = start + 24 hours (DST transitions inside one ET day are <=1 day in UTC,
  // and brief lives nowhere near 02:00 ET so the +24h envelope is safe).
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

/**
 * Resolve the default date: today ET if a brief has likely already fired
 * (current ET hour >= 6), else yesterday ET. The brief cron fires at ~10 UTC
 * daily which is 5-6 AM ET depending on DST. Caller can always override.
 */
function defaultEtDate(): string {
  const today = todayInET(ET_TZ);
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hourPart = nowParts.find((p) => p.type === 'hour');
  const hour = hourPart ? Number(hourPart.value) % 24 : 12;
  if (hour >= 6) return today;
  // Before 6 AM ET — yesterday's brief is the freshest available.
  const [y, m, d] = today.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(prev);
}

export async function getJacBrief(args: GetJacBriefArgs): Promise<GetJacBriefResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  let requestedEtDate: string;
  if (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    requestedEtDate = args.date;
  } else {
    if (args.date) warnings.push(`invalid_date_format:${args.date} — using default`);
    requestedEtDate = defaultEtDate();
  }

  const { startUtc, endUtc } = etDayWindowToUtc(requestedEtDate);

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from('brain_reports')
    .select(
      'id, report_type, title, summary, body_markdown, key_themes, decisions, insights, conversation_stats, metadata, source, created_at',
    )
    .eq('report_type', 'morning_brief')
    .gte('created_at', startUtc.toISOString())
    .lt('created_at', endUtc.toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  const latencyMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = `brain_reports morning_brief query failed: ${error.message}`;
    void emitToolTelemetry(supabase, {
      tool: TOOL_NAME,
      params: { date: requestedEtDate },
      durationMs: latencyMs,
      outputBytes: 0,
      error: msg,
    });
    throw new Error(msg);
  }

  const row = (data && data[0]) ? (data[0] as JacBriefRow) : null;
  if (!row) {
    warnings.push(`no_brief_for_et_date:${requestedEtDate}`);
  }

  const result: GetJacBriefResult = {
    brief: row,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      requestedEtDate,
      etWindowStartUtc: startUtc.toISOString(),
      etWindowEndUtc: endUtc.toISOString(),
      rowCount: row ? 1 : 0,
      latencyMs,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };

  const outputBytes = JSON.stringify(result).length;
  void emitToolTelemetry(supabase, {
    tool: TOOL_NAME,
    params: { date: requestedEtDate },
    durationMs: latencyMs,
    outputBytes,
  });

  return result;
}
