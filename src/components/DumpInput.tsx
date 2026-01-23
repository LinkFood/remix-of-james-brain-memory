import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Send, Loader2, Sparkles, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface DumpInputHandle {
  setValue: (text: string) => void;
  focus: () => void;
}

interface DumpInputProps {
  userId: string;
  onSaveSuccess?: (entry: any) => void;
  onOptimisticEntry?: (pendingEntry: any) => string; // Returns temp ID
  onOptimisticComplete?: (tempId: string, realEntry: any) => void;
  onOptimisticFail?: (tempId: string) => void;
  className?: string;
}

const DumpInput = forwardRef<DumpInputHandle, DumpInputProps>(({
  userId,
  onSaveSuccess,
  onOptimisticEntry,
  onOptimisticComplete,
  onOptimisticFail,
  className,
}, ref) => {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    setValue: (text: string) => {
      setContent(text);
    },
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 300)}px`;
    }
  }, [content]);

  // Reset success state after animation
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  const handleDump = async () => {
    if (!content.trim() || loading) return;

    const contentToSave = content.trim();
    setLoading(true);
    setContent(""); // Clear immediately for better UX

    // Create optimistic entry
    let tempId: string | null = null;
    if (onOptimisticEntry) {
      tempId = onOptimisticEntry({
        id: `temp-${Date.now()}`,
        content: contentToSave,
        title: contentToSave.slice(0, 50),
        content_type: "note",
        tags: [],
        importance_score: null,
        starred: false,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        user_id: userId,
        source: "manual",
        list_items: [],
        extracted_data: {},
        _pending: true,
      });
    }

    try {
      const { data, error } = await supabase.functions.invoke("smart-save", {
        body: {
          content: contentToSave,
          userId,
          source: "manual",
        },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      // Success
      setSuccess(true);
      toast.success(data.summary || "Saved!", {
        description: data.classification?.type
          ? `Type: ${data.classification.type}${data.classification.subtype ? ` (${data.classification.subtype})` : ""}`
          : undefined,
      });

      if (tempId && onOptimisticComplete) {
        onOptimisticComplete(tempId, data.entry);
      } else if (onSaveSuccess) {
        onSaveSuccess(data.entry);
      }
    } catch (error: any) {
      console.error("Failed to save:", error);
      toast.error(error.message || "Failed to save. Please try again.");
      
      // Remove optimistic entry on failure
      if (tempId && onOptimisticFail) {
        onOptimisticFail(tempId);
      }
      // Restore content on failure
      setContent(contentToSave);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter to save
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleDump();
    }
  };

  return (
    <Card className={cn(
      "p-4 transition-all duration-300",
      success && "ring-2 ring-green-500/50 bg-green-500/5",
      className
    )}>
      <div className="space-y-3">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Dump anything... code, ideas, lists, links, notes"
            className={cn(
              "min-h-[100px] max-h-[300px] resize-none text-base",
              "bg-background/50 border-border/50",
              "focus:ring-2 focus:ring-primary/20 focus:border-primary/50",
              "placeholder:text-muted-foreground/60",
              "transition-all duration-200"
            )}
            disabled={loading}
          />
          {loading && (
            <div className="absolute inset-0 bg-background/50 backdrop-blur-sm flex items-center justify-center rounded-md">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm">Processing...</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sparkles className="w-3 h-3" />
            <span>AI auto-classifies and organizes your content</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:block">
              {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to save
            </span>
            <Button
              onClick={handleDump}
              disabled={loading || !content.trim()}
              className={cn(
                "min-w-[100px] transition-all duration-200",
                success && "bg-green-600 hover:bg-green-700"
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Saving</span>
                </>
              ) : success ? (
                <>
                  <Check className="w-4 h-4" />
                  <span>Saved</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Dump</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
});

DumpInput.displayName = "DumpInput";

export default DumpInput;
