/**
 * BrainEntryCard — Inline artifact for save results
 *
 * Shows a compact card when JAC saves something to the brain.
 * Clickable — navigates to Brain Inspector with entry pre-selected.
 */

import { Badge } from '@/components/ui/badge';
import { Brain, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const TYPE_BADGES: Record<string, string> = {
  note: 'bg-blue-500/10 text-blue-400',
  idea: 'bg-violet-500/10 text-violet-400',
  link: 'bg-cyan-500/10 text-cyan-400',
  code: 'bg-indigo-500/10 text-indigo-400',
  contact: 'bg-emerald-500/10 text-emerald-400',
  event: 'bg-amber-500/10 text-amber-400',
  reminder: 'bg-red-500/10 text-red-400',
  list: 'bg-orange-500/10 text-orange-400',
  document: 'bg-slate-500/10 text-slate-400',
  image: 'bg-pink-500/10 text-pink-400',
};

interface BrainEntryCardProps {
  output: Record<string, unknown>;
}

export function BrainEntryCard({ output }: BrainEntryCardProps) {
  const navigate = useNavigate();
  const title = output.title ? String(output.title) : null;
  const contentType = output.content_type ? String(output.content_type) : 'note';
  const tags = Array.isArray(output.tags) ? output.tags.map(String) : [];
  const entryId = output.brainEntryId || output.entryId;
  const isClickable = !!entryId;

  const handleClick = () => {
    if (entryId) {
      navigate(`/brain?entryId=${entryId}`);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={!isClickable}
      className={`mt-2 p-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.03] max-w-[85%] w-full text-left transition-colors ${
        isClickable ? 'cursor-pointer hover:bg-violet-500/[0.06] hover:border-violet-500/30' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-full bg-violet-500/10 flex items-center justify-center shrink-0">
          <Brain className="w-3.5 h-3.5 text-violet-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium truncate">{title || 'Saved to brain'}</p>
            <Badge
              variant="secondary"
              className={`text-[9px] shrink-0 ${TYPE_BADGES[contentType] || 'bg-muted text-muted-foreground'}`}
            >
              {contentType}
            </Badge>
          </div>
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
              ID: <code className="font-mono text-violet-400/60">{String(entryId).slice(0, 8)}</code>
            </p>
          )}
        </div>
        {isClickable && (
          <ChevronRight className="w-4 h-4 text-violet-400/40 shrink-0 mt-1" />
        )}
      </div>
    </button>
  );
}
