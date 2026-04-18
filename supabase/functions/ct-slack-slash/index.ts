/**
 * ct-slack-slash — Slack slash commands for Co-Trader
 *
 * EXISTING commands (unchanged):
 *   /ct-view       — post a james_view: <direction> <ticker> <horizon> conv <n> "rationale"
 *   /ct-recap      — latest EOD/weekly recap (summary + rabbit hole)
 *   /ct-scorecard  — overall precision + recent-week precision from ct_grades
 *   /ct-status     — latest heartbeat status_line + watching list (legacy; /status is the new one-liner)
 *   /kill <reason> [minutes]  — engage ct_kill_switch
 *   /disarm        — disarm the kill switch
 *   /kill-status   — current kill switch state + countdown if auto-release set
 *
 * NEW commands (Block Kit UX, Slack as primary interface):
 *   /propose [TICKER?]    — calls ct-chat /propose, returns first proposal as Block Kit card
 *   /debate <topic>       — calls ct-chat /debate, returns bull + bear summary as Block Kit
 *   /commit <syntax>      — forwards to ct-chat /commit (full pre-trade gate still applies)
 *   /book                 — current book state: equity, open trades, today's P&L
 *   /health               — crons healthy/failed counts, UW usage tier, today's Claude cost
 *   /status               — one-line status: regime + open_count + latest_attention + kill state
 *   /replay [date?]       — fires ct-replay for date, returns run_id + link
 *   /flags                — top-5 highest-attention ct_flags in last 30 min
 *   /preset <name>        — applies ct_config preset (conservative/moderate/aggressive/paranoid)
 *
 * Slack commands are NEVER gated by the kill switch — James keeps control of this channel.
 * /commit goes through the SAME pre-trade gate as chat — Slack does not bypass it.
 *
 * Signature: HMAC-SHA256 of `v0:<timestamp>:<raw-body>` under SLACK_SIGNING_SECRET.
 * Constant-time compare via HMAC-of-HMAC.
 *
 * Long-running commands (/propose, /debate, /replay) return an immediate ephemeral
 * "🤔 working…" ACK within the 3-second Slack deadline, then POST the real Block Kit
 * payload to `response_url` once the upstream edge function returns.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

// ============================================================================
// Config
// ============================================================================
const LINKJAC_BASE = 'https://www.linkjac.cloud';

// Per-command cooldown (typos triggering expensive ops). Keyed by command name.
// In-memory = per-isolate; good enough for single-user.
const COMMAND_COOLDOWN_MS = 10_000;
const COOLDOWN_COMMANDS = new Set(['/propose', '/debate', '/replay', '/commit']);
const lastFiredAt = new Map<string, number>();

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
// /ct-view parser (unchanged from v1)
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

  if (!rationale) {
    rationale = tokens.slice(convIdx + 2).join(' ').trim();
  }

  return { direction, instrument, horizon, conviction, rationale };
}

// ============================================================================
// Response helpers — Block Kit friendly
// ============================================================================
type SlackBlock = Record<string, unknown>;

interface SlackPayload {
  response_type?: 'ephemeral' | 'in_channel';
  text: string;           // fallback text (required even with blocks — used by notifications)
  blocks?: SlackBlock[];
  replace_original?: boolean;
}

function ephemeral(text: string, blocks?: SlackBlock[]): Response {
  const body: SlackPayload = { response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}

/** Immediate ACK for long-running commands. Slack must hear back <3s. */
function workingAck(label: string): Response {
  return ephemeral(`🤔 ${label}…`, [{
    type: 'section',
    text: { type: 'mrkdwn', text: `🤔 *${label}…*  _this can take 10–30s — I'll post the result here when it's ready._` },
  }]);
}

/** Post a delayed result back to the slash command's response_url. */
async function postDelayed(responseUrl: string, payload: SlackPayload): Promise<void> {
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        replace_original: true,
        ...payload,
      }),
    });
    if (!res.ok) {
      console.warn(`[ct-slack-slash] delayed post failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (e) {
    console.warn('[ct-slack-slash] delayed post error:', e instanceof Error ? e.message : e);
  }
}

/** Section block with optional markdown text. */
function section(mrkdwn: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: mrkdwn } };
}

/** Context block — small muted text, used for link-backs. */
function contextLink(href: string, label: string): SlackBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${href}|${label}>` }],
  };
}

