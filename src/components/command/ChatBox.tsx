/**
 * ChatBox — conversational interface with Claude, grounded in the live state.
 * Floating panel at the bottom-right of the CommandStation. Toggle to hide/show.
 */
import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, MessageSquare, Send, X } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

export function ChatBox() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    const userMsg: Message = { role: 'user', content: text, ts: Date.now() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setBusy(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData?.session?.access_token;
      if (!jwt) {
        setMessages([...nextMessages, { role: 'assistant', content: '(auth required — please sign in)', ts: Date.now() }]);
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
          history: nextMessages.slice(-8).map(m => ({ role: m.role, content: m.content })),
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        setMessages([...nextMessages, { role: 'assistant', content: `(error: ${body?.error ?? res.status})`, ts: Date.now() }]);
        return;
      }
      setMessages([...nextMessages, { role: 'assistant', content: String(body.response ?? ''), ts: Date.now() }]);
    } catch (e) {
      setMessages([...nextMessages, { role: 'assistant', content: `(network error: ${e instanceof Error ? e.message : e})`, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 shadow-lg"
        size="sm"
      >
        <MessageSquare className="w-4 h-4 mr-1" /> Chat w/ Claude
      </Button>
    );
  }

  return (
    <Card className="fixed bottom-4 right-4 z-50 w-[400px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-2rem)] flex flex-col shadow-2xl">
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Chat with Claude</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !busy && (
          <div className="text-xs text-muted-foreground/70 text-center py-6">
            Ask Claude about what he sees. He has the current heartbeat, theses, and recent events loaded.
            <br /><br />
            Try: <span className="text-foreground/80">"what's your read on NVDA right now?"</span> or <span className="text-foreground/80">"I'm bullish SPY into close, push back if you disagree"</span>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed ${
              m.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-foreground'
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

      <div className="p-3 border-t border-border flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="ask Claude about the tape..."
          disabled={busy}
          className="text-xs"
        />
        <Button size="sm" onClick={send} disabled={busy || !input.trim()}>
          <Send className="w-3.5 h-3.5" />
        </Button>
      </div>
    </Card>
  );
}
