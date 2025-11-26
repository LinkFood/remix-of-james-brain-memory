import { useEffect, useState } from 'react';
import { Plus, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type ConversationMeta = {
  id: string;
  title: string;
  timestamp: number;
  messageCount: number;
};

type LandingConversationSidebarProps = {
  currentConversationId: string;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
};

const CONVERSATIONS_KEY = 'landing_conversations';

export const LandingConversationSidebar = ({
  currentConversationId,
  onNewChat,
  onSelectConversation,
}: LandingConversationSidebarProps) => {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 1000);
    return () => clearInterval(interval);
  }, []);

  const loadConversations = () => {
    try {
      const stored = localStorage.getItem(CONVERSATIONS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setConversations(parsed);
      }
    } catch (error) {
      console.error('Failed to load conversations:', error);
    }
  };

  const formatTimestamp = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <>
      {/* Mobile Toggle */}
      <Button
        variant="ghost"
        size="sm"
        className="fixed top-16 left-4 z-50 lg:hidden"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </Button>

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed lg:relative inset-y-0 left-0 z-40 w-72 border-r border-border/50 bg-background/95 backdrop-blur-xl transition-transform duration-300 lg:translate-x-0 flex flex-col",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="p-4 border-b border-border/50">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-foreground/80">Your Conversations</h2>
            <span className="text-xs text-muted-foreground">{conversations.length}</span>
          </div>
          <Button
            onClick={() => {
              onNewChat();
              setIsOpen(false);
            }}
            className="w-full gap-2"
            size="sm"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {conversations.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                Start your first conversation
              </div>
            ) : (
              conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => {
                    onSelectConversation(conv.id);
                    setIsOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg transition-colors hover:bg-muted/50",
                    currentConversationId === conv.id && "bg-muted"
                  )}
                >
                  <div className="font-medium text-sm text-foreground truncate mb-1">
                    {conv.title}
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{conv.messageCount} messages</span>
                    <span>{formatTimestamp(conv.timestamp)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Mobile Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
};

export const updateLandingConversation = (conversationId: string, messages: any[]) => {
  try {
    const stored = localStorage.getItem(CONVERSATIONS_KEY);
    const conversations: ConversationMeta[] = stored ? JSON.parse(stored) : [];
    
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) return;

    const title = userMessages[0].content.slice(0, 50) + (userMessages[0].content.length > 50 ? '...' : '');
    
    const existingIndex = conversations.findIndex(c => c.id === conversationId);
    
    if (existingIndex >= 0) {
      conversations[existingIndex] = {
        id: conversationId,
        title,
        timestamp: Date.now(),
        messageCount: messages.length,
      };
    } else {
      conversations.unshift({
        id: conversationId,
        title,
        timestamp: Date.now(),
        messageCount: messages.length,
      });
    }

    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  } catch (error) {
    console.error('Failed to update conversation:', error);
  }
};
