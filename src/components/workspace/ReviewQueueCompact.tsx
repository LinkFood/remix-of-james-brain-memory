/**
 * ReviewQueueCompact — row 5 of Claude's State dashboard.
 *
 * Items created in the last 7 days with no corresponding ct_james_reviews row.
 * Single-click thumbs-up or thumbs-down. Optional inline note. Optimistic
 * removal on click — useReviewSubjectOptimistic handles the cache dance.
 *
 * Wave D sandbox semantics: ct_james_reviews are NEVER read by any
 * Claude-facing function. The thumbs-up is for James's own tracking only.
 */
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ThumbsUp, ThumbsDown, MessageSquare, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import {
  useReviewQueue,
  useReviewSubjectOptimistic,
  type ReviewQueueItem,
} from '@/hooks/useClaudeState';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function subjectBadgeClass(s: ReviewQueueItem['subjectType']): string {
  switch (s) {
    case 'trade': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
    case 'trade_idea': return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    case 'hypothesis': return 'bg-blue-500/15 text-blue-400 border-blue-500/40';
  }
}

function QueueRow({ item }: { item: ReviewQueueItem }) {
  const review = useReviewSubjectOptimistic();
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const submit = (thumb: 'up' | 'down') => {
    review.mutate(
      {
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        thumb,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(`Review saved (${thumb === 'up' ? '+' : '-'})`);
          setNote('');
          setNoteOpen(false);
        },
        onError: (e) => toast.error(`Review failed: ${(e as Error).message}`),
      },
    );
  };

  return (
    <Card className="p-2 space-y-1">
      <div className="flex items-start gap-2">
        <Badge
          variant="outline"
          className={`text-[9px] px-1 py-0 h-4 shrink-0 uppercase ${subjectBadgeClass(item.subjectType)}`}
        >
          {item.subjectType.replace('_', ' ')}
        </Badge>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium leading-snug line-clamp-1">{item.title}</div>
          <div className="text-[10px] text-muted-foreground leading-snug line-clamp-1">
            {item.detail}
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(item.createdAt)}</span>
      </div>

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-green-400 hover:text-green-300 hover:bg-green-500/10"
          disabled={review.isPending}
          onClick={() => submit('up')}
          title="Thumbs up"
        >
          <ThumbsUp className="w-3 h-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
          disabled={review.isPending}
          onClick={() => submit('down')}
          title="Thumbs down"
        >
          <ThumbsDown className="w-3 h-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground ml-auto"
          onClick={() => setNoteOpen((v) => !v)}
          title="Add note"
        >
          <MessageSquare className="w-3 h-3" />
        </Button>
      </div>
      {noteOpen && (
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note — sandboxed, Claude never reads"
          className="text-[10px] h-7"
        />
      )}
    </Card>
  );
}

export function ReviewQueueCompact() {
  const { data: items = [], isLoading } = useReviewQueue();

  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Inbox className="w-3 h-3" />
        <span>Review queue</span>
        <span className="ml-auto font-mono">{items.length}</span>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">loading...</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          Nothing awaiting review from the last 7 days. Thumbs are sandboxed — Claude never reads them.
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
          {items.map((item) => (
            <QueueRow
              key={`${item.subjectType}:${item.subjectId}`}
              item={item}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
