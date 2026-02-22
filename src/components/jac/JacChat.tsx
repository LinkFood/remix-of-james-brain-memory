/**
 * JacChat — Command channel to the boss agent
 *
 * This is where you talk to JAC. Messages show inline task dispatches
 * with live status. Think of it as a military command radio.
 */

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Send, Loader2, Bot, User, Zap, Globe, Brain,
  FileText, BarChart3, Eye, CheckCircle2, XCircle,
  ArrowRight, Sparkles,
} from 'lucide-react';
import type { JacMessage, AgentTask } from '@/types/agent';

const AGENT_META: Record<string, { name: string; icon: React.ReactNode; color: string }> = {
  'jac-dispatcher': { name: 'JAC', icon: <Zap className="w-3 h-3" />, color: 'text-violet-400' },
  'jac-research-agent': { name: 'Scout', icon: <Globe className="w-3 h-3" />, color: 'text-blue-400' },
  'jac-save-agent': { name: 'Scribe', icon: <FileText className="w-3 h-3" />, color: 'text-emerald-400' },
  'jac-search-agent': { name: 'Oracle', icon: <Brain className="w-3 h-3" />, color: 'text-amber-400' },
  'jac-report-agent': { name: 'Analyst', icon: <BarChart3 className="w-3 h-3" />, color: 'text-rose-400' },
  'jac-monitor-agent': { name: 'Sentinel', icon: <Eye className="w-3 h-3" />, color: 'text-cyan-400' },
};

const EXAMPLE_COMMANDS = [
  { text: 'Research React 19 features', icon: <Globe className="w-3.5 h-3.5" /> },
  { text: 'What do I know about investing?', icon: <Brain className="w-3.5 h-3.5" /> },
  { text: 'Save this: launch landing page by March', icon: <FileText className="w-3.5 h-3.5" /> },
];

interface JacChatProps {
  messages: JacMessage[];
  tasks: AgentTask[];
  sending: boolean;
  onSend: (text: string) => void;
}

function InlineTaskStatus({ task }: { task: AgentTask }) {
  const meta = AGENT_META[task.agent || ''] || AGENT_META['jac-dispatcher'];
  const isRunning = task.status === 'running' || task.status === 'queued';
  const isDone = task.status === 'completed';
  const isFailed = task.status === 'failed';

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all ${
      isRunning ? 'bg-blue-500/5 border border-blue-500/20' :
      isDone ? 'bg-green-500/5 border border-green-500/20' :
      isFailed ? 'bg-red-500/5 border border-red-500/20' :
      'bg-muted/30 border border-border'
    }`}>
      {isRunning ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
      ) : isDone ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
      ) : isFailed ? (
        <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
      ) : null}
      <span className={meta.color}>{meta.name}</span>
      <ArrowRight className="w-3 h-3 text-muted-foreground/40" />
      <span className="text-foreground/80 truncate">{task.intent || task.type}</span>
      <Badge variant="outline" className={`ml-auto text-[9px] px-1.5 py-0 shrink-0 ${
        isRunning ? 'border-blue-500/30 text-blue-400' :
        isDone ? 'border-green-500/30 text-green-500' :
        isFailed ? 'border-red-500/30 text-red-500' :
        ''
      }`}>
        {task.status}
      </Badge>
    </div>
  );
}

export function JacChat({ messages, tasks, sending, onSend }: JacChatProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    onSend(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const getLinkedTasks = (taskIds?: string[]): AgentTask[] => {
    if (!taskIds?.length) return [];
    return tasks.filter(t => taskIds.includes(t.id) && t.agent !== 'jac-dispatcher');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-primary/40" />
            </div>
            <h2 className="text-lg font-semibold text-foreground/80">JAC Agent OS</h2>
            <p className="text-sm text-muted-foreground mt-1 mb-6">
              Your agents are standing by. What do you need?
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
              key={msg.timestamp || i}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
              )}

              <div className={`max-w-[85%] space-y-2 ${msg.role === 'user' ? 'items-end' : ''}`}>
                <Card className={`p-3 text-sm ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/30 border-muted/50'
                }`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                </Card>

                {/* Inline task dispatches */}
                {msg.role === 'assistant' && getLinkedTasks(msg.taskIds).map(task => (
                  <InlineTaskStatus key={task.id} task={task} />
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
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">Dispatching...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-border bg-card/30">
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
        <p className="text-[10px] text-muted-foreground/50 mt-1.5 text-center">
          Enter to send · Shift+Enter for new line
        </p>
      </form>
    </div>
  );
}
