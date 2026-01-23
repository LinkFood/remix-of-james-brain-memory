import { useState, useRef, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Send, Loader2, Sparkles, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DumpInputProps {
  userId: string;
  onSaveSuccess?: (entry: any) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement>;
}

const DumpInput = ({ userId, onSaveSuccess, inputRef: externalRef }: DumpInputProps) => {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef || internalRef;

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

    setLoading(true);

    try {
      const { data, error } = await supabase.functions.invoke("smart-save", {
        body: {
          content: content.trim(),
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
      setContent("");
      toast.success(data.summary || "Saved!", {
        description: data.classification?.type
          ? `Type: ${data.classification.type}${data.classification.subtype ? ` (${data.classification.subtype})` : ""}`
          : undefined,
      });

      if (onSaveSuccess) {
        onSaveSuccess(data.entry);
      }
    } catch (error: any) {
      console.error("Failed to save:", error);
      toast.error(error.message || "Failed to save. Please try again.");
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
      success && "ring-2 ring-green-500/50 bg-green-500/5"
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
};

export default DumpInput;
