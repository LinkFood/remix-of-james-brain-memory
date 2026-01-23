/**
 * FilePreview - Image and PDF preview component
 */

import { Button } from "@/components/ui/button";
import { X, FileText } from "lucide-react";
import type { PreviewFile } from "./types";

interface FilePreviewProps {
  previewFile: PreviewFile;
  onRemove: () => void;
  disabled?: boolean;
}

export function FilePreview({ previewFile, onRemove, disabled }: FilePreviewProps) {
  // Image preview
  if (!previewFile.isPdf) {
    return (
      <div className="relative inline-block">
        <img 
          src={previewFile.url} 
          alt="Preview" 
          className="max-h-32 rounded-lg border border-border"
        />
        <Button
          variant="destructive"
          size="icon"
          className="absolute -top-2 -right-2 w-6 h-6"
          onClick={onRemove}
          disabled={disabled}
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    );
  }

  // PDF preview
  return (
    <div className="relative inline-flex items-center gap-3 p-3 bg-muted rounded-lg border border-border">
      <FileText className="w-8 h-8 text-red-500 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium text-sm truncate max-w-[200px]">{previewFile.file.name}</p>
        <p className="text-xs text-muted-foreground">
          {(previewFile.file.size / 1024 / 1024).toFixed(2)} MB
        </p>
      </div>
      <Button
        variant="destructive"
        size="icon"
        className="w-6 h-6 shrink-0"
        onClick={onRemove}
        disabled={disabled}
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  );
}
