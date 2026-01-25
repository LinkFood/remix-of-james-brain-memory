/**
 * SourceImage - Displays a thumbnail image from a chat source with signed URL support
 * 
 * Used in AssistantChat to show inline images when Jac finds entries with images.
 * Clicking opens the full entry modal.
 */

import { Expand, Loader2, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSignedUrl } from "@/hooks/use-signed-url";

interface SourceImageProps {
  imageUrl: string | null | undefined;
  title: string | null;
  onClick: () => void;
}

export function SourceImage({ imageUrl, title, onClick }: SourceImageProps) {
  const { signedUrl, loading, error } = useSignedUrl(imageUrl);

  // Don't render if no image URL
  if (!imageUrl) return null;

  // Show loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center w-[140px] h-[100px] bg-muted rounded-md border border-border">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Show error fallback
  if (error || !signedUrl) {
    return (
      <div 
        className="flex flex-col items-center justify-center w-[140px] h-[100px] bg-muted rounded-md border border-border cursor-pointer hover:bg-muted/80 transition-colors"
        onClick={onClick}
      >
        <ImageIcon className="w-5 h-5 text-muted-foreground mb-1" />
        <span className="text-xs text-muted-foreground">View image</span>
      </div>
    );
  }

  return (
    <div 
      className={cn(
        "relative group cursor-pointer rounded-md overflow-hidden border border-border",
        "max-w-[280px] transition-all hover:border-primary/50 hover:shadow-md"
      )}
      onClick={onClick}
    >
      <img 
        src={signedUrl}
        alt={title || 'Entry image'}
        className="w-full h-auto max-h-[200px] object-cover"
        loading="lazy"
        onError={(e) => {
          // Hide broken images
          e.currentTarget.style.display = 'none';
        }}
      />
      {/* Expand icon overlay on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
        <Expand className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
      </div>
      {/* Title label at bottom */}
      {title && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
          <span className="text-xs text-white font-medium line-clamp-1">{title}</span>
        </div>
      )}
    </div>
  );
}
