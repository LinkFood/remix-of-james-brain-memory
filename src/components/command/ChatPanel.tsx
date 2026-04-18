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

interface MessageMeta {
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  mcp_calls?: number;
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
  return (
    <div className="markdown-body text-xs leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul]:pl-4 [&_ol]:pl-4 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-xs [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-1 [&_strong]:font-semibold [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-muted [&_code]:text-[11px] [&_pre]:p-2 [&_pre]:rounded [&_pre]:bg-muted/70 [&_pre]:overflow-x-auto [&_pre]:my-1.5 [&_pre>code]:bg-transparent [&_pre>code]:p-0">
      <ReactMarkdown
        components={{
          pre: ({ node, children, ...props }) => {
            // Detect a fenced code block whose language is "json" (or the body
            // parses as JSON) and collapse it to keep the chat scannable.
            const codeEl = (node?.children?.[0] ?? null) as
              | { tagName?: string; properties?: { className?: string[] }; children?: Array<{ value?: string }> }
              | null;
            const className = codeEl?.properties?.className?.join(' ') ?? '';
            const raw = codeEl?.children?.map((c) => c?.value ?? '').join('') ?? '';
            const isJsonLang = /language-json/i.test(className);
            let looksLikeJson = false;
            const trimmed = raw.trim();
            if (!isJsonLang && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
              try { JSON.parse(trimmed); looksLikeJson = true; } catch { /* not json */ }
            }
            if (isJsonLang || looksLikeJson) {
              return (
                <details className="my-1.5 rounded border border-border/60 bg-muted/40">
                  <summary className="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
                    structured output (click to expand)
                  </summary>
                  <pre className="p-2 overflow-x-auto text-[11px]" {...props}>{children}</pre>
                </details>
              );
            }
            return <pre {...props}>{children}</pre>;
          },
          // Links open in new tab to avoid nuking the chat.
          a: ({ node: _node, ...props }) => (
            <a target="_blank" rel="noreferrer noopener" className="underline text-primary" {...props} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
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
