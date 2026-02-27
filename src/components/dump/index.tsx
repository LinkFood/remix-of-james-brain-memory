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

import { useState, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Types
import type { DumpInputProps, DumpInputHandle, PreviewFile } from "./types";

// Hooks
import { useVoiceInput, useFileUpload, useDumpSave } from "./hooks";

// Components
import { TextInput, TextInputHandle } from "./TextInput";
import { FilePreview } from "./FilePreview";
import { ActionBar } from "./ActionBar";
import { DragOverlay } from "./DragOverlay";

const DumpInput = forwardRef<DumpInputHandle, DumpInputProps>(({
  userId,
  onSaveSuccess,
  onOptimisticEntry,
  onOptimisticComplete,
  onOptimisticFail,
  className,
}, ref) => {
  const [content, setContent] = useState("");
  const textInputRef = useRef<TextInputHandle>(null);

  // Custom hooks
  const {
    previewFile,
    isDragging,
    uploadProgress,
    handleFileSelect,
    clearPreview,
    uploadFile,
    setUploadProgress,
    dragHandlers,
    handlePaste,
  } = useFileUpload({ userId });

  const { isListening, toggleVoice } = useVoiceInput({
    onTranscript: (transcript) => {
      setContent(prev => {
        const separator = prev.trim() ? ' ' : '';
        return prev + separator + transcript;
      });
    },
  });

  const { isSaving, success, save } = useDumpSave({
    userId,
    onSaveSuccess,
    onOptimisticEntry,
    onOptimisticComplete,
    onOptimisticFail,
  });

  // Expose methods to parent
  useImperativeHandle(ref, () => ({
    setValue: (text: string) => {
      setContent(text);
    },
    focus: () => {
      textInputRef.current?.focus();
    },
  }));

  const handleSubmit = useCallback(() => {
    save({
      content,
      previewFile,
      uploadFile,
      setUploadProgress,
      clearPreview,
      setContent,
      setPreviewFile: (_file: PreviewFile | null) => {
        // Handled internally by the hook
      },
    });
  }, [content, previewFile, save, uploadFile, setUploadProgress, clearPreview]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter to save
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const hasContent = content.trim() || previewFile;

  return (
    <Card
      className={cn(
        "p-4 transition-all duration-300 relative",
        success && "ring-2 ring-primary/50 bg-primary/5",
        isDragging && "ring-2 ring-primary border-primary bg-primary/5",
        className
      )}
      {...dragHandlers}
    >
      <div className="space-y-3">
        {/* Drag overlay */}
        {isDragging && <DragOverlay />}

        {/* File preview */}
        {previewFile && (
          <FilePreview
            previewFile={previewFile}
            onRemove={clearPreview}
            disabled={isSaving}
          />
        )}

        {/* Text input */}
        <TextInput
          ref={textInputRef}
          value={content}
          onChange={setContent}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          previewFile={previewFile}
          isLoading={isSaving}
          uploadProgress={uploadProgress}
        />

        {/* Action bar */}
        <ActionBar
          hasContent={!!hasContent}
          isSaving={isSaving}
          success={success}
          isListening={isListening}
          onFileSelect={handleFileSelect}
          onVoiceToggle={toggleVoice}
          onSubmit={handleSubmit}
        />
      </div>
    </Card>
  );
});

DumpInput.displayName = "DumpInput";

export default DumpInput;

// Re-export types and handle
export type { DumpInputHandle, DumpInputProps } from "./types";
