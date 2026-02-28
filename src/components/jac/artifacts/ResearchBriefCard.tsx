/**
 * ResearchBriefCard — Inline artifact for research results
 *
 * Shows a collapsible summary with source count and expand toggle.
 */

import { useState } from 'react';
import { Globe, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Source {
  title?: string;
  url?: string;
}

interface ResearchBriefCardProps {
  output: Record<string, unknown>;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function ResearchBriefCard({ output }: ResearchBriefCardProps) {
  const [expanded, setExpanded] = useState(false);

  const brief = output.brief ? String(output.brief) : null;
  const answer = output.answer ? String(output.answer) : null;
  const content = brief || answer;
  const sources = Array.isArray(output.sources) ? (output.sources as Source[]) : [];
  const safeSources = sources.filter(s => s.url && isSafeUrl(s.url));

  if (!content) return null;

  const isLong = content.length > 200;
  const displayContent = expanded || !isLong ? content : content.slice(0, 200) + '...';

  return (
    <div className="mt-2 p-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.03] max-w-[85%]">
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
          <Globe className="w-3.5 h-3.5 text-blue-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-foreground/80">Research Brief</p>
            {safeSources.length > 0 && (
              <span className="text-[10px] text-muted-foreground">{safeSources.length} source{safeSources.length !== 1 ? 's' : ''}</span>
            )}
          </div>

          <p className="text-xs text-foreground/70 mt-1.5 whitespace-pre-wrap leading-relaxed">
            {displayContent}
          </p>

          {isLong && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 text-[10px] text-muted-foreground hover:text-foreground mt-1 px-1 -ml-1"
              onClick={() => setExpanded(prev => !prev)}
            >
              {expanded ? (
                <><ChevronUp className="w-3 h-3 mr-0.5" /> Less</>
              ) : (
                <><ChevronDown className="w-3 h-3 mr-0.5" /> Read full</>
              )}
            </Button>
          )}

          {/* Sources */}
          {expanded && safeSources.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border/50 space-y-1">
              {safeSources.slice(0, 5).map((s, i) => (
                <a
                  key={i}
                  href={s.url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[10px] text-primary hover:underline truncate"
                >
                  <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                  {s.title || s.url}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
