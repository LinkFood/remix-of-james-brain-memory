// get_morning_brief — Co-Trader market brief Tier 1 v2 tool.
//
// Returns the Co-Trader morning brief for a given ET session date (default:
// today's session). Reads `ct_daily_briefs` filtered by session_date — the
// captain's market-context entry point produced by `ct-daily-brief` cron at
// ~11:00 UTC weekdays.
//
// Distinct from `get_jac_brief` (life-management self-review brief at
// `brain_reports.morning_brief`). The captain workflow targets THIS tool —
// macro_narrative, watchlist_focus, high_conviction_ideas with
// entry/stop/target/rationale, per_ticker tape views.
//
// Field-name mapping vs scoping-doc interface (Path C, Phase A 2026-05-07):
//   brief_id              ← id (UUID)
//   brief_date            ← session_date (YYYY-MM-DD)
//   regime                ← macro_regime
//   generated_at          ← created_at
//   scheduled (bool)      ← derive: triggered_by === 'scheduled'
//   model                 ← generated_by_model
//   focus_tickers         ← watchlist_focus
//   skip_tickers          ← skip_today
//   high_conviction_ideas[].thesis ← rationale
//   per_ticker_reads[].stance      ← tilt (translate enum casing)
//   per_ticker_reads[].confidence_dots ← focus
//   per_ticker_reads[].event_reminders ← catalysts
//
// DOC FIELDS NOT IN DB (return null/empty rather than fabricate):
//   per_ticker_reads[].weight, narrative_view, thesis_tags
//   recent_prints[].days_ago, label, value (DB has at/name/delta/value;
//     direct passthrough where the names match, null where they don't)
//   breaking_events[].timestamp (DB has time as string label,
//     not parsed timestamp — pass through verbatim into title)
//
// Status enum:
//   row found                → "populated"
//   row not found for date   → "no_brief_today" (structured-empty;
//                                explicit absence, never silent fallback)
//
// Read-only (SELECT). Best-effort telemetry to ct_mcp_tool_calls.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { todayInET } from '../../../supabase/functions/_shared/clock.ts';
import { emitToolTelemetry } from '../lib/tool_telemetry.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'get_morning_brief';
const ET_TZ = 'America/New_York';

export interface GetMorningBriefArgs {
  date?: string; // YYYY-MM-DD ET session date. Default: today ET.
}

interface CtDailyBriefRow {
  id: string;
  session_date: string;
  brief_version: number;
  triggered_by: string | null;
  supersedes_id: string | null;
  urgency: string | null;
  macro_narrative: string | null;
  macro_regime: string | null;
  breaking_events: unknown;
  overnight_action: string | null;
  recent_prints: unknown;
  per_ticker: unknown;
  convergent_view: string | null;
  high_conviction_ideas: unknown;
  watchlist_focus: string[] | null;
  skip_today: string[] | null;
  generated_by_model: string | null;
  ttl_hours: number | null;
  expires_at: string | null;
  created_at: string;
  accuracy_score: number | null;
  accuracy_notes: string | null;
}

export interface MorningBriefResponse {
  status: 'populated' | 'no_brief_today';

  brief_id: string | null;
  brief_date: string | null;
  /** Brief version per session_date — canonical row is MAX(brief_version)
   *  (Ship 2 race-fence pattern). Integer ≥1 on populated rows; null when
   *  no_brief_today. Lets trading-Claude verify the canonical-row pick
   *  forensically (e.g. brief_version=3 + supersededCount=2 ⇒ this is the
   *  3rd write for the session, with 2 earlier reads still available via
   *  follow-up call). Ship 13 of Bundle 5, 2026-05-14 — Ship 5 selected
   *  this column but never projected it onto the brief surface; Ship 13
   *  closes the gap so brief_version is captain-visible without a separate
   *  DB query. */
  brief_version: number | null;
  /** UUID of the brief this row supersedes (Ship 2 race-fence semantics).
   *  Null on v1 rows (the morning fire for a given session_date) AND on
   *  no_brief_today. Populated on v2+ rebriefs (breaking_news /
   *  regime_shift / manual). Lets trading-Claude trace the supersession
   *  chain v1→v2→v3 directly from the brief object. Ship 13 of Bundle 5,
   *  2026-05-14 — Ship 5 added this column to the schema but neither
   *  selected it nor projected it; Ship 13 closes both gaps. */
  supersedes_id: string | null;
  regime: string | null;
  generated_at: string | null;
  expires_at: string | null;
  /** Trigger source for this brief: 'scheduled' | 'breaking_news' |
   *  'manual' | 'regime_shift'. Lets trading-Claude do forensic verification
   *  of whether the canonical row came from the morning fire or a rebrief.
   *  Sibling of `scheduled` (boolean) — kept for backward compat; new
   *  consumers should read `triggered_by` for full granularity. */
  triggered_by: string | null;
  /** Urgency tag: 'normal' | 'elevated' | 'high' | 'acute'. Surfaces on
   *  rebriefs to signal how loud the trigger event was. Mirrors the chip
   *  shown in the /morning-brief UI header. */
  urgency: string | null;
  scheduled: boolean | null;
  model: string | null;
  ttl_hours: number | null;
  /** Post-session reflection score 0.0-1.0, populated by ct-brief-reflection
   *  bridge cron (Ship 6 of Bundle 2, 2026-05-13). Null when no EOD report
   *  has fired yet for this brief's session. Property loop closure at brief
   *  layer — trading-Claude can see "yesterday scored 0.55" without a
   *  follow-up tool call. */
  accuracy_score: number | null;
  /** 1-3 sentence deterministic digest of the per-ticker scorecard
   *  commentary (Ship 6 bridge). Null when no EOD report yet. */
  accuracy_notes: string | null;

