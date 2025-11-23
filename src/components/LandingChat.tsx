import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Send, Trash2, LayoutGrid, Sparkles, Download, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

const STORAGE_KEY = 'landing_chat_messages';

interface LandingChatProps {
  onMinimize?: () => void;
}

export const LandingChat = ({ onMinimize }: LandingChatProps) => {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'markdown' | 'txt'>('json');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (error) {
      console.error('Failed to save messages to localStorage:', error);
    }

    // Show signup prompt after 2 user messages
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    if (userMessageCount >= 2 && !showSignupPrompt) {
      setShowSignupPrompt(true);
    }
  }, [messages, showSignupPrompt]);

  const clearConversation = () => {
    setMessages([]);
    setHasDownloaded(false);
    localStorage.removeItem(STORAGE_KEY);
    toast({
      title: "Conversation cleared",
      description: "Starting fresh"
    });
  };

  const downloadChat = () => {
    if (messages.length === 0) {
      toast({
        title: "No messages to export",
        description: "Start a conversation first",
        variant: "destructive"
      });
      return;
    }

    const timestamp = new Date().toISOString().split('T')[0];
    let content = '';
    let filename = '';
    let mimeType = '';

    switch (exportFormat) {
      case 'json':
        content = JSON.stringify({ 
          exportedAt: new Date().toISOString(),
          messageCount: messages.length,
          messages 
        }, null, 2);
        filename = `demo-chat-${timestamp}.json`;
        mimeType = 'application/json';
        break;
      
      case 'markdown':
        content = `# James Brain OS Demo Chat\n\nExported: ${new Date().toLocaleString()}\nMessages: ${messages.length}\n\n---\n\n`;
        content += messages.map(msg => {
          const role = msg.role === 'user' ? '**You**' : '**Assistant**';
          return `${role}:\n\n${msg.content}\n\n---\n`;
        }).join('\n');
        filename = `demo-chat-${timestamp}.md`;
        mimeType = 'text/markdown';
        break;
      
      case 'txt':
        content = `James Brain OS Demo Chat\nExported: ${new Date().toLocaleString()}\nMessages: ${messages.length}\n\n${'='.repeat(50)}\n\n`;
        content += messages.map(msg => {
          const role = msg.role === 'user' ? 'You' : 'Assistant';
          return `${role}:\n${msg.content}\n\n${'-'.repeat(50)}\n`;
        }).join('\n');
        filename = `demo-chat-${timestamp}.txt`;
        mimeType = 'text/plain';
        break;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setHasDownloaded(true);
    toast({
      title: "✓ Chat downloaded",
      description: "This is YOUR data. Take it anywhere."
    });
  };

  const streamChat = async (userMessage: string) => {
    const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/landing-chat`;
    
    try {
      const resp = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({ 
          message: userMessage,
          conversationHistory: messages 
        }),
      });

      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || 'Failed to start stream');
      }

      if (!resp.body) throw new Error('No response body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';
      let streamDone = false;
      let assistantContent = '';

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') {
            streamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                  return prev.map((m, i) => 
                    i === prev.length - 1 ? { ...m, content: assistantContent } : m
                  );
                }
                return [...prev, { role: 'assistant', content: assistantContent }];
              });
            }
          } catch {
            textBuffer = line + '\n' + textBuffer;
            break;
          }
        }
      }

      if (textBuffer.trim()) {
        for (let raw of textBuffer.split('\n')) {
          if (!raw || raw.startsWith(':') || raw.trim() === '') continue;
          if (!raw.startsWith('data: ')) continue;
          const jsonStr = raw.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant') {
                  return prev.map((m, i) => 
                    i === prev.length - 1 ? { ...m, content: assistantContent } : m
                  );
                }
                return [...prev, { role: 'assistant', content: assistantContent }];
              });
            }
          } catch {}
        }
      }
    } catch (error) {
      console.error('Stream error:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to send message",
        variant: "destructive"
      });
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      await streamChat(userMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3 max-w-md px-4">
              <h2 className="text-2xl font-semibold">
                Ask me anything.
              </h2>
              <p className="text-muted-foreground">
                Your conversation, your data.
              </p>
            </div>
          </div>
        )}

        {showSignupPrompt && (
          <div className="mx-auto max-w-2xl">
            <div className="p-6 bg-gradient-to-br from-primary/10 to-primary/5 border-2 border-primary/30 rounded-lg space-y-4 animate-in slide-in-from-bottom-8 duration-700 ease-out" style={{ animationTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
              <div className="flex items-start gap-3">
                <Sparkles className="w-6 h-6 text-primary mt-1 flex-shrink-0" />
                <div className="flex-1 space-y-3">
                  <h3 className="font-bold text-lg">Ready to unlock your AI memory?</h3>
                  <p className="text-sm text-muted-foreground">
                    This conversation won't be saved. Create an account to:
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-1.5 ml-4">
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '400ms', animationFillMode: 'backwards' }}>✓ Save and search all conversations</li>
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '500ms', animationFillMode: 'backwards' }}>✓ Auto-inject relevant context into new chats</li>
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '600ms', animationFillMode: 'backwards' }}>✓ Connect your own API keys (OpenAI, Claude, Gemini)</li>
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '700ms', animationFillMode: 'backwards' }}>✓ Export your data anytime</li>
                  </ul>
                  <Button 
                    onClick={() => navigate('/auth')}
                    className="w-full sm:w-auto mt-4 animate-pulse hover:animate-none"
                    size="lg"
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    Sign Up - Start Building Your Memory
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {messages.map((message, idx) => (
          <div
            key={idx}
            className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] px-4 py-3 rounded-lg ${
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground'
              }`}
            >
              {message.role === 'assistant' ? (
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown
                    components={{
                      table: ({ children }) => (
                        <div className="overflow-x-auto my-4">
                          <table className="min-w-full divide-y divide-border text-sm">
                            {children}
                          </table>
                        </div>
                      ),
                      thead: ({ children }) => (
                        <thead className="bg-muted/50">{children}</thead>
                      ),
                      th: ({ children }) => (
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td className="px-3 py-2 text-xs">{children}</td>
                      ),
                      p: ({ children }) => (
                        <p className="mb-2 last:mb-0">{children}</p>
                      ),
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {message.content}
                </div>
              )}
            </div>
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role === 'user' && (
          <div className="flex justify-start">
            <div className="max-w-[80%] px-4 py-3 rounded-lg bg-muted text-foreground">
              <div className="text-sm text-muted-foreground">Thinking...</div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-border p-4">
        <div className="flex flex-col gap-2 max-w-4xl mx-auto">
          {messages.length > 0 && (
            <div className="flex flex-col gap-2">
              {hasDownloaded && (
                <div className="p-3 bg-primary/10 border border-primary/20 rounded-lg flex items-start gap-2 animate-in slide-in-from-top-2 duration-300">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                  <div className="flex-1 text-xs space-y-1">
                    <p className="font-semibold text-foreground">You own {messages.length} messages from this demo</p>
                    <p className="text-muted-foreground">Sign up to unlock the full memory system with your own API keys</p>
                  </div>
                </div>
              )}
              <div className="flex justify-between items-center gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                  <div className="px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-full flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                    <span className="font-medium">
                      {messages.filter(m => m.role === 'user').length} of 5 demo messages used
                    </span>
                  </div>
                  {messages.filter(m => m.role === 'user').length >= 4 && (
                    <span className="text-orange-500 font-medium animate-in fade-in duration-300">
                      Almost out! Sign up to continue
                    </span>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap justify-end">
                  <div className="flex gap-1">
                    <Select value={exportFormat} onValueChange={(value: any) => setExportFormat(value)}>
                      <SelectTrigger className="h-8 w-[90px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="json">JSON</SelectItem>
                        <SelectItem value="markdown">Markdown</SelectItem>
                        <SelectItem value="txt">Text</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={downloadChat}
                      className="text-xs h-8"
                    >
                      <Download className="h-3 w-3 mr-1" />
                      Download
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearConversation}
                    className="text-xs text-muted-foreground hover:text-foreground h-8"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Clear
                  </Button>
                  {onMinimize && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onMinimize}
                      className="text-xs h-8"
                    >
                      <LayoutGrid className="h-3 w-3 mr-1" />
                      Preview
                    </Button>
                  )}
                </div>
              </div>
              <Progress 
                value={(messages.filter(m => m.role === 'user').length / 5) * 100} 
                className="h-1.5 transition-all duration-500"
              />
            </div>
          )}
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message James Brain OS..."
              className="min-h-[60px] resize-none"
              disabled={isLoading}
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              size="icon"
              className="h-[60px] w-[60px] shrink-0"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
