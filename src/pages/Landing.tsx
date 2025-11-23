import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { LandingChat } from '@/components/LandingChat';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

const STORAGE_KEY = 'landing_chat_messages';

const Landing = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate('/dashboard');
      }
    });
  }, [navigate]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch (error) {
      console.error('Failed to save messages to localStorage:', error);
    }
  }, [messages]);

  const downloadChat = (format: 'json' | 'markdown' | 'txt') => {
    if (messages.length === 0) {
      toast({
        title: "No messages yet",
        description: "Start a conversation to download your data",
        variant: "destructive"
      });
      return;
    }

    const timestamp = new Date().toISOString().split('T')[0];
    let content = '';
    let filename = '';
    let mimeType = '';

    switch (format) {
      case 'json':
        content = JSON.stringify({ 
          exportedAt: new Date().toISOString(),
          messageCount: messages.length,
          messages 
        }, null, 2);
        filename = `jamesbrain-chat-${timestamp}.json`;
        mimeType = 'application/json';
        break;
      
      case 'markdown':
        content = `# James Brain Chat\n\nExported: ${new Date().toLocaleString()}\nMessages: ${messages.length}\n\n---\n\n`;
        content += messages.map(msg => {
          const role = msg.role === 'user' ? '**You**' : '**Assistant**';
          return `${role}:\n\n${msg.content}\n\n---\n`;
        }).join('\n');
        filename = `jamesbrain-chat-${timestamp}.md`;
        mimeType = 'text/markdown';
        break;
      
      case 'txt':
        content = `James Brain Chat\nExported: ${new Date().toLocaleString()}\nMessages: ${messages.length}\n\n${'='.repeat(50)}\n\n`;
        content += messages.map(msg => {
          const role = msg.role === 'user' ? 'You' : 'Assistant';
          return `${role}:\n${msg.content}\n\n${'-'.repeat(50)}\n`;
        }).join('\n');
        filename = `jamesbrain-chat-${timestamp}.txt`;
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

    toast({
      title: "Chat downloaded",
      description: "This is YOUR data. Take it anywhere."
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border/50 px-4 sm:px-6 py-3 sticky top-0 bg-background/80 backdrop-blur-xl z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center gap-4">
          <h1 className="text-base sm:text-lg font-semibold tracking-tight">JAMESBRAIN</h1>
          <div className="flex items-center gap-2 sm:gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="gap-2">
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">Download Data</span>
                  <span className="sm:hidden">Download</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover">
                <DropdownMenuItem onClick={() => downloadChat('json')}>
                  Download as JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadChat('markdown')}>
                  Download as Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadChat('txt')}>
                  Download as Text
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => navigate('/auth')} size="sm" variant="ghost">
              Sign In
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <LandingChat messages={messages} setMessages={setMessages} />
      </div>
    </div>
  );
};

export default Landing;
