/**
 * useDumpSave - Smart save hook
 * 
 * Handles the core save logic with optimistic updates
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { PreviewFile, PendingEntry } from "../types";

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

    try {
      let fileUrl: string | null = null;
      
      // Upload file if present
      if (fileToUpload) {
        const uploadLabel = fileToUpload.isPdf ? "Uploading PDF..." : "Uploading image...";
        setUploadProgress(uploadLabel);
        fileUrl = await uploadFile(fileToUpload.file);
        const analyzeLabel = fileToUpload.isPdf ? "Extracting PDF content..." : "Analyzing with AI...";
        setUploadProgress(analyzeLabel);
      }

      const { data, error } = await supabase.functions.invoke("smart-save", {
        body: {
          content: contentToSave || "",
          userId,
          source: "manual",
          imageUrl: fileUrl,
        },
      });

      if (error) throw error;

      if (data.error) {
        throw new Error(data.error);
      }

      // Success
      setSuccess(true);
      setUploadProgress(null);
      
      const successMessage = fileToUpload?.isPdf 
        ? "PDF extracted and saved!"
        : fileUrl 
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

      // Reset success after animation
      setTimeout(() => setSuccess(false), 2000);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to save. Please try again.";
      console.error("Failed to save:", error);
      toast.error(errorMessage);
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
