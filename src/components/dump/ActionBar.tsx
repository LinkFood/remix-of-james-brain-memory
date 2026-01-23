/**
 * ActionBar - Bottom toolbar with file, voice, and submit buttons
 */

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Send, Loader2, Check, Image, Mic, MicOff, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ALLOWED_FILE_TYPES } from "./types";

interface ActionBarProps {
  hasContent: boolean;
  isSaving: boolean;
  success: boolean;
  isListening: boolean;
  onFileSelect: (file: File) => void;
  onVoiceToggle: () => void;
  onSubmit: () => void;
}

export function ActionBar({
  hasContent,
  isSaving,
  success,
  isListening,
  onFileSelect,
  onVoiceToggle,
  onSubmit,
}: ActionBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="w-3 h-3" />
          <span className="hidden sm:inline">AI auto-classifies your content</span>
          <span className="sm:hidden">AI-powered</span>
        </div>
        
        {/* File upload button */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_FILE_TYPES.join(',')}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileSelect(file);
            e.target.value = ''; // Reset for same file
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
          disabled={isSaving}
        >
          <Image className="w-4 h-4" />
          <span className="hidden sm:inline ml-1">File</span>
        </Button>
        
        {/* Voice input button */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 px-2 transition-all",
            isListening 
              ? "text-red-500 animate-pulse bg-red-500/10" 
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={onVoiceToggle}
          disabled={isSaving}
        >
          {isListening ? (
            <MicOff className="w-4 h-4" />
          ) : (
            <Mic className="w-4 h-4" />
          )}
          <span className="hidden sm:inline ml-1">{isListening ? "Stop" : "Voice"}</span>
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground hidden sm:block">
          {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to save
        </span>
        <Button
          onClick={onSubmit}
          disabled={isSaving || !hasContent}
          className={cn(
            "min-w-[100px] transition-all duration-200",
            success && "bg-green-600 hover:bg-green-700"
          )}
        >
          {isSaving ? (
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
  );
}
