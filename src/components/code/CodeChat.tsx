/**
 * CodeChat — Chat input + message history for JAC code commands
 *
 * Shows user messages, agent responses, and system status.
 * Textarea with Enter to send, Shift+Enter for newline.
 */

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, Code2, ExternalLink } from 'lucide-react';
import type { ChatMessage } from '@/types/agent';
import { cn } from '@/lib/utils';

interface CodeChatProps {
  onSend: (message: string) => void;
  sending: boolean;
  projectName: string | null;
  messages: ChatMessage[];
}

const EXAMPLE_COMMANDS = [
  'Fix the login bug',
  'Add dark mode toggle',
  'Refactor auth flow',
];

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'system') {
    return (
      <div className="flex justify-center py-1">
        <span className="text-[10px] text-muted-foreground/60 bg-muted/30 px-2.5 py-0.5 rounded-full">
          {msg.content}
        </span>
      </div>
    );
  }

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end py-1">
        <div className="max-w-[80%] bg-primary text-primary-foreground text-xs px-3 py-2 rounded-xl rounded-br-sm">
          {msg.content}
        </div>
      </div>
    );
  }

  // agent
  const prUrl = msg.metadata?.prUrl as string | undefined;
  return (
    <div className="flex justify-start py-1">
      <div className="max-w-[80%] bg-muted/50 text-foreground text-xs px-3 py-2 rounded-xl rounded-bl-sm space-y-1">
        {msg.content.split('\n').map((line, i) => (
          <p key={i}>{line}</p>
        ))}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline text-[10px] mt-1"
          >
            Open PR <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  );
}

export function CodeChat({ onSend, sending, projectName, messages }: CodeChatProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const disabled = !projectName || sending;

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {!hasMessages ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 opacity-40">
            <Code2 className="w-8 h-8 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Send commands to the JAC Code Agent below.
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {sending && (
              <div className="flex justify-center py-1">
                <span className="text-[10px] text-muted-foreground/60 bg-muted/30 px-2.5 py-0.5 rounded-full animate-pulse">
                  Processing...
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-border bg-card/30">
        {projectName && !input && !hasMessages && (
          <div className="px-3 pt-2 flex flex-wrap gap-1.5">
            {EXAMPLE_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                onClick={() => !disabled && setInput(cmd)}
                className="text-[10px] px-2 py-0.5 rounded-full border border-border bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
              >
                {cmd}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-3">
          <div className="flex gap-2 items-end">
            <div className="relative flex-1">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={projectName ? 'Tell JAC what to code...' : 'Select a project first'}
                disabled={disabled}
                className="min-h-[40px] max-h-[120px] resize-none text-sm pr-8"
                rows={1}
              />
              {projectName && (
                <Code2 className="absolute right-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground/30" />
              )}
            </div>
            <Button
              type="submit"
              size="icon"
              disabled={disabled || !input.trim()}
              className="shrink-0 h-10 w-10"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 mt-1.5 text-center">
            Enter to send · Shift+Enter for new line
          </p>
        </form>
      </div>
    </div>
  );
}
