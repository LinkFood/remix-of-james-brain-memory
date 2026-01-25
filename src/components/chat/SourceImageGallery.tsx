/**
 * SourceImageGallery - Renders a gallery of images from chat sources
 * 
 * Shows up to 4 thumbnails inline, with a "+X more" indicator if there are additional images.
 * Each image is clickable to open the full entry modal.
 */

import { ImageIcon } from "lucide-react";
import { SourceImage } from "./SourceImage";

interface Source {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  content_subtype?: string | null;
  tags: string[];
  importance_score?: number | null;
  created_at: string;
  event_date?: string | null;
  event_time?: string | null;
  list_items?: Array<{ text: string; checked: boolean }>;
  image_url?: string | null;
  similarity?: number;
}

interface SourceImageGalleryProps {
  sources: Source[];
  userId: string;
  onViewEntry?: (entry: any) => void;
}

export function SourceImageGallery({ sources, userId, onViewEntry }: SourceImageGalleryProps) {
  // Filter sources that have images
  const sourcesWithImages = sources.filter(s => s.image_url);
  
  if (sourcesWithImages.length === 0) return null;

  const handleImageClick = (source: Source) => {
    if (!onViewEntry || !source.content) return;
    
    // Convert source to Entry format for the modal
    const entryFromSource = {
      id: source.id,
      user_id: userId,
      content: source.content,
      title: source.title,
      content_type: source.content_type,
      content_subtype: source.content_subtype || null,
      tags: source.tags || [],
      extracted_data: {},
      importance_score: source.importance_score ?? null,
      list_items: source.list_items || [],
      source: 'manual',
      starred: false,
      archived: false,
      event_date: source.event_date || null,
      event_time: source.event_time || null,
      image_url: source.image_url || null,
      created_at: source.created_at,
      updated_at: source.created_at,
    };
    onViewEntry(entryFromSource);
  };

  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 mb-2">
        <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Images ({sourcesWithImages.length}):
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {sourcesWithImages.slice(0, 4).map((source) => (
          <SourceImage
            key={source.id}
            imageUrl={source.image_url}
            title={source.title}
            onClick={() => handleImageClick(source)}
          />
        ))}
        {sourcesWithImages.length > 4 && (
          <div className="flex items-center justify-center w-[100px] h-[100px] bg-muted rounded-md border border-border text-muted-foreground">
            <span className="text-sm font-medium">+{sourcesWithImages.length - 4} more</span>
          </div>
        )}
      </div>
    </div>
  );
}
