import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Trash2, LayoutGrid, Sparkles } from 'lucide-react';
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
    localStorage.removeItem(STORAGE_KEY);
    toast({
      title: "Conversation cleared",
      description: "Starting fresh"
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
            <div className="text-center space-y-4 max-w-2xl px-4">
              <h2 className="text-3xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                Your Universal AI Memory System
              </h2>
              <p className="text-muted-foreground text-lg">
                Stop re-explaining context to your AI. James Brain OS captures every conversation, 
                scores importance, and injects relevant memories automatically.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8 text-left">
                <div className="p-4 border border-border rounded-lg">
                  <h3 className="font-semibold mb-2">Cross-Provider Memory</h3>
                  <p className="text-sm text-muted-foreground">
                    Switch between OpenAI, Claude, Gemini. Your memory travels with you.
                  </p>
                </div>
                <div className="p-4 border border-border rounded-lg">
                  <h3 className="font-semibold mb-2">Data Sovereignty</h3>
                  <p className="text-sm text-muted-foreground">
                    You own it. Export anytime. Delete with one click.
                  </p>
                </div>
                <div className="p-4 border border-border rounded-lg">
                  <h3 className="font-semibold mb-2">Compounding Intelligence</h3>
                  <p className="text-sm text-muted-foreground">
                    Every conversation makes future ones smarter. Context builds over time.
                  </p>
                </div>
              </div>
              <div className="mt-8 p-4 bg-muted/30 border border-primary/20 rounded-lg">
                <p className="text-sm text-muted-foreground">
                  💬 <strong>Demo Mode:</strong> Try the chat below. Conversations aren't saved unless you sign up.
                </p>
              </div>
            </div>
          </div>
        )}

        {showSignupPrompt && (
          <div className="mx-auto max-w-2xl">
            <div className="p-6 bg-gradient-to-br from-primary/10 to-primary/5 border-2 border-primary/30 rounded-lg space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="flex items-start gap-3">
                <Sparkles className="w-6 h-6 text-primary mt-1 flex-shrink-0" />
                <div className="flex-1 space-y-3">
                  <h3 className="font-bold text-lg">Ready to unlock your AI memory?</h3>
                  <p className="text-sm text-muted-foreground">
                    This conversation won't be saved. Create an account to:
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-1.5 ml-4">
                    <li>✓ Save and search all conversations</li>
                    <li>✓ Auto-inject relevant context into new chats</li>
                    <li>✓ Connect your own API keys (OpenAI, Claude, Gemini)</li>
                    <li>✓ Export your data anytime</li>
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
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearConversation}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Clear conversation
              </Button>
              {onMinimize && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onMinimize}
                  className="text-xs"
                >
                  <LayoutGrid className="h-3 w-3 mr-1" />
                  Preview Dashboard
                </Button>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about James Brain OS..."
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
