/**
 * WebSourceCard - Displays a clickable web source citation from Jac's responses
 * 
 * Shows title, domain, and snippet in a compact card format.
 * Handles malformed URLs gracefully.
 */

import { ExternalLink, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
  publishedDate?: string;
}

interface WebSourceCardProps {
  source: WebSource;
}

/**
 * Safely extract hostname from URL
 */
function getHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown source';
  }
}

/**
 * Truncate text to a max length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + '…';
}

export function WebSourceCard({ source }: WebSourceCardProps) {
  const hostname = getHostname(source.url);
  const isValidUrl = (() => {
    try {
      new URL(source.url);
      return true;
    } catch {
      return false;
    }
  })();

  const cardContent = (
    <div
      className={cn(
        "group flex items-start gap-2.5 p-2.5 rounded-md border border-border/60 bg-muted/30",
        "transition-colors hover:bg-muted/50 hover:border-primary/40",
        isValidUrl && "cursor-pointer"
      )}
      onClick={() => {
        if (isValidUrl) {
          window.open(source.url, '_blank', 'noopener,noreferrer');
        }
      }}
    >
      {/* Globe icon / favicon placeholder */}
      <div className="shrink-0 mt-0.5 p-1.5 rounded bg-muted">
        <Globe className="w-3.5 h-3.5 text-muted-foreground" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-foreground line-clamp-1 group-hover:text-primary transition-colors">
            {source.title || hostname}
          </p>
          {isValidUrl && (
            <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {hostname}
        </p>
        {source.snippet && (
          <p className="text-xs text-muted-foreground/80 line-clamp-2 mt-0.5">
            {truncate(source.snippet, 150)}
          </p>
        )}
      </div>
    </div>
  );

  // Wrap in tooltip if snippet is long
  if (source.snippet && source.snippet.length > 150) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {cardContent}
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm">
          <p className="text-xs">{source.snippet}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return cardContent;
}
