/**
 * DumpInput — The core of Brain Dump
 * 
 * GOAL: 2 seconds to dump anything. Zero friction. Zero questions.
 * 
 * If users have to think about WHERE something goes, we failed.
 * If users have to choose a TYPE, we failed.
 * If users have to wait, we failed.
 * 
 * Just dump. We handle the rest.
 */

import { useState, useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Send, Loader2, Sparkles, Check, Upload, Image, X, Mic, MicOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Extend Window interface for SpeechRecognition
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

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

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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
  const [isDragging, setIsDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ file: File; url: string } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Voice input handler
  const handleVoiceInput = () => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognitionAPI) {
      toast.error("Voice input not supported in this browser");
      return;
    }

    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setContent(prev => {
        const separator = prev.trim() ? ' ' : '';
        return prev + separator + transcript;
      });
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onerror = () => {
      setIsListening(false);
      recognitionRef.current = null;
      toast.error("Voice input failed. Please try again.");
    };

    recognition.start();
    setIsListening(true);
    toast.info("Listening... Speak now!");
  };

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

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewImage?.url) {
        URL.revokeObjectURL(previewImage.url);
      }
    };
  }, [previewImage]);

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return "Only images (PNG, JPG, WebP, GIF) are supported";
    }
    if (file.size > MAX_FILE_SIZE) {
      return "File too large. Max size is 10MB";
    }
    return null;
  };

  const handleFileSelect = (file: File) => {
    const error = validateFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    
    // Clean up previous preview
    if (previewImage?.url) {
      URL.revokeObjectURL(previewImage.url);
    }
    
    setPreviewImage({
      file,
      url: URL.createObjectURL(file),
    });
  };

  const clearPreview = () => {
    if (previewImage?.url) {
      URL.revokeObjectURL(previewImage.url);
    }
    setPreviewImage(null);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleFileSelect(files[0]);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          handleFileSelect(file);
        }
        return;
      }
    }
  }, []);

  const uploadImage = async (file: File): Promise<string> => {
    const fileExt = file.name.split('.').pop() || 'png';
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
    const filePath = `${userId}/${fileName}`;

    setUploadProgress("Uploading...");

    const { error: uploadError } = await supabase.storage
      .from('dumps')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    const { data: { publicUrl } } = supabase.storage
      .from('dumps')
      .getPublicUrl(filePath);

    return publicUrl;
  };

  const handleDump = async () => {
    if ((!content.trim() && !previewImage) || loading) return;

    const contentToSave = content.trim();
    const imageToUpload = previewImage;
    
    setLoading(true);
    setContent(""); // Clear immediately for better UX
    clearPreview();

    // Create optimistic entry
    let tempId: string | null = null;
    if (onOptimisticEntry) {
      tempId = onOptimisticEntry({
        id: `temp-${Date.now()}`,
        content: contentToSave || (imageToUpload ? "[Processing image...]" : ""),
        title: contentToSave?.slice(0, 50) || "Image",
        content_type: imageToUpload ? "image" : "note",
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
        image_url: imageToUpload?.url || null,
        _pending: true,
      });
    }

    try {
      let imageUrl: string | null = null;
      
      // Upload image if present
      if (imageToUpload) {
        setUploadProgress("Uploading image...");
        imageUrl = await uploadImage(imageToUpload.file);
        setUploadProgress("Analyzing with AI...");
      }

      const { data, error } = await supabase.functions.invoke("smart-save", {
        body: {
          content: contentToSave || "",
          userId,
          source: "manual",
          imageUrl,
        },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      // Success
      setSuccess(true);
      setUploadProgress(null);
      
      const successMessage = imageUrl 
        ? "Image analyzed and saved!" 
        : (data.summary || "Saved!");
      
      toast.success(successMessage, {
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
      setUploadProgress(null);
      
      // Remove optimistic entry on failure
      if (tempId && onOptimisticFail) {
        onOptimisticFail(tempId);
      }
      // Restore content on failure
      setContent(contentToSave);
      if (imageToUpload) {
        setPreviewImage(imageToUpload);
      }
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

  const hasContent = content.trim() || previewImage;

  return (
    <Card 
      className={cn(
        "p-4 transition-all duration-300",
        success && "ring-2 ring-green-500/50 bg-green-500/5",
        isDragging && "ring-2 ring-primary border-primary bg-primary/5",
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="space-y-3">
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-sm rounded-lg z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-primary">
              <Upload className="w-8 h-8 animate-bounce" />
              <span className="font-medium">Drop image here</span>
            </div>
          </div>
        )}

        {/* Image preview */}
        {previewImage && (
          <div className="relative inline-block">
            <img 
              src={previewImage.url} 
              alt="Preview" 
              className="max-h-32 rounded-lg border border-border"
            />
            <Button
              variant="destructive"
              size="icon"
              className="absolute -top-2 -right-2 w-6 h-6"
              onClick={clearPreview}
              disabled={loading}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        )}

        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={previewImage ? "Add a note about this image (optional)..." : "Dump anything... text, ideas, or drop/paste images"}
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
                <span className="text-sm">{uploadProgress || "Processing..."}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Sparkles className="w-3 h-3" />
              <span className="hidden sm:inline">AI auto-classifies your content</span>
              <span className="sm:hidden">AI-powered</span>
            </div>
            
            {/* Image upload button */}
            <input
              ref={fileInputRef}
              type="file"
              accept={ALLOWED_IMAGE_TYPES.join(',')}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileSelect(file);
                e.target.value = ''; // Reset for same file
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
            >
              <Image className="w-4 h-4" />
              <span className="hidden sm:inline ml-1">Image</span>
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
              onClick={handleVoiceInput}
              disabled={loading}
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
              onClick={handleDump}
              disabled={loading || !hasContent}
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
