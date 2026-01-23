/**
 * useFileUpload - File handling hook
 * 
 * Manages file validation, preview URLs, and drag/drop state
 */

import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PreviewFile, ALLOWED_FILE_TYPES, MAX_FILE_SIZE } from "../types";

interface UseFileUploadOptions {
  userId: string;
}

interface UseFileUploadReturn {
  previewFile: PreviewFile | null;
  isDragging: boolean;
  uploadProgress: string | null;
  handleFileSelect: (file: File) => void;
  clearPreview: () => void;
  uploadFile: (file: File) => Promise<string>;
  setUploadProgress: (progress: string | null) => void;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  handlePaste: (e: React.ClipboardEvent) => void;
}

export function useFileUpload({ userId }: UseFileUploadOptions): UseFileUploadReturn {
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewFile?.url && !previewFile.isPdf) {
        URL.revokeObjectURL(previewFile.url);
      }
    };
  }, [previewFile]);

  const validateFile = useCallback((file: File): string | null => {
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return "Only images (PNG, JPG, WebP, GIF) and PDFs are supported";
    }
    if (file.size > MAX_FILE_SIZE) {
      return "File too large. Max size is 20MB";
    }
    return null;
  }, []);

  const handleFileSelect = useCallback((file: File) => {
    const error = validateFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    
    // Clean up previous preview
    if (previewFile?.url && !previewFile.isPdf) {
      URL.revokeObjectURL(previewFile.url);
    }
    
    const isPdf = file.type === 'application/pdf';
    setPreviewFile({
      file,
      url: isPdf ? '' : URL.createObjectURL(file),
      isPdf,
    });
  }, [previewFile, validateFile]);

  const clearPreview = useCallback(() => {
    if (previewFile?.url && !previewFile.isPdf) {
      URL.revokeObjectURL(previewFile.url);
    }
    setPreviewFile(null);
  }, [previewFile]);

  const uploadFile = useCallback(async (file: File): Promise<string> => {
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

    // Return relative path for signed URL generation
    const storagePath = `dumps/${filePath}`;
    return storagePath;
  }, [userId]);

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
  }, [handleFileSelect]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const type = items[i].type;
      if (type.startsWith('image/') || type === 'application/pdf') {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          handleFileSelect(file);
        }
        return;
      }
    }
  }, [handleFileSelect]);

  return {
    previewFile,
    isDragging,
    uploadProgress,
    handleFileSelect,
    clearPreview,
    uploadFile,
    setUploadProgress,
    dragHandlers: {
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    handlePaste,
  };
}
