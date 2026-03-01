/**
 * ThreadCard — Inline artifact for auto-saved conversation threads
 *
 * Shows when a research/code task gets auto-saved as a thread entry.
 * Clickable — navigates to Brain Inspector with entry pre-selected.
 */

import { Badge } from '@/components/ui/badge';
import { MessageSquare, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface ThreadCardProps {
  output: Record<string, unknown>;
}

export function ThreadCard({ output }: ThreadCardProps) {
  const navigate = useNavigate();
  const title = output.title ? String(output.title) : 'Saved thread';
  const tags = Array.isArray(output.tags) ? output.tags.map(String) : [];
  const entryId = output.threadEntryId || output.brainEntryId || output.entryId;
  const isClickable = !!entryId;
  const contentPreview = output.content ? String(output.content).slice(0, 120) : null;

  const handleClick = () => {
    if (entryId) {
      navigate(`/brain?entryId=${entryId}`);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={!isClickable}
      className={`mt-2 p-3 rounded-lg border border-teal-500/20 bg-teal-500/[0.03] max-w-[85%] w-full text-left transition-colors ${
        isClickable ? 'cursor-pointer hover:bg-teal-500/[0.06] hover:border-teal-500/30' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-full bg-teal-500/10 flex items-center justify-center shrink-0">
          <MessageSquare className="w-3.5 h-3.5 text-teal-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{title}</p>
            <Badge
              variant="secondary"
              className="text-[9px] shrink-0 bg-teal-500/10 text-teal-400"
            >
              thread
            </Badge>
          </div>
          {contentPreview && (
            <p className="text-[10px] text-muted-foreground/60 truncate mt-1">
              {contentPreview}
            </p>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {tags.slice(0, 4).map((tag) => (
                <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          )}
          {entryId && (
            <p className="text-[10px] text-muted-foreground/50 mt-1">
              ID: <code className="font-mono text-teal-400/60">{String(entryId).slice(0, 8)}</code>
            </p>
          )}
        </div>
        {isClickable && (
          <ChevronRight className="w-4 h-4 text-teal-400/40 shrink-0 mt-1" />
        )}
      </div>
    </button>
  );
}
