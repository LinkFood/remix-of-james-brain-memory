import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import { updateLandingConversation } from './LandingConversationSidebar';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

interface LandingChatProps {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: string;
  onIntentDetected?: (intent: string) => void;
}

export const LandingChat = ({ messages, setMessages, conversationId, onIntentDetected }: LandingChatProps) => {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const detectIntent = (message: string): string | null => {
    const lower = message.toLowerCase();
    
    const signupPatterns = [
      'sign up', 'signup', 'create account', 'create an account',
      'register', 'get started', 'join', 'sign me up', 'help me sign up',
      'want to try', 'how do i start', 'make an account'
    ];
    const loginPatterns = [
      'sign in', 'signin', 'login', 'log in', 'already have account'
    ];
    const howItWorksPatterns = [
      'how does this work', 'how it works', 'explain', 'what is this',
      'tell me more', 'learn more', 'what does this do'
    ];
    
    if (signupPatterns.some(p => lower.includes(p))) return 'signup';
    if (loginPatterns.some(p => lower.includes(p))) return 'login';
    if (howItWorksPatterns.some(p => lower.includes(p))) return 'how-it-works';
    return null;
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Show signup prompt after 3 user messages
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    if (userMessageCount >= 3 && !showSignupPrompt) {
      setShowSignupPrompt(true);
    }
  }, [messages, showSignupPrompt]);

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
    const intent = detectIntent(userMessage);
    
    if (intent && onIntentDetected) {
      setMessages(prev => [
        ...prev, 
        { role: 'user', content: userMessage }
      ]);
      setInput('');
      onIntentDetected(intent);
      return;
    }

    setInput('');
    const newMessages: Message[] = [...messages, { role: 'user' as const, content: userMessage }];
    setMessages(newMessages);
    updateLandingConversation(conversationId, newMessages);
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
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-4xl mx-auto space-y-6">
        {messages.length === 0 && (
          <div className="text-center space-y-4 py-8 animate-fade-in">
            <p className="text-muted-foreground">
              👆 Try asking anything. Watch your conversation appear in the sidebar.
            </p>
            <p className="text-sm text-muted-foreground/60">
              This is proof it works. No marketing fluff, just truth.
            </p>
          </div>
        )}

        {showSignupPrompt && (
          <div className="mx-auto max-w-2xl">
            <div className="p-6 bg-gradient-to-br from-primary/10 to-primary/5 border-2 border-primary/30 rounded-lg space-y-4 animate-in slide-in-from-bottom-8 duration-700 ease-out" style={{ animationTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
              <div className="flex items-start gap-3">
                <Sparkles className="w-6 h-6 text-primary mt-1 flex-shrink-0" />
                <div className="flex-1 space-y-3">
                  <h3 className="font-bold text-lg">Your conversation history is fragmented across AI platforms. We fix that.</h3>
                  <p className="text-sm text-muted-foreground">
                    This demo conversation won't be saved. Sign up to build your unified AI memory:
                  </p>
                  <ul className="text-sm text-muted-foreground space-y-1.5 ml-4">
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '400ms', animationFillMode: 'backwards' }}>✓ Use any model (GPT, Claude, Gemini) with your API keys</li>
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '500ms', animationFillMode: 'backwards' }}>✓ Every conversation builds your personal knowledge base</li>
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '600ms', animationFillMode: 'backwards' }}>✓ Past context automatically enhances new chats</li>
                    <li className="animate-in fade-in slide-in-from-left-2 duration-300" style={{ animationDelay: '700ms', animationFillMode: 'backwards' }}>✓ Own and export all your data, always</li>
                  </ul>
                  <Button 
                    onClick={() => navigate('/auth')}
                    className="w-full sm:w-auto mt-4 animate-pulse hover:animate-none"
                    size="lg"
                  >
                    <Sparkles className="w-4 h-4 mr-2" />
                    Start Building Your Memory
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
              className={`max-w-[80%] px-4 py-3 rounded-2xl ${
                message.role === 'user'
                  ? 'bg-primary text-primary-foreground shadow-subtle'
                  : 'bg-muted/50 text-foreground'
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
      </div>

      {/* Input Area - Fixed at Bottom */}
      <div className="flex-shrink-0 border-t border-border/50 px-4 sm:px-6 py-4 bg-background/80 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto flex flex-col gap-2">
          {messages.length > 0 && messages.filter(m => m.role === 'user').length >= 4 && (
            <div className="text-xs text-center text-muted-foreground">
              <span className="text-orange-500 font-medium">
                Almost out of demo messages! Sign up to continue
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              className="min-h-[60px] resize-none bg-muted/50 border-border/50 focus-visible:ring-1 focus-visible:ring-border"
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
