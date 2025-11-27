import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { MemoryInjectionBanner } from './MemoryInjectionBanner';
import { toast } from '@/hooks/use-toast';

type Message = {
  role: 'user' | 'assistant';
  content: string;
  memories?: Array<{ content: string; importance_score: number }>;
};

interface LandingChatProps {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: string;
  onSignupClick: () => void;
}

const DEMO_MEMORIES = [
  { content: "You like spicy food and prefer Thai cuisine", importance_score: 0.85 },
  { content: "You run a printing business in Maryland", importance_score: 0.92 },
  { content: "You have a 4-month-old son", importance_score: 0.95 },
];

const EXAMPLE_PROMPTS = [
  "How does cross-platform memory work?",
  "What makes this different from ChatGPT?",
  "Show me an example of memory injection"
];

export const LandingChat = ({ messages, setMessages, conversationId, onSignupClick }: LandingChatProps) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const streamChat = async (userMessage: string) => {
    console.log('🚀 streamChat called with message:', userMessage);
    setIsLoading(true);
    
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
    };

    // Randomly inject 1-2 demo memories for demo preview
    if (Math.random() > 0.3) {
      const memoryCount = Math.random() > 0.5 ? 2 : 1;
      assistantMessage.memories = DEMO_MEMORIES.slice(0, memoryCount);
      console.log('💾 Injecting demo memories:', memoryCount);
    }

    console.log('📝 Adding user message and empty assistant message to state');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }, assistantMessage]);

    try {
      console.log('🌐 Making fetch request to landing-chat edge function');
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/landing-chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: JSON.stringify({
            messages: [
              ...messages.map((msg) => ({ role: msg.role, content: msg.content })),
              { role: 'user', content: userMessage },
            ],
            conversationId,
          }),
        }
      );

      console.log('📡 Response received, status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Response not OK:', response.status, errorText);
        throw new Error(`Chat failed: ${response.status} - ${errorText}`);
      }

      if (!response.body) {
        console.error('❌ No response body');
        throw new Error('No response body');
      }

      console.log('✅ Starting to read stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('✅ Stream complete');
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              console.log('✅ Received [DONE] signal');
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || '';
              if (content) {
                console.log('📨 Received content chunk:', content.substring(0, 20) + '...');
                setMessages((prev) => 
                  prev.map((msg, idx) => 
                    idx === prev.length - 1 && msg.role === 'assistant'
                      ? { ...msg, content: msg.content + content }
                      : msg
                  )
                );
              }
            } catch (e) {
              console.error('❌ Parse error:', e);
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Chat error:', error);
      toast({
        title: "Chat Error",
        description: error instanceof Error ? error.message : "Failed to send message. Please try again.",
        variant: "destructive",
      });
      setMessages((prev) => 
        prev.map((msg, idx) => 
          idx === prev.length - 1 && msg.role === 'assistant'
            ? { ...msg, content: 'Sorry, I encountered an error. Please try again.' }
            : msg
        )
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    console.log('🎯 handleSend called');
    console.log('📝 Input value:', input);
    console.log('⏳ isLoading:', isLoading);
    
    if (!input.trim() || isLoading) {
      console.log('⚠️ Blocked: empty input or already loading');
      return;
    }

    const userMessage = input.trim();
    console.log('✅ Proceeding to send message:', userMessage);
    setInput('');
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    await streamChat(userMessage);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleExampleClick = (prompt: string) => {
    setInput(prompt);
    textareaRef.current?.focus();
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {isEmpty ? (
        // Centered empty state - like ChatGPT
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-32">
          <div className="max-w-3xl w-full space-y-8 animate-fade-in">
            <div className="text-center space-y-4">
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
                Your AI conversations,
                <br />
                <span className="text-primary">finally unified</span>
              </h1>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                ChatGPT forgets what you told Claude. Claude doesn't know what you asked Gemini.
                <span className="text-foreground font-medium"> We fix that.</span>
              </p>
            </div>

            {/* Example prompts */}
            <div className="grid sm:grid-cols-3 gap-3">
              {EXAMPLE_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleExampleClick(prompt)}
                  className="p-4 rounded-lg border border-border/50 bg-card hover:bg-accent/50 text-left transition-colors group"
                >
                  <div className="text-sm font-medium group-hover:text-primary transition-colors">
                    {prompt}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        // Message list - standard chat view
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {messages.map((msg, idx) => (
              <div key={idx}>
                {msg.role === 'user' ? (
                  <div className="flex justify-end">
                    <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-3 max-w-[80%]">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                     <div className="flex-1 space-y-3">
                      {msg.memories && msg.memories.length > 0 && msg.content.length > 50 && (
                        <div className="animate-in fade-in slide-in-from-top-2 duration-500">
                          <MemoryInjectionBanner memories={msg.memories} />
                        </div>
                      )}
                      <div className="prose prose-sm max-w-none dark:prose-invert">
                        <ReactMarkdown
                          components={{
                            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                            ul: ({ children }) => <ul className="mb-2 list-disc pl-4">{children}</ul>,
                            ol: ({ children }) => <ol className="mb-2 list-decimal pl-4">{children}</ol>,
                            li: ({ children }) => <li className="mb-1">{children}</li>,
                          }}
                        >
                          {msg.content || '●●●'}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-primary animate-pulse" />
                </div>
                <div className="text-muted-foreground">Thinking...</div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Input area - always at bottom */}
      <div className="flex-shrink-0 border-t border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <div className="flex gap-2 items-end">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              disabled={isLoading}
              className="flex-1 min-h-[48px] max-h-[200px] resize-none bg-card border-border/50"
              rows={1}
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              size="icon"
              className={`h-12 w-12 rounded-xl transition-all ${isLoading ? 'animate-pulse' : ''}`}
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </Button>
          </div>
          {isEmpty && (
            <p className="text-xs text-center text-muted-foreground mt-3">
              ✨ Try the demo (using our AI) ·{' '}
              <button onClick={onSignupClick} className="text-primary hover:underline font-medium">
                Sign up
              </button>{' '}
              to connect your own
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
