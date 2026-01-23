/**
 * DragOverlay - Visual feedback when dragging files
 */

import { Upload } from "lucide-react";

export function DragOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-primary/10 backdrop-blur-sm rounded-lg z-10 pointer-events-none">
      <div className="flex flex-col items-center gap-2 text-primary">
        <Upload className="w-8 h-8 animate-bounce" />
        <span className="font-medium">Drop image or PDF here</span>
      </div>
    </div>
  );
}
