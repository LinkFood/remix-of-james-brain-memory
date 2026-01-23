/**
 * TextInput - Auto-resizing textarea with loading overlay
 */

import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PreviewFile } from "./types";

export interface TextInputHandle {
  setValue: (text: string) => void;
  focus: () => void;
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  previewFile: PreviewFile | null;
  isLoading: boolean;
  uploadProgress: string | null;
}

export const TextInput = forwardRef<TextInputHandle, TextInputProps>(({
  value,
  onChange,
  onKeyDown,
  onPaste,
  previewFile,
  isLoading,
  uploadProgress,
}, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    setValue: (text: string) => {
      onChange(text);
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
  }, [value]);

  const getPlaceholder = () => {
    if (previewFile?.isPdf) {
      return "Add a note about this PDF (optional)...";
    }
    if (previewFile) {
      return "Add a note about this image (optional)...";
    }
    return "Dump anything... text, ideas, images, or PDFs";
  };

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={getPlaceholder()}
        className={cn(
          "min-h-[100px] max-h-[300px] resize-none text-base",
          "bg-background/50 border-border/50",
          "focus:ring-2 focus:ring-primary/20 focus:border-primary/50",
          "placeholder:text-muted-foreground/60",
          "transition-all duration-200"
        )}
        disabled={isLoading}
      />
      {isLoading && (
        <div className="absolute inset-0 bg-background/50 backdrop-blur-sm flex items-center justify-center rounded-md">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">{uploadProgress || "Processing..."}</span>
          </div>
        </div>
      )}
    </div>
  );
});

TextInput.displayName = "TextInput";
