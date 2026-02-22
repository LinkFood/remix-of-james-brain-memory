import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Send, Loader2, Bot, User } from 'lucide-react';
import type { JacMessage, AgentTask } from '@/types/agent';

interface JacChatProps {
  messages: JacMessage[];
  tasks: AgentTask[];
  sending: boolean;
  onSend: (text: string) => void;
}

export function JacChat({ messages, tasks, sending, onSend }: JacChatProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    onSend(input);
    setInput('');
  };

  // Find running tasks linked to a message
  const getLinkedTasks = (taskIds?: string[]): AgentTask[] => {
    if (!taskIds?.length) return [];
    return tasks.filter((t) => taskIds.includes(t.id));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Bot className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm font-medium">JAC Agent OS</p>
            <p className="text-xs mt-1">Send a message to dispatch your agents</p>
            <div className="mt-4 space-y-1 text-xs opacity-60">
              <p>"Research the latest on React Server Components"</p>
              <p>"Save this idea: build a habit tracker app"</p>
              <p>"What do I know about machine learning?"</p>
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-primary" />
                </div>
              )}

              <div className={`max-w-[80%] space-y-1 ${msg.role === 'user' ? 'items-end' : ''}`}>
                <Card
                  className={`p-3 text-sm ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                </Card>

                {/* Inline task cards for dispatched work */}
                {msg.role === 'assistant' &&
                  getLinkedTasks(msg.taskIds)
                    .filter((t) => t.agent !== 'jac-dispatcher')
                    .map((task) => (
                      <div
                        key={task.id}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs ${
                          task.status === 'running'
                            ? 'bg-blue-500/10 text-blue-600'
                            : task.status === 'completed'
                            ? 'bg-green-500/10 text-green-600'
                            : task.status === 'failed'
                            ? 'bg-red-500/10 text-red-600'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {task.status === 'running' ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : task.status === 'completed' ? (
                          <span>done</span>
                        ) : task.status === 'failed' ? (
                          <span>failed</span>
                        ) : null}
                        <span>{task.agent}</span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          {task.status}
                        </Badge>
                      </div>
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
          <div className="flex gap-3 items-center">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Thinking...
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-border">
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Tell JAC what to do..."
            disabled={sending}
            className="flex-1"
          />
          <Button type="submit" size="icon" disabled={sending || !input.trim()}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </form>
    </div>
  );
}
