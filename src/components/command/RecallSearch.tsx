/**
 * RecallSearch — search bar over Claude's memory (ct_embeddings).
 * Submits query to ct-recall, renders hits below with glance + grade badge.
 */
import { useState, type FormEvent } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useHistoricalRecall, type RecallHit } from '@/hooks/useCoTraderData';

export function RecallSearch() {
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState('');
  const { data, isFetching, error } = useHistoricalRecall(submitted);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(input.trim());
  }

  const hits = data?.hits ?? [];

  return (
    <Card className="p-3 space-y-3">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="search Claude's memory… e.g. 'every bearish NVDA flag that was wrong'"
          className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 h-8 px-0 text-sm bg-transparent"
        />
        {isFetching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground flex-shrink-0" />}
        {data && !isFetching && (
          <span className="text-[10px] text-muted-foreground flex-shrink-0">
            {hits.length} · {data.mode} · {data.duration_ms}ms
          </span>
        )}
      </form>

      {error && (
        <div className="text-xs text-red-400 px-1">
          {(error as Error).message}
        </div>
      )}

      {submitted && !isFetching && hits.length === 0 && !error && (
        <div className="text-xs text-muted-foreground px-1">
          no hits in corpus for "{submitted}"
        </div>
      )}

      {hits.length > 0 && (
        <div className="divide-y divide-border -mx-3 -mb-3 max-h-[50vh] overflow-y-auto">
          {hits.map((h) => <RecallRow key={`${h.type}:${h.id}`} hit={h} />)}
        </div>
      )}
    </Card>
  );
}

function RecallRow({ hit }: { hit: RecallHit }) {
  const verdictColor: Record<string, string> = {
    right: 'bg-green-500/15 text-green-400 border-green-500/30',
    partial: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    wrong: 'bg-red-500/15 text-red-400 border-red-500/30',
    ambiguous: 'bg-muted/50 text-muted-foreground border-muted',
  };

  const typeColor: Record<string, string> = {
    observation: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    flag: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    alert: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    news: 'bg-muted/40 text-muted-foreground border-muted',
    report: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
    james_view: 'bg-primary/15 text-primary border-primary/30',
  };

  const when = hit.timestamp ? new Date(hit.timestamp) : null;
  const whenStr = when ? when.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

  return (
    <div className="px-3 py-2 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${typeColor[hit.type] ?? ''}`}>
          {hit.type}
        </Badge>
        {hit.instruments.length > 0 && (
          <span className="font-mono text-xs font-semibold text-foreground">
            {hit.instruments.join('+')}
          </span>
        )}
        {hit.direction && (
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {hit.direction}
          </span>
        )}
        {hit.conviction != null && (
          <span className="text-[10px] text-muted-foreground">conv {hit.conviction}</span>
        )}
        {hit.grade && (
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${verdictColor[hit.grade.verdict] ?? ''}`}>
            {hit.grade.verdict}
            {hit.grade.actual_return_pct != null && ` ${hit.grade.actual_return_pct >= 0 ? '+' : ''}${hit.grade.actual_return_pct.toFixed(2)}%`}
          </Badge>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">{whenStr}</span>
        {hit.distance != null && (
          <span className="text-[10px] text-muted-foreground font-mono">d={hit.distance.toFixed(3)}</span>
        )}
      </div>
      {hit.glance && hit.glance.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground list-disc list-inside">
          {hit.glance.slice(0, 4).map((g, i) => (
            <li key={i} className="truncate">{g}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default RecallSearch;