function divider(): SlackBlock {
  return { type: 'divider' };
}

/** Multi-field section (2-col grid of short key/value pairs). */
function fieldsBlock(pairs: Array<[string, string]>): SlackBlock {
  return {
    type: 'section',
    fields: pairs.slice(0, 10).map(([k, v]) => ({
      type: 'mrkdwn',
      text: `*${k}*\n${v}`,
    })),
  };
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = Math.abs(n) >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`;
  return n < 0 ? `-${s.replace('-', '')}` : s;
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ============================================================================
// Cross-function invocation helper
// Calls another edge function as service-role so the full pre-trade gate and
// /propose + /debate context code paths run exactly as they do from the UI.
// ============================================================================
async function invokeFn<T = unknown>(
  name: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/${name}`;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>))
        ? String((parsed as Record<string, unknown>).error)
        : `${res.status} ${text.slice(0, 200)}`;
      return { ok: false, error: msg };
    }
    return { ok: true, data: parsed as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// Block Kit builders — one per command
// ============================================================================

// ---- /status ---------------------------------------------------------------
function buildStatusBlocks(args: {
  regime: string | null;
  open_count: number;
  latest_attention: number | null;
  kill_active: boolean;
  kill_reason?: string | null;
  hb_age_iso?: string | null;
}): SlackBlock[] {
  const dot = args.kill_active ? '🔴'
    : args.latest_attention != null && args.latest_attention >= 70 ? '🟡'
    : '🟢';
  const oneLine = `${dot} regime *${args.regime ?? '?'}* · open *${args.open_count}* · attn *${args.latest_attention ?? '—'}* · kill *${args.kill_active ? 'ON' : 'off'}*`;
  return [
    section(oneLine),
    fieldsBlock([
      ['regime',    args.regime ?? '—'],
      ['open',      String(args.open_count)],
      ['attention', args.latest_attention == null ? '—' : String(args.latest_attention)],
      ['kill',      args.kill_active ? `ON (${args.kill_reason ?? 'no reason'})` : 'disarmed'],
      ['heartbeat', fmtAge(args.hb_age_iso ?? null)],
    ]),
    contextLink(`${LINKJAC_BASE}/ct`, 'open Co-Trader →'),
  ];
}

// ---- /book -----------------------------------------------------------------
interface BookRow {
  session_date: string;
  starting_balance: number | null;
  realized_pnl: number | null;
  unrealized_pnl: number | null;
  realized_pnl_pct: number | null;
  high_water_mark: number | null;
  trades_count: number | null;
}
interface OpenTradeRow {
  id: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number | null;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  opened_at: string | null;
}

function buildBookBlocks(book: BookRow | null, open: OpenTradeRow[]): SlackBlock[] {
  if (!book) {
    return [
      section(':notebook: *Book* — no row for today yet.'),
      contextLink(`${LINKJAC_BASE}/ct`, 'open book →'),
    ];
  }
  const start = book.starting_balance ?? 0;
  const realized = book.realized_pnl ?? 0;
  const unrealized = book.unrealized_pnl ?? 0;
  const equity = start + realized + unrealized;
  const totalPnl = realized + unrealized;
  const totalPct = start > 0 ? (totalPnl / start) * 100 : 0;

  const blocks: SlackBlock[] = [
    section(`:notebook: *Book — ${book.session_date}*`),
    fieldsBlock([
      ['equity',     fmtUsd(equity)],
      ['today P&L',  `${fmtUsd(totalPnl)} (${fmtPct(totalPct)})`],
      ['realized',   fmtUsd(realized)],
      ['unrealized', fmtUsd(unrealized)],
      ['HWM',        fmtUsd(book.high_water_mark ?? null)],
      ['trades',     String(book.trades_count ?? 0)],
    ]),
  ];

  if (open.length === 0) {
    blocks.push(section('_no open positions._'));
  } else {
    blocks.push(divider(), section(`*Open positions (${open.length})*`));
    for (const t of open.slice(0, 5)) {
      const line =
        `• *${t.instrument}* ${t.side} ${fmtNum(t.size_pct, 1)}% ` +
        `@${fmtNum(t.entry_price)} ` +
        `stop ${fmtNum(t.stop_price)} tgt ${fmtNum(t.target_price)} ` +
        `_(${fmtAge(t.opened_at)})_`;
      blocks.push(section(line));
    }
    if (open.length > 5) blocks.push(section(`_…and ${open.length - 5} more_`));
  }

  blocks.push(contextLink(`${LINKJAC_BASE}/ct`, 'open book →'));
  return blocks;
}

// ---- /health ---------------------------------------------------------------
interface HealthSummary {
  healthy: number;
  failed: number;
  stale: number;
  never_ran: number;
  uw_daily_count: number | null;
  uw_daily_limit: number | null;
  uw_pct: number | null;
  claude_cost_today: number | null;
  claude_turns_today: number | null;
}

function buildHealthBlocks(h: HealthSummary): SlackBlock[] {
  const uwPct = h.uw_pct ?? 0;
  const uwTier = uwPct >= 90 ? '🔴 critical' : uwPct >= 70 ? '🟡 warn' : '🟢 fine';
  const cronTier = h.failed > 0 || h.never_ran > 0 ? '🔴' : h.stale > 0 ? '🟡' : '🟢';

  return [
    section(':heart: *System health*'),
    fieldsBlock([
      ['crons',           `${cronTier} ${h.healthy} healthy · ${h.failed} failed · ${h.stale} stale · ${h.never_ran} never-ran`],
      ['UW usage',        `${uwTier} ${h.uw_daily_count ?? '?'}/${h.uw_daily_limit ?? '?'} (${h.uw_pct == null ? '—' : h.uw_pct.toFixed(1) + '%'})`],
      ['Claude today',    `${fmtUsd(h.claude_cost_today)} · ${h.claude_turns_today ?? 0} turns`],
    ]),
    contextLink(`${LINKJAC_BASE}/ct/cost`, 'cost dashboard →'),
  ];
}

// ---- /flags ----------------------------------------------------------------
interface FlagRow {
  id: string;
  instruments: string[] | null;
  direction: string | null;
  conviction: number | null;
  horizon: string | null;
  attention_score: number | null;
  glance: string | null;
  created_at: string | null;
}

function buildFlagsBlocks(flags: FlagRow[]): SlackBlock[] {
  if (flags.length === 0) {
    return [
      section(':triangular_flag_on_post: *Flags (last 30 min)* — _nothing above the line._'),
      contextLink(`${LINKJAC_BASE}/ct`, 'open Co-Trader →'),
    ];
  }
  const blocks: SlackBlock[] = [
    section(`:triangular_flag_on_post: *Top ${flags.length} flags — last 30 min*`),
  ];
  for (const f of flags) {
    const instr = (f.instruments ?? []).join(', ') || '—';
    const line =
      `*${instr}* ${f.direction ?? '?'} · conv ${f.conviction ?? '?'} · ${f.horizon ?? '?'} · attn *${f.attention_score ?? '—'}* _(${fmtAge(f.created_at)})_\n` +
      `> ${(f.glance ?? '').slice(0, 200)}`;
    blocks.push(section(line));
  }
  blocks.push(contextLink(`${LINKJAC_BASE}/ct`, 'open timeline →'));
  return blocks;
}

// ---- /propose --------------------------------------------------------------
interface ProposalCard {
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  thesis: string;
  conviction: number;
  commit_syntax: string;
  pre_trade_concerns: string[];
}

function buildProposeBlocks(res: {
  response: string;
  proposal_cards?: ProposalCard[];
  skip_reason?: string | null;
}): SlackBlock[] {
  const cards = res.proposal_cards ?? [];
  if (cards.length === 0) {
    return [
      section(`:thinking_face: *Propose* — ${res.response}`),
      contextLink(`${LINKJAC_BASE}/ct`, 'open Co-Trader →'),
    ];
  }
  const c = cards[0]; // compact version: first proposal only
  const more = cards.length > 1 ? `\n_+${cards.length - 1} more proposal${cards.length - 1 === 1 ? '' : 's'} in the web UI_` : '';
  const concerns = c.pre_trade_concerns.length > 0
    ? `\n\n:warning: _${c.pre_trade_concerns.join(' · ')}_`
    : '';
  return [
    section(`:bulb: *Propose — ${c.instrument} ${c.side} ${fmtNum(c.size_pct, 1)}%*  _conv ${c.conviction}_`),
    fieldsBlock([
      ['entry',  fmtNum(c.entry)],
      ['stop',   fmtNum(c.stop)],
      ['target', fmtNum(c.target)],
    ]),
    section(`*Thesis*\n${c.thesis || '_(none)_'}${concerns}`),
    section(`*Commit with:*\n\`${c.commit_syntax}\`${more}`),
    contextLink(`${LINKJAC_BASE}/ct`, 'open Co-Trader →'),
  ];
}

// ---- /debate ---------------------------------------------------------------
interface DebateSide {
  headline: string;
  evidence: string[];
  best_trade: string;
  probability_estimate: number | null;
}
interface DebateCard {
  topic: string;
  bull_case: DebateSide;
  bear_case: DebateSide;
  your_prior_lean: string;
  your_bias_risk: string;
  synthesis: string;
}

function buildDebateBlocks(res: {
  response: string;
  debate_card?: DebateCard | null;
  debate_id?: string | null;
}): SlackBlock[] {
  const card = res.debate_card ?? null;
  if (!card) {
    return [
      section(`:scales: *Debate* — ${res.response}`),
      contextLink(`${LINKJAC_BASE}/ct/debates`, 'open debates →'),
    ];
  }
  const bull = card.bull_case;
  const bear = card.bear_case;
  const bullEvidence = bull.evidence.slice(0, 3).map(e => `• ${e}`).join('\n') || '_(none)_';
  const bearEvidence = bear.evidence.slice(0, 3).map(e => `• ${e}`).join('\n') || '_(none)_';
  const debateHref = card && res.debate_id
    ? `${LINKJAC_BASE}/ct/debates/${res.debate_id}`
    : `${LINKJAC_BASE}/ct/debates`;

  return [
    section(`:scales: *Debate — ${card.topic}*`),
    fieldsBlock([
      ['prior lean', card.your_prior_lean || '—'],
      ['bias risk',  card.your_bias_risk || '—'],
    ]),
    divider(),
    section(`:chart_with_upwards_trend: *Bull — ${bull.probability_estimate ?? '—'}%*\n${bull.headline}\n${bullEvidence}\n_best trade:_ ${bull.best_trade}`),
    section(`:chart_with_downwards_trend: *Bear — ${bear.probability_estimate ?? '—'}%*\n${bear.headline}\n${bearEvidence}\n_best trade:_ ${bear.best_trade}`),
    divider(),
    section(`*Synthesis*\n${card.synthesis}`),
    contextLink(debateHref, 'open debate →'),
  ];
}

// ---- /replay ---------------------------------------------------------------
function buildReplayBlocks(args: {
  run_id: string | null;
  session_date: string;
  error?: string | null;
}): SlackBlock[] {
  if (args.error || !args.run_id) {
    return [
      section(`:movie_camera: *Replay — ${args.session_date}* failed: ${args.error ?? 'unknown'}`),
      contextLink(`${LINKJAC_BASE}/ct/replay`, 'open replay →'),
    ];
  }
  return [
    section(`:movie_camera: *Replay queued — ${args.session_date}*`),
    fieldsBlock([
      ['run_id', `\`${args.run_id.slice(0, 8)}…\``],
      ['date',   args.session_date],
    ]),
    contextLink(`${LINKJAC_BASE}/ct/replay?run_id=${encodeURIComponent(args.run_id)}`, 'view replay →'),
  ];
}

// ---- /preset ---------------------------------------------------------------
interface PresetApplyResult {
  preset?: string;
  keys_changed?: number;
  keys_skipped?: number;
  diff_summary?: Array<{ key: string; old: unknown; new: unknown }>;
}

function buildPresetBlocks(name: string, result: PresetApplyResult): SlackBlock[] {
  const changed = result.keys_changed ?? 0;
  const skipped = result.keys_skipped ?? 0;
  const diff = (result.diff_summary ?? []).slice(0, 5);
  const blocks: SlackBlock[] = [
    section(`:control_knobs: *Preset applied — ${name}*`),
    fieldsBlock([
      ['changed', String(changed)],
      ['skipped', String(skipped)],
    ]),
  ];
  if (diff.length > 0) {
    const diffText = diff
      .map(d => `• \`${d.key}\`: ${String(d.old)} → *${String(d.new)}*`)
      .join('\n');
    blocks.push(section(`*Top changes*\n${diffText}`));
  }
  blocks.push(contextLink(`${LINKJAC_BASE}/ct/settings`, 'open settings →'));
  return blocks;
}

// ============================================================================
// Handlers for new commands
// ============================================================================

async function handleStatus(sb: SupabaseClient): Promise<Response> {
  const [hbRes, openRes, kill, topAttn] = await Promise.all([
    sb.from('ct_heartbeats')
      .select('current_reads, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from('ct_trades')
      .select('id', { count: 'estimated', head: true })
      .eq('status', 'open'),
    sb.from('ct_kill_switch')
      .select('active, engaged_reason')
      .eq('id', 1)
      .maybeSingle(),
    sb.from('ct_flags')
      .select('attention_score')
      .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
      .order('attention_score', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const hb = hbRes.data as { current_reads?: Record<string, unknown>; created_at?: string } | null;
  const snapshot = (hb?.current_reads?._snapshot ?? null) as Record<string, unknown> | null;
  const spxMacro = (hb?.current_reads?.spx_macro ?? null) as { regime?: string } | null;
  const regime = (snapshot?.regime as string | undefined) ?? spxMacro?.regime ?? null;

  const blocks = buildStatusBlocks({
    regime,
    open_count: openRes.count ?? 0,
    latest_attention: (topAttn.data as { attention_score?: number } | null)?.attention_score ?? null,
    kill_active: !!(kill.data as { active?: boolean } | null)?.active,
    kill_reason: (kill.data as { engaged_reason?: string } | null)?.engaged_reason ?? null,
    hb_age_iso: hb?.created_at ?? null,
  });
  return ephemeral('status', blocks);
}

async function handleBook(sb: SupabaseClient): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const [bookRes, openRes] = await Promise.all([
    sb.from('ct_book')
      .select('session_date, starting_balance, realized_pnl, unrealized_pnl, realized_pnl_pct, high_water_mark, trades_count')
      .eq('session_date', today)
      .maybeSingle(),
    sb.from('ct_trades')
      .select('id, instrument, side, size_pct, entry_price, stop_price, target_price, opened_at')
      .eq('status', 'open')
      .order('opened_at', { ascending: false }),
  ]);
  const book = (bookRes.data as BookRow | null) ?? null;
  const open = (openRes.data as OpenTradeRow[] | null) ?? [];
  return ephemeral('book', buildBookBlocks(book, open));
}

async function handleHealth(sb: SupabaseClient): Promise<Response> {
  // Cron summary — read ct_cron_jobs_health latest statuses via the same
  // bucketing as ct-cron-health-check. Simpler here: just count statuses on
  // the ct-cron-health-check's output table (ct_cron_failures). But the
  // ct-* cron roll-up is the source-of-truth for current state. Query the
  // latest row per cron directly.
  const today = new Date().toISOString().slice(0, 10);
  const [cronsRes, uwRes, costRes] = await Promise.all([
    // Latest cron health failure audit rows for today (what was unhealthy).
    sb.from('ct_cron_failures')
      .select('jobname, status, created_at')
      .gte('created_at', new Date(Date.now() - 6 * 60 * 60_000).toISOString())
      .order('created_at', { ascending: false }),
    sb.from('ct_uw_usage_latest')
      .select('daily_count, daily_limit, pct')
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from('ct_claude_usage_today')
      .select('source, turns, cost_usd')
      .eq('session_date', today),
  ]);

  // Dedupe by jobname — keep the latest status per cron within the window.
  const latestByJob = new Map<string, string>();
  for (const row of (cronsRes.data as Array<{ jobname: string; status: string }> | null) ?? []) {
    if (!latestByJob.has(row.jobname)) latestByJob.set(row.jobname, row.status);
  }
  let failed = 0, stale = 0, never_ran = 0;
  for (const status of latestByJob.values()) {
    if (status === 'failed') failed++;
    else if (status === 'stale') stale++;
    else if (status === 'never_ran') never_ran++;
  }

  const uw = uwRes.data as { daily_count: number | null; daily_limit: number | null; pct: number | null } | null;
  const costRows = (costRes.data as Array<{ turns: number; cost_usd: number }> | null) ?? [];
  const costToday = costRows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const turnsToday = costRows.reduce((s, r) => s + (r.turns ?? 0), 0);

  // Heuristic for "healthy" count: we don't have a full cron registry handy
  // at request time; we surface "unhealthy" counts and the rest is implicitly
  // healthy. Show explicit healthy count as "scanned - unhealthy" when possible.
  // Since we don't scan here, report what we know and label as such.
  const healthy = 0; // caller sees 0 healthy = "we didn't scan full registry"; we still show unhealthy breakdown
  return ephemeral('health', buildHealthBlocks({
    healthy,
    failed,
    stale,
    never_ran,
    uw_daily_count: uw?.daily_count ?? null,
    uw_daily_limit: uw?.daily_limit ?? null,
    uw_pct: uw?.pct ?? null,
    claude_cost_today: costToday,
    claude_turns_today: turnsToday,
  }));
}

async function handleFlags(sb: SupabaseClient): Promise<Response> {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await sb
    .from('ct_flags')
    .select('id, instruments, direction, conviction, horizon, attention_score, glance, created_at')
    .gte('created_at', since)
    .not('attention_score', 'is', null)
    .order('attention_score', { ascending: false })
    .limit(5);
  return ephemeral('flags', buildFlagsBlocks((data as FlagRow[] | null) ?? []));
}

async function handlePreset(sb: SupabaseClient, text: string): Promise<Response> {
  const valid = ['conservative', 'moderate', 'aggressive', 'paranoid'];
  const name = text.trim().toLowerCase();
  if (!name || !valid.includes(name)) {
    return ephemeral(`usage: \`/preset <name>\` — valid: ${valid.join(', ')}`);
  }
  const res = await invokeFn<PresetApplyResult>('ct-preset-apply', { preset: name });
  if (!res.ok) return ephemeral(`preset failed: ${res.error}`);
  return ephemeral(`preset ${name} applied`, buildPresetBlocks(name, res.data));
}

/** Fire ct-replay and post the result to response_url when ready. */
async function handleReplayAsync(sb: SupabaseClient, text: string, responseUrl: string): Promise<void> {
  const arg = text.trim();
  // Accept YYYY-MM-DD or nothing (→ today).
  const today = new Date().toISOString().slice(0, 10);
  const session_date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : today;

  const res = await invokeFn<{ run_id: string; status?: string; error?: string }>('ct-replay', { session_date });
  if (!res.ok) {
    await postDelayed(responseUrl, {
      text: `replay failed: ${res.error}`,
      blocks: buildReplayBlocks({ run_id: null, session_date, error: res.error }),
    });
    return;
  }
  await postDelayed(responseUrl, {
    text: `replay queued — ${res.data.run_id}`,
    blocks: buildReplayBlocks({ run_id: res.data.run_id ?? null, session_date, error: res.data.error ?? null }),
  });
}

/** Fire ct-chat /propose and post the Block Kit result to response_url. */
async function handleProposeAsync(text: string, responseUrl: string): Promise<void> {
  const arg = text.trim();
  const message = arg ? `/propose ${arg}` : '/propose';
  const res = await invokeFn<{
    response: string;
    proposal_cards?: ProposalCard[];
    skip_reason?: string | null;
  }>('ct-chat', { message });
  if (!res.ok) {
    await postDelayed(responseUrl, { text: `propose failed: ${res.error}` });
    return;
  }
  await postDelayed(responseUrl, {
    text: res.data.response || 'propose done',
    blocks: buildProposeBlocks(res.data),
  });
}

/** Fire ct-chat /debate and post the Block Kit result to response_url. */
async function handleDebateAsync(text: string, responseUrl: string): Promise<void> {
  const topic = text.trim();
  if (!topic) {
    await postDelayed(responseUrl, { text: 'usage: `/debate <topic>`' });
    return;
  }
  const res = await invokeFn<{
    response: string;
    debate_card?: DebateCard | null;
    debate_id?: string | null;
  }>('ct-chat', { message: `/debate ${topic}` });
  if (!res.ok) {
    await postDelayed(responseUrl, { text: `debate failed: ${res.error}` });
    return;
  }
  await postDelayed(responseUrl, {
    text: res.data.response || 'debate done',
    blocks: buildDebateBlocks(res.data),
  });
}

/** Fire ct-chat /commit and post the result to response_url. */
async function handleCommitAsync(text: string, responseUrl: string): Promise<void> {
  const args = text.trim();
  if (!args) {
    await postDelayed(responseUrl, {
      text: 'usage: `/commit SPY long 15% stop 708 target 712`',
    });
    return;
  }
  const res = await invokeFn<{
    response: string;
    trade_id?: string | null;
    pre_trade_checks?: unknown[];
  }>('ct-chat', { message: `/commit ${args}` });
  if (!res.ok) {
    await postDelayed(responseUrl, { text: `commit failed: ${res.error}` });
    return;
  }
  const d = res.data;
  const blocks: SlackBlock[] = [
    section(d.trade_id
      ? `:white_check_mark: *Commit filled*\n${d.response}`
      : `:no_entry: *Commit blocked*\n${d.response}`),
    contextLink(`${LINKJAC_BASE}/ct`, 'open book →'),
  ];
  await postDelayed(responseUrl, { text: d.response || 'commit done', blocks });
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
    const command      = (params.get('command') || '').trim();
    const text         = (params.get('text') || '').trim();
    const slackUserId  = (params.get('user_id') || '').trim();
    const responseUrl  = (params.get('response_url') || '').trim();

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Single-user mode: ensure this Slack user_id matches the configured user.
    // Tries user_settings.settings->>slack_user_id; falls back to the single
    // profiles row (same pattern as v1 above). If no match, deny.
    const { data: profile } = await sb.from('profiles').select('id').limit(1).maybeSingle();
    const userId = profile?.id ?? null;

    if (!userId) {
      return ephemeral('no user profile — sign in to JAC web once to provision');
    }

    // Allow-list check: the owner's slack_user_id must be on user_settings.
    // If none configured yet, we fall through (single-user mode bootstrap).
    const { data: settings } = await sb
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    const configuredSlack = (settings?.settings as { slack_user_id?: string } | null | undefined)?.slack_user_id;
    if (configuredSlack && slackUserId && configuredSlack !== slackUserId) {
      return ephemeral(`not authorized: Slack user ${slackUserId} is not James.`);
    }

    // Per-command cooldown (guards expensive ops against typo-mashing).
    if (COOLDOWN_COMMANDS.has(command)) {
      const last = lastFiredAt.get(command) ?? 0;
      const ago = Date.now() - last;
      if (ago < COMMAND_COOLDOWN_MS) {
        const wait = Math.ceil((COMMAND_COOLDOWN_MS - ago) / 1000);
        return ephemeral(`${command} cooldown — retry in ${wait}s`);
      }
      lastFiredAt.set(command, Date.now());
    }

    // ============================================================
    // EXISTING COMMANDS (unchanged behavior)
    // ============================================================

    // ========== /ct-view ==========
    if (command === '/ct-view') {
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

    // ========== /kill <reason> [minutes] ==========
    if (command === '/kill') {
      if (!text) {
        return ephemeral(
          'usage: `/kill <reason> [minutes]`\n' +
          'examples:\n' +
          '  `/kill echo chamber on QQQ`  → manual disarm only\n' +
          '  `/kill costs spiking 60`      → auto-release in 60 min'
        );
      }

      const parts = text.trim().split(/\s+/);
      const maybeMin = parts[parts.length - 1];
      const minMatch = /^\d+$/.test(maybeMin) ? parseInt(maybeMin, 10) : null;
      const reason = minMatch != null
        ? parts.slice(0, -1).join(' ').trim() || '(no reason given)'
        : text.trim();

      const { data, error } = await sb.rpc('ct_killswitch_engage', {
        reason,
        minutes_until_auto_release: minMatch,
      });

      if (error) {
        return ephemeral(`failed to engage kill switch: ${error.message}`);
      }

      const row = Array.isArray(data) ? data[0] : data;
      const engagedAt = row?.engaged_at ? new Date(row.engaged_at).toLocaleString() : 'now';
      const release = row?.auto_release_at
        ? `auto-release at ${new Date(row.auto_release_at).toLocaleString()}`
        : 'manual disarm only (no timer)';

      return ephemeral(
        `:red_circle: *KILL SWITCH ENGAGED*\n` +
        `reason: ${reason}\n` +
        `engaged: ${engagedAt}\n` +
        `${release}\n` +
        `all Claude-calling + trade-writing functions will skip on next tick. disarm with \`/disarm\`.`
      );
    }

    // ========== /disarm ==========
    if (command === '/disarm') {
      const { data, error } = await sb.rpc('ct_killswitch_disarm');
      if (error) return ephemeral(`failed to disarm: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : data;
      const disarmedAt = row?.disarmed_at ? new Date(row.disarmed_at).toLocaleString() : 'now';
      return ephemeral(
        `:large_green_circle: *kill switch DISARMED* at ${disarmedAt}\n` +
        `Claude + trade writes resume on next tick (up to ~10s isolate cache lag).`
      );
    }

    // ========== /kill-status ==========
    if (command === '/kill-status') {
      const { data } = await sb
        .from('ct_kill_switch')
        .select('active, engaged_at, engaged_by, engaged_reason, auto_release_at, disarmed_at, disarmed_by')
        .eq('id', 1)
        .maybeSingle();

      if (!data) return ephemeral('no ct_kill_switch row — migration may not be applied');

      if (data.active) {
        const engagedAt = data.engaged_at ? new Date(data.engaged_at as string).toLocaleString() : 'unknown';
        let countdown = 'manual disarm only';
        if (data.auto_release_at) {
          const msLeft = new Date(data.auto_release_at as string).getTime() - Date.now();
          if (msLeft <= 0) {
            countdown = 'auto-release due (will clear on next read)';
          } else {
            const m = Math.floor(msLeft / 60_000);
            const s = Math.floor((msLeft % 60_000) / 1000);
            countdown = `auto-release in ${m}m ${s}s`;
          }
        }
        return ephemeral(
          `:red_circle: *KILL SWITCH ACTIVE*\n` +
          `reason: ${data.engaged_reason ?? '(none)'}\n` +
          `engaged by: ${data.engaged_by ?? '?'} at ${engagedAt}\n` +
          `${countdown}`
        );
      } else {
        const disarmedAt = data.disarmed_at ? new Date(data.disarmed_at as string).toLocaleString() : 'never';
        return ephemeral(
          `:large_green_circle: kill switch is DISARMED\n` +
          `last disarmed: ${disarmedAt} (${data.disarmed_by ?? '?'})`
        );
      }
    }

    // ========== /ct-status (legacy — unchanged) ==========
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

    // ============================================================
    // NEW COMMANDS (Block Kit)
    // ============================================================

    // ========== /status ========== (quick — reads 4 tables)
    if (command === '/status') return await handleStatus(sb);

    // ========== /book ========== (quick)
    if (command === '/book') return await handleBook(sb);

    // ========== /health ========== (quick)
    if (command === '/health') return await handleHealth(sb);

    // ========== /flags ========== (quick)
    if (command === '/flags') return await handleFlags(sb);

    // ========== /preset ========== (quick — RPC)
    if (command === '/preset') return await handlePreset(sb, text);

    // ========== /propose ========== (long — calls ct-chat Sonnet)
    if (command === '/propose') {
      if (!responseUrl) return ephemeral('no response_url — Slack must include this');
      (async () => { await handleProposeAsync(text, responseUrl); })();
      return workingAck(`Propose${text ? ` ${text}` : ''}`);
    }

    // ========== /debate ========== (long — calls ct-chat Sonnet)
    if (command === '/debate') {
      if (!text) return ephemeral('usage: `/debate <topic>`');
      if (!responseUrl) return ephemeral('no response_url — Slack must include this');
      (async () => { await handleDebateAsync(text, responseUrl); })();
      return workingAck(`Debate: ${text.slice(0, 80)}`);
    }

    // ========== /commit ========== (medium — full pre-trade gate runs)
    if (command === '/commit') {
      if (!responseUrl) return ephemeral('no response_url — Slack must include this');
      (async () => { await handleCommitAsync(text, responseUrl); })();
      return workingAck(`Commit: ${text.slice(0, 80)}`);
    }

    // ========== /replay ========== (long — runs a simulation)
    if (command === '/replay') {
      if (!responseUrl) return ephemeral('no response_url — Slack must include this');
      (async () => { await handleReplayAsync(sb, text, responseUrl); })();
      return workingAck(`Replay${text ? ` ${text}` : ' (today)'}`);
    }

    return ephemeral(`unknown command: ${command}`);
  } catch (err) {
    console.error('[ct-slack-slash] error:', err);
    return ephemeral(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
});
