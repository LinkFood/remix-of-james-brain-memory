import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Send,
  Loader2,
  ChevronUp,
  ChevronDown,
  X,
  Sparkles,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{
    id: string;
    title: string | null;
    content_type: string;
    similarity?: number;
  }>;
}

interface AssistantChatProps {
  userId: string;
  onEntryCreated?: (entry: any) => void;
}

const suggestedQueries = [
  "What's on my list?",
  "What did I dump today?",
  "Find code about...",
  "Summarize my ideas",
];

const AssistantChat = ({ userId, onEntryCreated }: AssistantChatProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && !isMinimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen, isMinimized]);

  useEffect(() => {
    if (isOpen && !isMinimized) {
      inputRef.current?.focus();
    }
  }, [isOpen, isMinimized]);

  const handleSend = async (messageText?: string) => {
    const text = messageText || input.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke("assistant-chat", {
        body: {
          message: text,
          userId,
          conversationHistory: messages.slice(-6).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: data.response,
        sources: data.sourcesUsed,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // If a new entry was created, notify parent
      if (data.newDumpCreated && onEntryCreated) {
        onEntryCreated(data.newDumpCreated);
        toast.success("Added to your brain", {
          description: data.newDumpCreated.title || "New entry saved",
        });
      }
    } catch (error: any) {
      console.error("Assistant error:", error);
      toast.error(error.message || "Failed to get response");
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, I encountered an error. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleOpen = () => {
    if (!isOpen) {
      setIsOpen(true);
      setIsMinimized(false);
    } else if (isMinimized) {
      setIsMinimized(false);
    } else {
      setIsMinimized(true);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setIsMinimized(true);
  };

  // Floating button when closed
  if (!isOpen) {
    return (
      <Button
        onClick={toggleOpen}
        className="fixed bottom-4 right-4 h-14 w-14 rounded-full shadow-lg z-50"
        size="icon"
      >
        <MessageSquare className="w-6 h-6" />
      </Button>
    );
  }

  return (
    <Card
      className={cn(
        "fixed bottom-4 right-4 z-50 transition-all duration-300 shadow-xl",
        isMinimized ? "w-72" : "w-96 h-[500px]"
      )}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 border-b cursor-pointer"
        onClick={toggleOpen}
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <span className="font-medium text-sm">Brain Assistant</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              toggleOpen();
            }}
          >
            {isMinimized ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              handleClose();
            }}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Minimized state */}
      {isMinimized && (
        <div className="p-3">
          <p className="text-xs text-muted-foreground">
            Ask about your brain dump...
          </p>
        </div>
      )}

      {/* Expanded state */}
      {!isMinimized && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 h-[350px]">
            {messages.length === 0 && (
              <div className="text-center py-6">
                <Sparkles className="w-8 h-8 mx-auto text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground mb-4">
                  I know everything in your brain dump. Ask me anything!
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {suggestedQueries.map((query) => (
                    <Button
                      key={query}
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => handleSend(query)}
                    >
                      {query}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, index) => (
              <div
                key={index}
                className={cn(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  )}
                >
                  <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>

                  {/* Sources */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/50">
                      <p className="text-xs text-muted-foreground mb-1">
                        Sources:
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {msg.sources.slice(0, 3).map((source) => (
                          <Badge
                            key={source.id}
                            variant="secondary"
                            className="text-xs"
                          >
                            <FileText className="w-3 h-3 mr-1" />
                            {source.title || source.content_type}
                          </Badge>
                        ))}
                        {msg.sources.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{msg.sources.length - 3}
                          </Badge>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-lg px-3 py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-3 border-t">
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask your brain..."
                disabled={loading}
                className="text-sm"
              />
              <Button
                onClick={() => handleSend()}
                disabled={loading || !input.trim()}
                size="icon"
                className="shrink-0"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
};

export default AssistantChat;
