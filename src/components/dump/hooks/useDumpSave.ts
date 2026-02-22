/**
 * useDumpSave - Smart save hook
 * 
 * Handles the core save logic with optimistic updates
 * Uses longer timeouts (30s) to handle edge function cold starts
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { addToQueue } from "@/hooks/useOfflineQueue";
import { retryWithBackoff } from "@/lib/retryWithBackoff";
import type { PreviewFile } from "../types";

const SMART_SAVE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/smart-save`;
const COLD_START_TIMEOUT = 45000; // 45 seconds for cold starts (increased for first request)
const WARMUP_TIMEOUT = 5000; // 5 seconds for warmup ping

interface UseDumpSaveOptions {
  userId: string;
  onSaveSuccess?: (entry: unknown) => void;
  onOptimisticEntry?: (pendingEntry: Record<string, unknown>) => string;
  onOptimisticComplete?: (tempId: string, realEntry: unknown) => void;
  onOptimisticFail?: (tempId: string) => void;
}

interface SaveParams {
  content: string;
  previewFile: PreviewFile | null;
  uploadFile: (file: File) => Promise<string>;
  setUploadProgress: (progress: string | null) => void;
  clearPreview: () => void;
  setContent: (content: string) => void;
  setPreviewFile: (file: PreviewFile | null) => void;
}

interface UseDumpSaveReturn {
  isSaving: boolean;
  success: boolean;
  save: (params: SaveParams) => Promise<void>;
}

export function useDumpSave({
  userId,
  onSaveSuccess,
  onOptimisticEntry,
  onOptimisticComplete,
  onOptimisticFail,
}: UseDumpSaveOptions): UseDumpSaveReturn {
  const [isSaving, setIsSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const save = useCallback(async ({
    content,
    previewFile,
    uploadFile,
    setUploadProgress,
    clearPreview,
    setContent,
    setPreviewFile,
  }: SaveParams) => {
    if ((!content.trim() && !previewFile) || isSaving) return;

    const contentToSave = content.trim();
    const fileToUpload = previewFile;
    
    setIsSaving(true);
    setContent(""); // Clear immediately for better UX
    clearPreview();

    // Create optimistic entry
    let tempId: string | null = null;
    if (onOptimisticEntry) {
      const fileLabel = fileToUpload?.isPdf ? "[Processing PDF...]" : "[Processing image...]";
      tempId = onOptimisticEntry({
        id: `temp-${Date.now()}`,
        content: contentToSave || (fileToUpload ? fileLabel : ""),
        title: contentToSave?.slice(0, 50) || (fileToUpload?.isPdf ? "PDF Document" : "Image"),
        content_type: fileToUpload?.isPdf ? "document" : (fileToUpload ? "image" : "note"),
        content_subtype: null,
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
        image_url: fileToUpload?.url || null,
        event_date: null,
        event_time: null,
        embedding: null,
        is_recurring: null,
        recurrence_pattern: null,
        _pending: true,
      });
    }

    let fileUrl: string | null = null;
    
    try {
      
      // Upload file if present
      if (fileToUpload) {
        const uploadLabel = fileToUpload.isPdf ? "Uploading PDF..." : "Uploading image...";
        setUploadProgress(uploadLabel);
        fileUrl = await uploadFile(fileToUpload.file);
        const analyzeLabel = fileToUpload.isPdf ? "Extracting PDF content..." : "Analyzing with AI...";
        setUploadProgress(analyzeLabel);
      }

      // Get auth session for custom fetch
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      // Warmup ping to reduce cold start failures (fire-and-forget with short timeout)
      const warmupController = new AbortController();
      const warmupTimeoutId = setTimeout(() => warmupController.abort(), WARMUP_TIMEOUT);
      fetch(SMART_SAVE_URL, { 
        method: "OPTIONS",
        signal: warmupController.signal,
      }).catch(() => {}).finally(() => clearTimeout(warmupTimeoutId));

      // Call smart-save with 45s timeout and retry logic for cold starts
      const response = await retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), COLD_START_TIMEOUT);
          
          try {
            const res = await fetch(SMART_SAVE_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${session.access_token}`,
                "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              },
              body: JSON.stringify({
                content: contentToSave || "",
                userId,
                source: "manual",
                imageUrl: fileUrl,
              }),
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            
            if (!res.ok) {
              const errorData = await res.json().catch(() => ({}));
              throw new Error(errorData.error || `Request failed: ${res.status}`);
            }
            
            return res.json();
          } catch (err: any) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
              throw new Error('Request timed out - server may be starting up');
            }
            throw err;
          }
        },
        {
          maxRetries: 5,
          baseDelayMs: 3000, // Increased from 2000 to 3000 for cold start buffer
          toastId: "retry-toast",
          showToast: true,
        }
      );

      const data = response;
      const error = data?.error ? new Error(data.error) : null;

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      setSuccess(true);
      setUploadProgress(null);
      
      const successMessage = fileToUpload?.isPdf 
        ? "PDF extracted and saved!"
        : fileUrl 
          ? "Image analyzed and saved!" 
          : (data.summary || "Saved!");
      
      const entryId = data.entry?.id;
      const entryTempId = tempId;
      
      toast.success(successMessage, {
        description: data.classification?.type
          ? `Type: ${data.classification.type}${data.classification.subtype ? ` (${data.classification.subtype})` : ""}`
          : undefined,
        action: entryId ? {
          label: "Undo",
          onClick: async () => {
            try {
              await supabase.from('entries').delete().eq('id', entryId);
              if (onOptimisticFail) onOptimisticFail(entryTempId || entryId);
              toast.info("Entry deleted");
            } catch (err) {
              toast.error("Failed to undo");
            }
          },
        } : undefined,
        duration: 5000,
      });

      if (tempId && onOptimisticComplete) {
        onOptimisticComplete(tempId, data.entry);
      } else if (onSaveSuccess) {
        onSaveSuccess(data.entry);
      }

      // Reset success after animation
      setTimeout(() => setSuccess(false), 2000);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const isNetworkError = errorMessage.includes('Failed to fetch') || 
                             errorMessage.includes('Failed to send a request') ||
                             errorMessage.includes('NetworkError') ||
                             errorMessage.includes('network');
      const isRateLimitError = errorMessage.includes('Rate limit') || 
                                errorMessage.includes('429') ||
                                errorMessage.includes('too many');
      const isContentError = errorMessage.includes('Content too long') ||
                              errorMessage.includes('too large') ||
                              errorMessage.includes('100000');
      const isTimeoutError = errorMessage.includes('timeout') ||
                              errorMessage.includes('timed out') ||
                              errorMessage.includes('AbortError');
      
      console.error("Failed to save:", error);
      toast.dismiss("retry-toast");
      
      if (isNetworkError) {
        // Queue for later sync instead of losing the data
        addToQueue({
          content: contentToSave,
          userId,
          source: "manual",
          imageUrl: fileUrl,
        });
        toast.info("Saved offline", {
          description: "Will sync when connection is restored",
        });
      } else if (isRateLimitError) {
        toast.error("Saving too quickly", {
          description: "Wait a moment and try again",
        });
      } else if (isContentError) {
        toast.error("Entry too long", {
          description: "Try breaking it into smaller pieces",
        });
      } else if (isTimeoutError) {
        // Queue for later since server might be busy
        addToQueue({
          content: contentToSave,
          userId,
          source: "manual",
          imageUrl: fileUrl,
        });
        toast.info("Server busy - queued for later", {
          description: "Will sync automatically",
        });
      } else {
        toast.error("Failed to save", {
          description: errorMessage.slice(0, 100),
        });
      }
      
      setUploadProgress(null);
      
      // Remove optimistic entry on failure
      if (tempId && onOptimisticFail) {
        onOptimisticFail(tempId);
      }
      // Restore content on failure
      setContent(contentToSave);
      if (fileToUpload) {
        setPreviewFile(fileToUpload);
      }
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, userId, onOptimisticEntry, onOptimisticComplete, onOptimisticFail, onSaveSuccess]);

  return {
    isSaving,
    success,
    save,
  };
}
