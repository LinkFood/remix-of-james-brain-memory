/**
 * JacChat — Talk to JAC
 *
 * Clean conversational interface. JAC handles the routing behind the scenes.
 * Task status only shows when something is actively working or failed.
 */

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Send, Loader2, Bot, User, Sparkles,
  ArrowRight, CheckCircle2, XCircle, Globe, Brain, FileText, Code2,
} from 'lucide-react';
import type { JacMessage, AgentTask } from '@/types/agent';

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

const EXAMPLE_COMMANDS = [
  { text: 'Research React 19 features', icon: <Globe className="w-3.5 h-3.5" /> },
  { text: 'What do I know about investing?', icon: <Brain className="w-3.5 h-3.5" /> },
  { text: 'Save this: launch landing page by March', icon: <FileText className="w-3.5 h-3.5" /> },
  { text: 'What\'s on my schedule today?', icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
];

interface JacChatProps {
  messages: JacMessage[];
  tasks: AgentTask[];
  sending: boolean;
  onSend: (text: string) => void;
}

function ActiveTaskIndicator({ task }: { task: AgentTask }) {
  const isRunning = task.status === 'running' || task.status === 'queued';
  const isFailed = task.status === 'failed';

  // Only show running or failed tasks — completed ones are silent
  if (!isRunning && !isFailed) return null;

  const label = isRunning
    ? task.type === 'research' ? 'Researching...'
      : task.type === 'save' ? 'Saving...'
      : task.type === 'search' ? 'Searching...'
      : task.type === 'code' ? 'Coding...'
      : 'Working...'
    : 'Something went wrong';

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs ${
      isRunning ? 'text-blue-400' : 'text-red-400'
    }`}>
      {isRunning ? (
        <Loader2 className="w-3 h-3 animate-spin shrink-0" />
      ) : (
        <XCircle className="w-3 h-3 shrink-0" />
      )}
      <span>{label}</span>
    </div>
  );
}

export function JacChat({ messages, tasks, sending, onSend }: JacChatProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    onSend(input.trim());
    setInput('');
    // Refocus the textarea after sending
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const getActiveTasks = (taskIds?: string[]): AgentTask[] => {
    if (!taskIds?.length) return [];
    return tasks.filter(t =>
      taskIds.includes(t.id) &&
      t.agent !== 'jac-dispatcher' &&
      (t.status === 'running' || t.status === 'queued' || t.status === 'failed')
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-primary/40" />
            </div>
            <h2 className="text-lg font-semibold text-foreground/80">Hey, it's JAC</h2>
            <p className="text-sm text-muted-foreground mt-1 mb-6">
              What do you need?
            </p>
            <div className="space-y-2 w-full max-w-sm">
              {EXAMPLE_COMMANDS.map((cmd) => (
                <button
                  key={cmd.text}
                  onClick={() => !sending && onSend(cmd.text)}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-card/50 hover:bg-muted/50 transition-colors text-left group"
                >
                  <span className="text-muted-foreground group-hover:text-primary transition-colors">{cmd.icon}</span>
                  <span className="text-sm text-foreground/70 group-hover:text-foreground transition-colors">{cmd.text}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/0 group-hover:text-muted-foreground ml-auto transition-all" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={`${msg.timestamp}-${msg.role}-${i}`}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
              )}

              <div className={`max-w-[85%] space-y-1 ${msg.role === 'user' ? 'items-end' : ''}`}>
                <div className={`px-3.5 py-2.5 rounded-2xl text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-md'
                    : 'bg-muted/40 border border-border/50 rounded-bl-md'
                }`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                </div>

                {/* Message metadata: agent, timestamp, tokens, cost */}
                {msg.role === 'assistant' && (() => {
                  const linkedTasks = msg.taskIds?.length
                    ? tasks.filter(t => msg.taskIds!.includes(t.id))
                    : [];
                  const task = linkedTasks.find(t => t.agent !== 'jac-dispatcher') || linkedTasks[0];
                  const agentName = task?.agent ? (AGENT_LABELS[task.agent] || task.agent) : null;
                  const showAgent = agentName && agentName !== 'JAC';
                  const totalTokens = task ? ((task.tokens_in || 0) + (task.tokens_out || 0)) : 0;

                  return (
                    <div className={`flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground/50 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                      <span>{timeAgo(msg.timestamp)}</span>
                      {showAgent && <><span>·</span><span>{agentName}</span></>}
                      {totalTokens > 0 && <><span>·</span><span>{formatTokens(totalTokens)} tokens</span></>}
                      {task?.cost_usd ? <><span>·</span><span>{formatCost(task.cost_usd)}</span></> : null}
                    </div>
                  );
                })()}

                {/* Only show active/failed tasks — hide completed */}
                {msg.role === 'assistant' && getActiveTasks(msg.taskIds).map(task => (
                  <ActiveTaskIndicator key={task.id} task={task} />
                ))}
              </div>

              {msg.role === 'user' && (
                <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  <User className="w-4 h-4 text-muted-foreground" />
                </div>
              )}
            </div>
          ))
        )}

        {sending && (
          <div className="flex gap-3 items-start">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-muted/40 border border-border/50">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
        </div>
      </div>

      {/* Input — always visible at bottom */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto">
          <div className="flex gap-2 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell JAC what to do..."
              disabled={sending}
              className="flex-1 min-h-[40px] max-h-[120px] resize-none text-sm"
              rows={1}
            />
            <Button
              type="submit"
              size="icon"
              disabled={sending || !input.trim()}
              className="shrink-0 h-10 w-10"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 mt-1.5 text-center hidden sm:block">
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      </form>
    </div>
  );
}