  focus_tickers: string[];
  skip_tickers: string[];

  macro_narrative: string | null;
  overnight_action: string | null;
  recent_prints: Array<{ days_ago: number | null; label: string | null; value: string | null }>;

  breaking_events: Array<{ title: string; source: string; timestamp: string; severity: number }>;

  high_conviction_ideas: Array<{
    ticker: string | null;
    direction: 'LONG' | 'SHORT' | null;
    size_pct: number | null;
    entry_range: string | null;
    stop: number | string | null;
    target: number | string | null;
    thesis: string | null;
  }>;

  per_ticker_reads: Array<{
    ticker: string;
    stance: 'LONG LEAN' | 'SHORT LEAN' | 'NEUTRAL' | 'AVOID' | string;
    confidence_dots: number | null;
    weight: number | null;
    alignment: 'aligned' | 'partial' | 'conflict' | string;
    tape_view: string | null;
    narrative_view: string | null;
    event_reminders: string[];
    thesis_tags: string[];
  }>;

  convergent_view: string | null;
}

export interface GetMorningBriefResult {
  brief: MorningBriefResponse;
  meta: {
    consumerName: string;
    tool: string;
    requestedEtDate: string;
    rowCount: number;
    /** How many superseded (older brief_version) rows exist for the same
     *  session_date. 0 = no rebriefs that day. >0 = trading-Claude can fetch
     *  earlier reads via a follow-up call if continuity context is needed.
     *  Mirrors Ship 2's canonical-row UI semantics — site shows the canonical
     *  row + "Earlier reads (N)" disclosure; bridge surface tells the model
     *  the same N. */
    supersededCount: number;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

// Translate DB tilt enum (e.g. 'long_lean') to interface stance ('LONG LEAN').
function tiltToStance(raw: unknown): MorningBriefResponse['per_ticker_reads'][number]['stance'] {
  if (typeof raw !== 'string' || raw.length === 0) return 'NEUTRAL';
  const upper = raw.replace(/_/g, ' ').toUpperCase();
  return upper as MorningBriefResponse['per_ticker_reads'][number]['stance'];
}

function directionToUpper(raw: unknown): 'LONG' | 'SHORT' | null {
  if (typeof raw !== 'string') return null;
  const u = raw.toUpperCase();
  if (u === 'LONG' || u === 'SHORT') return u;
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function emptyResponse(): MorningBriefResponse {
  return {
    status: 'no_brief_today',
    brief_id: null,
    brief_date: null,
    brief_version: null,
    supersedes_id: null,
    regime: null,
    generated_at: null,
    expires_at: null,
    triggered_by: null,
    urgency: null,
    scheduled: null,
    model: null,
    ttl_hours: null,
    accuracy_score: null,
    accuracy_notes: null,
    focus_tickers: [],
    skip_tickers: [],
    macro_narrative: null,
    overnight_action: null,
    recent_prints: [],
    breaking_events: [],
    high_conviction_ideas: [],
    per_ticker_reads: [],
    convergent_view: null,
  };
}

function mapRow(row: CtDailyBriefRow): MorningBriefResponse {
  const breaking = Array.isArray(row.breaking_events) ? row.breaking_events : [];
  const prints = Array.isArray(row.recent_prints) ? row.recent_prints : [];
  const ideas = Array.isArray(row.high_conviction_ideas) ? row.high_conviction_ideas : [];
  const perTicker = Array.isArray(row.per_ticker) ? row.per_ticker : [];

  return {
    status: 'populated',
    brief_id: row.id,
    brief_date: row.session_date,
    brief_version: row.brief_version,
    supersedes_id: row.supersedes_id,
    regime: row.macro_regime,
    generated_at: row.created_at,
    expires_at: row.expires_at,
    triggered_by: row.triggered_by,
    urgency: row.urgency,
    scheduled: row.triggered_by === 'scheduled',
    model: row.generated_by_model,
    ttl_hours: row.ttl_hours,
    accuracy_score: row.accuracy_score,
    accuracy_notes: row.accuracy_notes,
    focus_tickers: Array.isArray(row.watchlist_focus) ? row.watchlist_focus : [],
    skip_tickers: Array.isArray(row.skip_today) ? row.skip_today : [],
    macro_narrative: row.macro_narrative,
    overnight_action: row.overnight_action,
    recent_prints: prints.map((p: Record<string, unknown>) => ({
      // DB shape: {at, name, delta, value} — doc shape: {days_ago, label, value}.
      // No clean numeric `days_ago` (DB stores "**-7 days**" string). Pass null;
      // surface label ← name + delta description; value ← value.
      days_ago: null,
      label: typeof p.name === 'string' ? p.name : null,
      value: typeof p.value === 'string' ? p.value : (typeof p.delta === 'string' ? p.delta : null),
    })),
    breaking_events: breaking.map((b: Record<string, unknown>) => ({
      title: typeof b.headline === 'string' ? b.headline : '',
      source: typeof b.source === 'string' ? b.source : '',
      timestamp: typeof b.time === 'string' ? b.time : '',
      severity: typeof b.severity === 'number' ? b.severity : 0,
    })),
    high_conviction_ideas: ideas.map((i: Record<string, unknown>) => ({
      ticker: typeof i.instrument === 'string'
        ? i.instrument
        : (typeof i.ticker === 'string' ? i.ticker : null),
      direction: directionToUpper(i.direction),
      size_pct: num(i.size_pct),
      entry_range: typeof i.entry_zone === 'string'
        ? i.entry_zone
        : (typeof i.entry_range === 'string' ? i.entry_range : null),
      stop: typeof i.stop === 'number' || typeof i.stop === 'string' ? i.stop : null,
      target: typeof i.target === 'number' || typeof i.target === 'string' ? i.target : null,
      thesis: typeof i.rationale === 'string' ? i.rationale : null,
    })),
    per_ticker_reads: perTicker.map((t: Record<string, unknown>) => ({
      ticker: typeof t.ticker === 'string' ? t.ticker : '',
      stance: tiltToStance(t.tilt),
      confidence_dots: num(t.focus),
      // DOC FIELDS NOT IN DB — return null/empty per Path C contract.
      weight: null,
      alignment: typeof t.alignment === 'string' ? t.alignment : 'aligned',
      tape_view: typeof t.tape_view === 'string' ? t.tape_view : null,
      narrative_view: null,
      event_reminders: Array.isArray(t.catalysts) ? t.catalysts as string[] : [],
      thesis_tags: [],
    })),
    convergent_view: row.convergent_view,
  };
}

export async function getMorningBrief(args: GetMorningBriefArgs): Promise<GetMorningBriefResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  let requestedEtDate: string;
  if (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    requestedEtDate = args.date;
  } else {
    if (args.date) warnings.push(`invalid_date_format:${args.date} — using today ET`);
    requestedEtDate = todayInET(ET_TZ);
  }

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Canonical-row semantics — must mirror Ship 2's useMorningBrief.ts and
  // ct_insert_daily_brief_locked RPC: the row with MAX(brief_version) per
  // session_date is the canonical brief. Prior to 2026-05-13 Ship 5 this
  // tool ordered by created_at DESC, which coincidentally aligned with
  // brief_version DESC on all post-Ship-2 cleanup data, but the ordering
  // was structurally fragile (cascade #48 family — bridge surface used a
  // different rule than the UI surface). Now both surfaces use the same
  // "max brief_version wins" rule.
  const { data, error } = await supabase
    .from('ct_daily_briefs')
    .select(
      'id, session_date, brief_version, triggered_by, supersedes_id, urgency, macro_narrative, macro_regime, breaking_events, overnight_action, recent_prints, per_ticker, convergent_view, high_conviction_ideas, watchlist_focus, skip_today, generated_by_model, ttl_hours, expires_at, created_at, accuracy_score, accuracy_notes',
    )
    .eq('session_date', requestedEtDate)
    .order('brief_version', { ascending: false })
    .limit(1);

  const latencyMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = `ct_daily_briefs query failed: ${error.message}`;
    void emitToolTelemetry(supabase, {
      tool: TOOL_NAME,
      params: { date: requestedEtDate },
      durationMs: latencyMs,
      outputBytes: 0,
      error: msg,
    });
    throw new Error(msg);
  }

  const row = (data && data[0]) ? (data[0] as CtDailyBriefRow) : null;
  const brief = row ? mapRow(row) : emptyResponse();
  if (!row) warnings.push(`no_brief_for_session_date:${requestedEtDate}`);

  // superseded_count — HEAD count of all rows for session_date minus 1 if
  // the canonical row was found. Trading-Claude sees how many earlier reads
  // exist for the same day and can decide whether to fetch them. Cheap
  // separate query (head:true → no payload, count only).
  let supersededCount = 0;
  if (row) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count } = await (supabase
      .from('ct_daily_briefs' as never) as any)
      .select('id', { count: 'exact', head: true })
      .eq('session_date', requestedEtDate);
    supersededCount = Math.max(0, (count ?? 1) - 1);
  }

  const result: GetMorningBriefResult = {
    brief,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      requestedEtDate,
      rowCount: row ? 1 : 0,
      supersededCount,
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
