import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Send, Loader2, AlertCircle, Copy, Star, Trash2, Edit2, Check, X, MoreVertical, Database, MessageSquare, Zap } from "lucide-react";
import { MemoryInjectionBanner } from "@/components/MemoryInjectionBanner";
import { toast } from "sonner";
import ConversationSidebar from "./ConversationSidebar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getImportanceLabel, getImportanceColor } from "./ImportanceFilter";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useSwipeable } from "react-swipeable";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  importance_score?: number | null;
  starred?: boolean;
  edited?: boolean;
  edit_history?: any[];
  memoriesUsed?: number;
  memories?: Array<{
    content: string;
    snippet?: string;
    similarity?: number;
    importance?: number | null;
    importance_score?: number | null;
    created_at?: string | null;
  }>;
}

interface ChatInterfaceProps {
  userId: string;
  initialConversationId?: string | null;
}

const ChatInterface = ({ userId, initialConversationId }: ChatInterfaceProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId || null);
  const [provider, setProvider] = useState<string>("openai");
  const [model, setModel] = useState<string>("gpt-4-turbo");
  const [hasApiKey, setHasApiKey] = useState<boolean>(true);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [memoryStats, setMemoryStats] = useState({ totalMessages: 0, totalConversations: 0, totalProviders: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const modelOptions = {
    openai: [
      { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
      { value: "gpt-4", label: "GPT-4" },
      { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
    ],
    anthropic: [
      { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
      { value: "claude-3-opus-20240229", label: "Claude 3 Opus" },
      { value: "claude-3-haiku-20240307", label: "Claude 3 Haiku" },
    ],
    google: [
      { value: "gemini-pro", label: "Gemini Pro" },
      { value: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    ],
  };

  useEffect(() => {
    if (initialConversationId) {
      setConversationId(initialConversationId);
    }
  }, [initialConversationId]);

  useEffect(() => {
    checkApiKey();
    fetchMemoryStats();
  }, [userId]);

  const fetchMemoryStats = async () => {
    try {
      const [messagesResult, conversationsResult] = await Promise.all([
        supabase.from("messages").select("id", { count: "exact", head: true }).eq("user_id", userId),
        supabase.from("conversations").select("id", { count: "exact", head: true }).eq("user_id", userId)
      ]);

      const providersResult = await supabase
        .from("messages")
        .select("provider")
        .eq("user_id", userId)
        .not("provider", "is", null);

      const uniqueProviders = new Set(providersResult.data?.map(m => m.provider) || []).size;

      setMemoryStats({
        totalMessages: messagesResult.count || 0,
        totalConversations: conversationsResult.count || 0,
        totalProviders: uniqueProviders
      });
    } catch (error) {
      console.error("Failed to fetch memory stats:", error);
    }
  };

  useEffect(() => {
    if (!conversationId) {
      initConversation();
    } else {
      loadMessages();
    }
  }, [conversationId]);

  const checkApiKey = async () => {
    try {
      const { data, error } = await supabase
        .from("user_api_keys")
        .select("id")
        .eq("user_id", userId)
        .limit(1);

      if (error) throw error;
      setHasApiKey(data && data.length > 0);
    } catch (error) {
      console.error("Failed to check API key:", error);
      setHasApiKey(false);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!conversationId || messages.length === 0) return;

    const hasUnscored = messages.some(m => m.importance_score === null || m.importance_score === undefined);
    if (!hasUnscored) return;

    const interval = setInterval(() => {
      loadMessages();
    }, 10000);

    return () => clearInterval(interval);
  }, [conversationId, messages]);

  const initConversation = async () => {
    try {
      const { data, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select()
        .single();

      if (error) throw error;
      setConversationId(data.id);
    } catch (error: any) {
      toast.error("Failed to initialize conversation");
      console.error(error);
    }
  };

  const loadMessages = async () => {
    if (!conversationId) return;
    
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages((data || []).map(msg => ({
        ...msg,
        edit_history: Array.isArray(msg.edit_history) ? msg.edit_history : []
      })));
    } catch (error: any) {
      toast.error("Failed to load messages");
      console.error(error);
    }
  };

  const handleSelectConversation = (id: string) => {
    setConversationId(id);
    setMessages([]);
  };

  const handleNewConversation = () => {
    setConversationId(null);
    setMessages([]);
  };

  const handleCopyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied to clipboard");
    } catch (error) {
      toast.error("Failed to copy");
    }
  };

  const handleStarMessage = async (messageId: string, currentStarred: boolean) => {
    try {
      const { error } = await supabase
        .from("messages")
        .update({ starred: !currentStarred })
        .eq("id", messageId);

      if (error) throw error;
      loadMessages();
      toast.success(currentStarred ? "Unstarred" : "Starred");
    } catch (error) {
      toast.error("Failed to update");
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("id", messageId);

      if (error) throw error;
      loadMessages();
      toast.success("Message deleted");
    } catch (error) {
      toast.error("Failed to delete");
    }
  };

  const startEditMessage = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditContent(content);
  };

  const cancelEditMessage = () => {
    setEditingMessageId(null);
    setEditContent("");
  };

  const saveEditMessage = async (messageId: string) => {
    if (!editContent.trim()) {
      cancelEditMessage();
      return;
    }

    try {
      const message = messages.find(m => m.id === messageId);
      if (!message) return;

      const editHistory = message.edit_history || [];
      editHistory.push({
        content: message.content,
        edited_at: new Date().toISOString(),
      });

      const { error } = await supabase
        .from("messages")
        .update({ 
          content: editContent.trim(),
          edited: true,
          edit_history: editHistory
        })
        .eq("id", messageId);

      if (error) throw error;
      loadMessages();
      toast.success("Message updated");
    } catch (error) {
      toast.error("Failed to update");
    } finally {
      cancelEditMessage();
    }
  };

  const handleSend = async () => {
    if (!input.trim() || !conversationId || loading) return;

    const userMessage = input.trim();
    setInput("");
    setLoading(true);

    const tempUserMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: userMessage,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const { data, error } = await supabase.functions.invoke("chat", {
        body: {
          message: userMessage,
          conversationId,
          userId,
          provider,
          model,
        },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.response,
        created_at: new Date().toISOString(),
        memoriesUsed: data.memoriesUsed || 0,
        memories: data.memories || [],
      };
      setMessages((prev) => [...prev, assistantMsg]);
      fetchMemoryStats();
      
      if (messages.length === 1) {
        updateConversationTitle(userMessage);
      }
    } catch (error: any) {
      const errorMessage = error.message || "Failed to get response";
      
      if (errorMessage.includes("API key")) {
        toast.error("Invalid or missing API key. Please check your settings.");
        setHasApiKey(false);
      } else if (errorMessage.includes("rate limit")) {
        toast.error("Rate limit exceeded. Please try again later.");
      } else if (errorMessage.includes("quota")) {
        toast.error("API quota exceeded. Please check your API key billing.");
      } else {
        toast.error(errorMessage);
      }
      
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  const updateConversationTitle = async (firstMessage: string) => {
    if (!conversationId) return;
    
    try {
      const title = firstMessage.slice(0, 50) + (firstMessage.length > 50 ? "..." : "");
      await supabase
        .from("conversations")
        .update({ title })
        .eq("id", conversationId);
    } catch (error) {
      console.error("Failed to update conversation title:", error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-12rem)]">
      <ConversationSidebar
        userId={userId}
        currentConversationId={conversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      
      <div className="flex-1 flex flex-col gap-4">
        {memoryStats.totalMessages > 0 && (
          <Card className="p-4 bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-primary" />
                <span className="font-semibold text-sm">Memory Bank</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <MessageSquare className="w-4 h-4" />
                  <span>{memoryStats.totalMessages} memories</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Zap className="w-4 h-4" />
                  <span>{memoryStats.totalConversations} conversations</span>
                </div>
                {memoryStats.totalProviders > 0 && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    <span>{memoryStats.totalProviders} {memoryStats.totalProviders === 1 ? 'provider' : 'providers'}</span>
                  </div>
                )}
              </div>
            </div>
          </Card>
        )}

        {!hasApiKey && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No API key configured. Please add an API key in Settings to start chatting.
            </AlertDescription>
          </Alert>
        )}

        <Card className="flex-1 overflow-y-auto p-6 bg-card border-border space-y-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p>Start a conversation to build your memory vault...</p>
          </div>
        ) : (
          messages.map((msg) => {
            const swipeHandlers = useSwipeable({
              onSwipedLeft: () => {
                if (msg.role === "user" || msg.role === "assistant") {
                  handleDeleteMessage(msg.id);
                }
              },
              onSwipedRight: () => {
                if (msg.role === "user" || msg.role === "assistant") {
                  handleStarMessage(msg.id, msg.starred || false);
                }
              },
              trackMouse: false,
              delta: 50,
            });

            return (
              <div key={msg.id} {...swipeHandlers}>
                {msg.role === "assistant" && msg.memories && msg.memories.length > 0 && (
                  <MemoryInjectionBanner memories={msg.memories} />
                )}
                <div
                  className={cn(
                    "flex group animate-fade-in",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-3 relative",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground shadow-glow"
                        : "bg-secondary text-secondary-foreground"
                    )}
                  >
                  {msg.starred && (
                    <Star className="absolute -top-2 -right-2 h-4 w-4 text-primary fill-primary" />
                  )}
                  
                  {editingMessageId === msg.id ? (
                    <div className="space-y-2">
                      <Input
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="min-h-[60px]"
                        autoFocus
                      />
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => saveEditMessage(msg.id)}>
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={cancelEditMessage}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed mb-2 whitespace-pre-wrap">{msg.content}</p>
                      {msg.edited && (
                        <Badge variant="outline" className="text-xs mr-2">
                          Edited
                        </Badge>
                      )}
                      {msg.importance_score !== null && msg.importance_score !== undefined && (
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${getImportanceColor(msg.importance_score)} mt-2`}
                        >
                          {msg.importance_score} - {getImportanceLabel(msg.importance_score)}
                        </Badge>
                      )}
                    </>
                  )}

                  <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-6 w-6 touch-target">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="bg-popover z-50">
                        <DropdownMenuItem onClick={() => handleCopyMessage(msg.content)}>
                          <Copy className="h-4 w-4 mr-2" />
                          Copy
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleStarMessage(msg.id, msg.starred || false)}>
                          <Star className="h-4 w-4 mr-2" />
                          {msg.starred ? "Unstar" : "Star"}
                        </DropdownMenuItem>
                        {(msg.role === "user" || msg.role === "assistant") && (
                          <>
                            <DropdownMenuItem onClick={() => startEditMessage(msg.id, msg.content)}>
                              <Edit2 className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => handleDeleteMessage(msg.id)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                </div>
              </div>
            );
          })
        )}
        {loading && (
          <div className="flex justify-start animate-fade-in">
            <div className="bg-secondary text-secondary-foreground rounded-2xl px-4 py-3">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          </div>
        )}
          <div ref={messagesEndRef} />
        </Card>

        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
              className="min-h-[60px] bg-input border-border focus:ring-primary resize-none"
              disabled={loading || !conversationId || !hasApiKey}
            />
          </div>
          <div className="flex gap-2 items-center">
            <Select value={`${provider}-${model}`} onValueChange={(value) => {
              const [prov, ...modelParts] = value.split('-');
              setProvider(prov);
              setModel(modelParts.join('-'));
            }}>
              <SelectTrigger className="w-[140px] h-[60px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover z-50">
                <SelectItem value="openai-gpt-4-turbo">GPT-4 Turbo</SelectItem>
                <SelectItem value="openai-gpt-4">GPT-4</SelectItem>
                <SelectItem value="openai-gpt-3.5-turbo">GPT-3.5</SelectItem>
                <SelectItem value="anthropic-claude-3-5-sonnet-20241022">Claude 3.5</SelectItem>
                <SelectItem value="anthropic-claude-3-opus-20240229">Claude Opus</SelectItem>
                <SelectItem value="google-gemini-pro">Gemini Pro</SelectItem>
                <SelectItem value="google-gemini-1.5-flash">Gemini Flash</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={handleSend}
              disabled={loading || !input.trim() || !conversationId || !hasApiKey}
              className="bg-primary hover:bg-primary-glow text-primary-foreground shadow-glow touch-target h-[60px] w-[60px]"
              size="icon"
            >
              <Send className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
