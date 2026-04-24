/**
 * ChatPanel — docked left-side chat with Claude.
 *
 * Full height, sticky layout: header pinned top, input pinned bottom,
 * messages area fills the middle and scrolls internally. The whole panel
 * doesn't scroll — only the messages. No floating modal, no open/close
 * toggle; it's always there, in the sidebar slot on co-trader routes.
 *
 * Features:
 *   - Suggested prompt chips when chat is empty (fill textarea, don't auto-send)
 *   - Markdown rendering on assistant messages via react-markdown
 *   - Collapsible <details> for fenced ```json blocks (tool-use output stays folded)
 *   - Elapsed-time loading indicator with 15s / 30s escalation hints
 *   - Context-window divider above the 9th-from-last message
 *   - Per-message metadata (model · tokens · cost · duration · mcp calls)
 *   - Copy-to-clipboard button per assistant message
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Check, Copy, Loader2, MessageSquare, Send, Trash2 } from 'lucide-react';
import { FreshnessChip } from '@/components/FreshnessChip';

interface ProposalCard {
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  thesis: string;
  evidence_axes: string[];
  expected_move: {
    low_pct: number | null;
    high_pct: number | null;
    confidence_pct: number | null;
    horizon_hrs: number | null;
  };
  conviction: number;
  bias_check: string;
  pre_trade_concerns: string[];
  commit_syntax: string;
}

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
  recent_grade_on_this: string | null;
  your_bias_risk: string;
  synthesis: string;
  instrument: string | null;
}

interface MessageMeta {
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  mcp_calls?: number;
  /** How many DCD narrative hits were injected into the context for this turn. */
  cross_facet_hits?: number;
  /** True iff Claude's response actually cited the DCD brain. Drives the chip. */
  cross_facet_used?: boolean;
  /** /propose returned these — rendered as expanded review cards. */
  proposal_cards?: ProposalCard[];
  /** /debate returned this — rendered as a structured two-column adversarial card. */
  debate_card?: DebateCard;
  /** ct_debates row id — lets the Pick buttons PATCH user_pick. */
  debate_id?: string;
  /** Optimistic local state for which side James picked. Persisted via PATCH. */
  debate_pick?: 'bull' | 'bear' | 'neither';
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  meta?: MessageMeta;
}

const STORAGE_KEY = 'ct_chat_history_v1';
/** Server-side history window. Keep in sync with ct-chat.history slicing. */
const HISTORY_WINDOW = 8;
/** If true, clicking a chip sends immediately; otherwise it fills the textarea. */
const CHIPS_AUTO_SEND = false;

const SUGGESTED_PROMPTS = [
  "How's the book?",
  "What's hot right now?",
  "Propose a trade",
  "/debate hold my current position",
  "/debate SPY direction",
  "Scan SPY for anomalies",
  "What did you flag in the last hour?",
  "Show me today's worst trade",
  "What did we say about NVDA at 10am?",
  "Any clusters in the last 30min?",
  "Why did you fire the 14:30 alert?",
];

function loadHistory(): Message[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Message[];
  } catch { return []; }
}

function saveHistory(m: Message[]) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(m.slice(-40))); } catch { /* ignore */ }
}

