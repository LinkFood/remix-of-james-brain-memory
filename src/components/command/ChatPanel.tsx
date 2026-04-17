/**
 * ChatPanel — docked left-side chat with Claude.
 *
 * Full height, sticky layout: header pinned top, input pinned bottom,
 * messages area fills the middle and scrolls internally. The whole panel
 * doesn't scroll — only the messages. No floating modal, no open/close
 * toggle; it's always there, in the sidebar slot on co-trader routes.
 */
import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, MessageSquare, Send, Trash2 } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

const STORAGE_KEY = 'ct_chat_history_v1';

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

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>(() => loadHistory());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Persist history
  useEffect(() => { saveHistory(messages); }, [messages]);

  // Auto-scroll to newest message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const userMsg: Message = { role: 'user', content: text, ts: Date.now() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
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
          history: next.slice(-8).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessages([...next, { role: 'assistant', content: `(error: ${body?.error ?? res.status})`, ts: Date.now() }]);
        return;
      }
      setMessages([...next, { role: 'assistant', content: String(body.response ?? ''), ts: Date.now() }]);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `(network error: ${e instanceof Error ? e.message : e})`, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="w-[420px] shrink-0 border-r border-border bg-card flex flex-col h-full">
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
            <div className="space-y-1 pt-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Try:</p>
              <button
                onClick={() => setInput("what's your read on NVDA right now?")}
                className="block w-full text-left text-[11px] text-foreground/70 hover:text-foreground hover:bg-muted/50 rounded px-2 py-1 transition-colors"
              >
                "what's your read on NVDA right now?"
              </button>
              <button
                onClick={() => setInput("I'm bullish SPY into close — push back if you disagree")}
                className="block w-full text-left text-[11px] text-foreground/70 hover:text-foreground hover:bg-muted/50 rounded px-2 py-1 transition-colors"
              >
                "I'm bullish SPY into close — push back"
              </button>
              <button
                onClick={() => setInput("what's different vs an hour ago?")}
                className="block w-full text-left text-[11px] text-foreground/70 hover:text-foreground hover:bg-muted/50 rounded px-2 py-1 transition-colors"
              >
                "what's different vs an hour ago?"
              </button>
              <button
                onClick={() => setInput("what did we see about QQQ this morning?")}
                className="block w-full text-left text-[11px] text-foreground/70 hover:text-foreground hover:bg-muted/50 rounded px-2 py-1 transition-colors"
              >
                "what did we see about QQQ this morning?"
              </button>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[92%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed ${
              m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground'
            }`}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-muted/60 rounded-lg px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> thinking…
            </div>
          </div>
        )}
      </div>

      {/* Input pinned bottom */}
      <div className="p-3 border-t border-border flex gap-2 shrink-0">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="ask Claude about the tape…"
          disabled={busy}
          className="text-xs"
        />
        <Button size="sm" onClick={send} disabled={busy || !input.trim()}>
          <Send className="w-3.5 h-3.5" />
        </Button>
      </div>
    </aside>
  );
}