function formatCost(usd?: number): string | null {
  if (usd == null || usd === 0) return null;
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`; // milli-dollars
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms?: number): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Loading indicator with a live elapsed-time counter. At 15s/30s switches
 * the helper text so James knows heavy UW MCP is probably running.
 */
function ThinkingIndicator({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);

  let label = `Claude is thinking… ${elapsed}s`;
  if (elapsed >= 30) label = `Slow turn — may be heavy UW query or long answer. ${elapsed}s`;
  else if (elapsed >= 15) label = `Still thinking… (UW MCP probably running) ${elapsed}s`;

  return (
    <div className="flex justify-start">
      <div className="bg-muted/60 rounded-lg px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> {label}
      </div>
    </div>
  );
}

/**
 * Copy-to-clipboard button. Shows a check for 1.5s after copy.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }
  return (
    <button
      onClick={onClick}
      className="text-muted-foreground/60 hover:text-foreground transition-colors p-0.5"
      title="Copy raw text"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/**
 * Tiny chip surfaced above the metadata line when Claude drew from the
 * shared OS memory (DCD's 7M-entry narrative brain) on this turn. Only
 * shows when cross_facet_used === true — mere *presence* of hits without
 * a citation in the reply is silent. This is our first cross-facet
 * visible signal; keep it quiet but distinct.
 */
function CrossFacetChip({ meta }: { meta?: MessageMeta }) {
  if (!meta?.cross_facet_used) return null;
  const count = meta.cross_facet_hits ?? 0;
  return (
    <div className="inline-flex items-center gap-1 px-1.5 py-0.5 mt-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 text-[9px] text-cyan-600 dark:text-cyan-400 tracking-wide">
      <span aria-hidden>🧠</span>
      <span>drew from DCD brain{count > 0 ? ` (${count} ${count === 1 ? 'entry' : 'entries'})` : ''}</span>
    </div>
  );
}

/**
 * Metadata line under each assistant message: model · tokens · cost · duration · mcp.
 * Omits fields that weren't provided (older history entries won't have meta).
 */
function MessageMetaLine({ meta }: { meta?: MessageMeta }) {
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (meta.tokens_in != null || meta.tokens_out != null) {
    parts.push(`${meta.tokens_in ?? 0}→${meta.tokens_out ?? 0} tok`);
  }
  const cost = formatCost(meta.cost_usd);
  if (cost) parts.push(cost);
  const dur = formatDuration(meta.duration_ms);
  if (dur) parts.push(dur);
  if (meta.mcp_calls != null && meta.mcp_calls > 0) parts.push(`${meta.mcp_calls} mcp`);
  if (parts.length === 0) return null;
  return (
    <div className="text-[9px] text-muted-foreground/60 mt-1 tracking-wide">
      {parts.join(' · ')}
    </div>
  );
}

/**
 * Render assistant markdown. For ```json fenced blocks we wrap them in a
 * collapsible <details> so long tool-use payloads don't flood the chat.
 * react-markdown sanitizes by default (no raw HTML pass-through), so we
 * don't need an extra sanitizer.
 */
function AssistantBody({ content }: { content: string }) {
  // Pre-process: if the whole message is JSON (or wrapped in a ```json fence),
  // render it as a collapsed <details> block directly. Avoids relying on
  // react-markdown's `components.pre` override, which was triggering a runtime
  // stack overflow when Claude returned deeply nested tool-use output.
  const trimmed = content.trim();
  const jsonFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonBody = jsonFence ? jsonFence[1] : trimmed;
  let isJson = false;
  if (jsonBody && (jsonBody.startsWith('{') || jsonBody.startsWith('['))) {
    try { JSON.parse(jsonBody); isJson = true; } catch { /* not json */ }
  }

  if (isJson) {
    return (
      <details className="my-1 rounded border border-border/60 bg-muted/40">
        <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
          structured output (click to expand)
        </summary>
        <pre className="p-2 overflow-x-auto text-[11px] whitespace-pre-wrap break-all">{jsonBody}</pre>
      </details>
    );
  }

  return (
    <div className="markdown-body text-xs leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul]:pl-4 [&_ol]:pl-4 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 [&_strong]:font-semibold [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:text-[11px] [&_pre]:p-2 [&_pre]:rounded [&_pre]:bg-muted/70 [&_pre]:overflow-x-auto [&_pre]:my-1.5 [&_pre>code]:bg-transparent [&_pre>code]:p-0">
      <ReactMarkdown
        components={{
          a: (props) => (
            <a target="_blank" rel="noreferrer noopener" className="underline text-primary" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Renders a /debate result as a structured adversarial card. Two columns:
 * bull (emerald) and bear (rose), each with its own probability bar.
 * IMPORTANT: the two probabilities are INDEPENDENT and do NOT need to sum to
 * 100. Both can be low (neither case is strong) or both high (genuinely hard
 * call). This is deliberate — forcing them to sum to 100 collapses "no edge"
 * into "it's a coin flip", which is a different (and less useful) statement.
 *
 * Claude is prompted NOT to pick a winner in the synthesis. James decides.
 * The "Propose from X side" buttons pre-fill a /propose command so James can
 * immediately convert the winning side into a concrete proposal — but the
 * debate output itself stays neutral.
 */
function DebateCardView({
  card,
  debateId,
  pick,
  onProposeFromSide,
  onPick,
}: {
  card: DebateCard;
  /** null when persistence failed on save — Pick buttons are disabled in that case. */
  debateId: string | null;
  /** Optimistic: which side James has already picked (if any). */
  pick: 'bull' | 'bear' | 'neither' | null;
  onProposeFromSide: (side: 'bull' | 'bear') => void;
  onPick: (side: 'bull' | 'bear' | 'neither') => void;
}) {
  const priorColor = card.your_prior_lean.toLowerCase().includes('bull')
    ? 'text-emerald-600 dark:text-emerald-400'
    : card.your_prior_lean.toLowerCase().includes('bear')
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-muted-foreground';

  return (
    <div className="my-2 rounded-lg border border-border bg-background/70 overflow-hidden">
      {/* Header — topic */}
      <div className="px-3 py-2 border-b border-border/60 bg-muted/40">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">debate</div>
        <div className="text-xs font-semibold">{card.topic}</div>
      </div>

      {/* Two-column cases */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-0 border-b border-border/60">
        <DebateSideView
          label="bull case"
          side={card.bull_case}
          color="emerald"
          onPropose={() => onProposeFromSide('bull')}
          canPropose={Boolean(card.instrument)}
        />
        <div className="border-t md:border-t-0 md:border-l border-border/60">
          <DebateSideView
            label="bear case"
            side={card.bear_case}
            color="rose"
            onPropose={() => onProposeFromSide('bear')}
            canPropose={Boolean(card.instrument)}
          />
        </div>
      </div>

      {/* Prior lean + recent grade */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 text-[10.5px] border-b border-border/60">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">your prior lean</div>
          <div className={`font-semibold ${priorColor}`}>{card.your_prior_lean}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">recent grade on this</div>
          <div className="text-muted-foreground">{card.recent_grade_on_this ?? '—'}</div>
        </div>
      </div>

      {/* Bias risk — amber emphasis */}
      {card.your_bias_risk && (
        <div className="px-3 py-2 text-[10.5px] border-b border-border/60 bg-amber-500/5">
          <div className="text-[9px] uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-0.5">
            your bias risk
          </div>
          <div className="text-amber-700 dark:text-amber-300">{card.your_bias_risk}</div>
        </div>
      )}

      {/* Synthesis — neutral framing, NOT a recommendation */}
      {card.synthesis && (
        <div className="px-3 py-2 text-[11px] leading-relaxed bg-muted/20">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">
            synthesis (not a recommendation)
          </div>
          <div className="italic">{card.synthesis}</div>
        </div>
      )}

      {/*
        Pick row — James's call. Sits BELOW the per-side Propose buttons by
        design: Propose is the "here's the trade if this side wins" tool,
        Pick is the "I'm committing to a stance" tool. They're different
        actions. user_pick stays null until James clicks — we never infer it.
        Buttons disable once a pick is made (click again same side is a
        no-op) and when debateId is null (persistence failed on save, so
        the PATCH has nowhere to land — Pick would be a ghost click).
      */}
      <div className="px-3 py-2 border-t border-border/60 bg-background/40">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5">
          your call {debateId == null && <span className="text-amber-500/80">· unsaved</span>}
        </div>
        <div className="flex gap-1.5">
          {(['bull', 'bear', 'neither'] as const).map((side) => {
            const isPicked = pick === side;
            const color = side === 'bull'
              ? 'emerald'
              : side === 'bear'
                ? 'rose'
                : 'zinc';
            const base = 'flex-1 text-[10.5px] px-2 py-1.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
            const picked = color === 'emerald'
              ? 'bg-emerald-500/20 border-emerald-500 text-emerald-700 dark:text-emerald-300'
              : color === 'rose'
                ? 'bg-rose-500/20 border-rose-500 text-rose-700 dark:text-rose-300'
                : 'bg-zinc-500/20 border-zinc-500 text-zinc-700 dark:text-zinc-300';
            const idle = color === 'emerald'
              ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10'
              : color === 'rose'
                ? 'border-rose-500/40 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10'
                : 'border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground';
            return (
              <button
                key={side}
                onClick={() => onPick(side)}
                disabled={debateId == null || pick != null}
                className={`${base} ${isPicked ? picked : idle}`}
                title={debateId == null
                  ? 'Debate not persisted — pick unavailable'
                  : pick != null
                    ? `You picked ${pick.toUpperCase()}`
                    : `Commit to the ${side.toUpperCase()} side`}
              >
                {isPicked ? '✓ ' : ''}I pick {side.toUpperCase()}
              </button>
            );
          })}
        </div>
        {pick != null && (
          <div className="text-[10px] text-muted-foreground/80 mt-1.5">
            Locked in <span className="font-semibold">{pick.toUpperCase()}</span>. Outcome scorer resolves after horizon. Review on <a href="/specialists" className="underline hover:text-foreground">/specialists</a>.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One side of a debate card. Color drives header + probability bar.
 * Probability bar is per-side (0-100). The paired-side bar is NOT a
 * complement — they're independent estimates (see DebateCardView note).
 */
function DebateSideView({
  label,
  side,
  color,
  onPropose,
  canPropose,
}: {
  label: string;
  side: DebateSide;
  color: 'emerald' | 'rose';
  onPropose: () => void;
  canPropose: boolean;
}) {
  const colorClasses = color === 'emerald'
    ? {
        header: 'text-emerald-700 dark:text-emerald-400',
        bar: 'bg-emerald-500',
        btn: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10',
        chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
      }
    : {
        header: 'text-rose-700 dark:text-rose-400',
        bar: 'bg-rose-500',
        btn: 'border-rose-500/50 text-rose-700 dark:text-rose-300 hover:bg-rose-500/10',
        chip: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
      };
  const prob = side.probability_estimate;

  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className={`text-[9px] uppercase tracking-wider font-semibold ${colorClasses.header}`}>
          {label}
        </div>
        {prob != null && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${colorClasses.chip}`}>
            {prob}%
          </span>
        )}
      </div>

      {/* Probability bar — independent per side, not a complement */}
      {prob != null && (
        <div className="h-1 w-full bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full ${colorClasses.bar}`}
            style={{ width: `${Math.max(0, Math.min(100, prob))}%` }}
          />
        </div>
      )}

      <div className="text-[11px] font-semibold leading-snug">{side.headline || '—'}</div>

      {side.evidence.length > 0 && (
        <ul className="space-y-0.5 text-[10.5px] leading-snug">
          {side.evidence.map((e, i) => (
            <li key={i} className="text-foreground/85">• {e}</li>
          ))}
        </ul>
      )}

      {side.best_trade && (
        <div className="text-[10.5px] mt-1 pt-2 border-t border-border/40">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">best trade if this wins</div>
          <div className="text-foreground/90">{side.best_trade}</div>
        </div>
      )}

      <button
        onClick={onPropose}
        disabled={!canPropose}
        className={`mt-auto text-[10.5px] px-2 py-1 rounded border ${colorClasses.btn} transition-colors disabled:opacity-40 disabled:cursor-not-allowed`}
        title={canPropose
          ? `Pre-fill /propose for the ${color === 'emerald' ? 'bull' : 'bear'} side`
          : 'Instrument unknown — /debate didn\'t parse a ticker from the topic'}
      >
        Propose trade from {color === 'emerald' ? 'bull' : 'bear'} side →
      </button>
    </div>
  );
}

/**
 * Renders a single /propose result as an expanded review card. The Accept
 * button pastes commit_syntax into the chat input (NOT auto-submit) so James
 * can sanity-check before pressing Enter. No server call, no trade is bound.
 */
function ProposalCardView({
  card,
  onAccept,
}: {
  card: ProposalCard;
  onAccept: (commitSyntax: string) => void;
}) {
  const em = card.expected_move;
  const emLabel = em.low_pct != null && em.high_pct != null
    ? `${em.low_pct > 0 ? '+' : ''}${em.low_pct}% / ${em.high_pct > 0 ? '+' : ''}${em.high_pct}%${em.confidence_pct != null ? ` @${em.confidence_pct}%` : ''}${em.horizon_hrs != null ? ` · ${em.horizon_hrs}h` : ''}`
    : null;
  const sideColor = card.side === 'long' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';

  return (
    <div className="my-2 rounded-lg border border-border bg-background/70 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/40">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold">{card.instrument}</span>
          <span className={`uppercase font-semibold ${sideColor}`}>{card.side}</span>
          <span className="text-muted-foreground">{card.size_pct}%</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">conv {card.conviction}/5</span>
        </div>
        <button
          onClick={() => onAccept(card.commit_syntax)}
          className="text-[11px] px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          title="Paste commit line into input for review"
        >
          Accept → Review
        </button>
      </div>

      {/* Levels */}
      <div className="grid grid-cols-3 gap-2 px-3 py-2 text-[11px] border-b border-border/60">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">entry</div>
          <div className="font-mono">{card.entry ?? '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">stop</div>
          <div className="font-mono">{card.stop ?? '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">target</div>
          <div className="font-mono">{card.target ?? '—'}</div>
        </div>
      </div>

      {/* Thesis */}
      <div className="px-3 py-2 text-[11px] leading-relaxed border-b border-border/60">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">thesis</div>
        <div>{card.thesis}</div>
      </div>

      {/* Expected move + evidence axes */}
      <div className="grid grid-cols-2 gap-2 px-3 py-2 text-[10.5px] border-b border-border/60">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">expected move</div>
          <div className="font-mono">{emLabel ?? '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">evidence axes</div>
          <div className="flex flex-wrap gap-1">
            {card.evidence_axes.length === 0 && <span className="text-muted-foreground">—</span>}
            {card.evidence_axes.map((a) => (
              <span key={a} className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">{a}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Bias check */}
      <div className="px-3 py-2 text-[10.5px] border-b border-border/60">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">bias check</div>
        <div className={card.bias_check === 'clear' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
          {card.bias_check}
        </div>
      </div>

      {/* Pre-trade concerns (warns) */}
      {card.pre_trade_concerns.length > 0 && (
        <div className="px-3 py-2 text-[10.5px] border-b border-border/60">
          <div className="text-[9px] uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">pre-trade concerns</div>
          <ul className="space-y-0.5">
            {card.pre_trade_concerns.map((c, idx) => (
              <li key={idx} className="text-amber-700 dark:text-amber-300">• {c}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Commit syntax */}
      <div className="px-3 py-2 bg-muted/30">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1">commit syntax</div>
        <code className="text-[10.5px] font-mono break-all">{card.commit_syntax}</code>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Persist history
  useEffect(() => { saveHistory(messages); }, [messages]);

  // Auto-scroll to newest message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  // Index of the first message that falls INSIDE the server-side history window
  // (i.e. the (HISTORY_WINDOW)-th-from-last). Anything before this gets a
  // divider above it saying "Claude doesn't see this".
  const firstInWindowIdx = useMemo(
    () => Math.max(0, messages.length - HISTORY_WINDOW),
    [messages.length],
  );

  // Chips show when the conversation is empty or still a single exchange.
  // Hide once there are 2+ messages (i.e. a real conversation has started).
  const showChips = messages.length < 2;

  function fillFromChip(prompt: string) {
    if (CHIPS_AUTO_SEND) {
      void send(prompt);
    } else {
      setInput(prompt);
      textareaRef.current?.focus();
    }
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    const userMsg: Message = { role: 'user', content: text, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setBusy(true);
    setBusyStartedAt(Date.now());
    try {
      // getUser() before getSession() forces a server refresh so we don't
      // send a stale cached JWT to the function (ct-chat rejects silently).
      await supabase.auth.getUser();
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData?.session?.access_token;
      if (!jwt) {
        setMessages([...next, { role: 'assistant', content: '(auth required — sign in)', ts: Date.now() }]);
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ct-chat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          history: next.slice(-HISTORY_WINDOW).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessages([...next, { role: 'assistant', content: `(error: ${body?.error ?? res.status})`, ts: Date.now() }]);
        return;
      }
      const meta: MessageMeta = {
        model: typeof body.model === 'string' ? body.model : undefined,
        tokens_in: typeof body.tokens_in === 'number' ? body.tokens_in : undefined,
        tokens_out: typeof body.tokens_out === 'number' ? body.tokens_out : undefined,
        cost_usd: typeof body.cost_usd === 'number' ? body.cost_usd : undefined,
        duration_ms: typeof body.duration_ms === 'number' ? body.duration_ms : undefined,
        mcp_calls: typeof body.mcp_calls === 'number' ? body.mcp_calls : undefined,
        cross_facet_hits: typeof body.cross_facet_hits === 'number' ? body.cross_facet_hits : undefined,
        cross_facet_used: typeof body.cross_facet_used === 'boolean' ? body.cross_facet_used : undefined,
        proposal_cards: Array.isArray(body.proposal_cards) ? (body.proposal_cards as ProposalCard[]) : undefined,
        debate_card: body.debate_card && typeof body.debate_card === 'object'
          ? (body.debate_card as DebateCard)
          : undefined,
        debate_id: typeof body.debate_id === 'string' ? body.debate_id : undefined,
      };
      setMessages([...next, {
        role: 'assistant',
        content: String(body.response ?? ''),
        ts: Date.now(),
        meta,
      }]);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `(network error: ${e instanceof Error ? e.message : e})`, ts: Date.now() }]);
    } finally {
      setBusy(false);
      setBusyStartedAt(null);
    }
  }

  return (
    <aside className="w-[420px] shrink-0 border-r border-border bg-card flex flex-col h-full pb-11">
      {/* Header pinned */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30 shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Chat with Claude</span>
          {messages.length > 0 && (
            <span className="text-[10px] text-muted-foreground">{messages.length} messages</span>
          )}
          <FreshnessChip
            timestamp={messages[messages.length - 1]?.ts ?? null}
            label="last msg"
          />
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMessages([]);
              if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
            }}
            title="Clear chat history"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {/* Messages area — this is the ONLY scrollable region */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.length === 0 && !busy && (
          <div className="text-xs text-muted-foreground/75 py-4 space-y-2 leading-relaxed">
            <p className="text-foreground/80 font-semibold">Ask Claude about the tape.</p>
            <p>He has the current heartbeat, theses, recent flow + dark pool, NOPE, top movers, news, and history loaded.</p>
          </div>
        )}
        {messages.map((m, i) => {
          // Divider sits ABOVE the first message Claude actually sees.
          // Only show it when there's at least one message that falls OUTSIDE
          // the window (otherwise the divider would hover above the first row
          // of a tiny conversation, which is noise).
          const showContextDivider =
            i === firstInWindowIdx && firstInWindowIdx > 0;
          return (
            <div key={i}>
              {showContextDivider && (
                <div className="flex items-center gap-2 my-3 text-[9px] uppercase tracking-wider text-muted-foreground/60">
                  <div className="flex-1 border-t border-border/60" />
                  <span>Claude sees from here ↓</span>
                  <div className="flex-1 border-t border-border/60" />
                </div>
              )}
              <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground whitespace-pre-wrap'
                    : 'bg-muted/60 text-foreground'
                }`}>
                  {m.role === 'assistant' ? (
                    <>
                      <AssistantBody content={m.content} />
                      {m.meta?.proposal_cards && m.meta.proposal_cards.length > 0 && (
                        <div className="mt-1">
                          {m.meta.proposal_cards.map((card, idx) => (
                            <ProposalCardView
                              key={idx}
                              card={card}
                              onAccept={(commitSyntax) => {
                                setInput(commitSyntax);
                                textareaRef.current?.focus();
                              }}
                            />
                          ))}
                        </div>
                      )}
                      {m.meta?.debate_card && (
                        <div className="mt-1">
                          <DebateCardView
                            card={m.meta.debate_card}
                            debateId={m.meta.debate_id ?? null}
                            pick={m.meta.debate_pick ?? null}
                            onPick={async (side) => {
                              const id = m.meta?.debate_id;
                              if (!id) return; // button is already disabled in this case
                              // Optimistic update — flip the local pick immediately,
                              // then PATCH. On failure we roll back so the buttons
                              // re-enable and James can retry.
                              const prev = m.meta?.debate_pick ?? null;
                              setMessages((curr) =>
                                curr.map((mm, idx) =>
                                  idx === i
                                    ? { ...mm, meta: { ...(mm.meta ?? {}), debate_pick: side } }
                                    : mm,
                                ),
                              );
                              const { error } = await supabase
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                .from('ct_debates' as any)
                                .update({ user_pick: side, user_pick_at: new Date().toISOString() })
                                .eq('id', id);
                              if (error) {
                                console.warn('[ChatPanel] debate pick PATCH failed:', error.message);
                                setMessages((curr) =>
                                  curr.map((mm, idx) =>
                                    idx === i
                                      ? { ...mm, meta: { ...(mm.meta ?? {}), debate_pick: prev ?? undefined } }
                                      : mm,
                                  ),
                                );
                              }
                            }}
                            onProposeFromSide={(side) => {
                              // Pre-fill /propose with the instrument. If Claude's
                              // debate had no instrument (e.g. "hold my current
                              // position"), we fall back to a bare /propose — the
                              // button is disabled in that case anyway.
                              const card = m.meta!.debate_card!;
                              const instrument = card.instrument ?? '';
                              // Include a brief comment tail so James sees WHICH
                              // side the propose came from when he reviews. ct-chat's
                              // /propose regex ignores trailing tokens after the
                              // ticker — this is display-only context for James.
                              const dir = side === 'bull' ? 'bull' : 'bear';
                              const cmd = instrument
                                ? `/propose ${instrument}  # from ${dir} side: ${side === 'bull' ? card.bull_case.headline : card.bear_case.headline}`
                                : '/propose';
                              setInput(cmd);
                              textareaRef.current?.focus();
                            }}
                          />
                        </div>
                      )}
                      <CrossFacetChip meta={m.meta} />
                      <div className="flex items-center justify-between gap-2 mt-1">
                        <MessageMetaLine meta={m.meta} />
                        <CopyButton text={m.content} />
                      </div>
                    </>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {busy && busyStartedAt != null && <ThinkingIndicator startedAt={busyStartedAt} />}
      </div>

      {/* Suggested prompts — sit directly above the input when relevant */}
      {showChips && !busy && (
        <div className="px-3 pt-2 border-t border-border shrink-0">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">
            quick start
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => fillFromChip(p)}
                className="text-[10.5px] px-2 py-1 rounded-full border border-border bg-muted/40 hover:bg-muted text-foreground/75 hover:text-foreground transition-colors whitespace-nowrap"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input pinned bottom */}
      <div className={`p-3 ${showChips && !busy ? '' : 'border-t border-border'} flex gap-2 shrink-0 items-end`}>
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="ask Claude about the tape… (shift+enter for newline)"
          disabled={busy}
          rows={2}
          className="text-xs min-h-[40px] max-h-[140px] resize-none"
        />
        <Button size="sm" onClick={() => void send()} disabled={busy || !input.trim()}>
          <Send className="w-3.5 h-3.5" />
        </Button>
      </div>
    </aside>
  );
}
