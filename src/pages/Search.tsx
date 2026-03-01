/**
 * Search page — Global semantic + keyword search across entries and reflections.
 */

import { useState, useCallback, type FormEvent } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Search as SearchIcon,
  Loader2,
  FileText,
  Brain,
  X,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useSearchPage, type SearchPageFilters, type SearchPageResult } from '@/hooks/useSearchPage';
import { cn } from '@/lib/utils';

// --- Category badge colors ---
const TYPE_COLORS: Record<string, string> = {
  reminder: 'bg-amber-500/20 text-amber-400',
  event: 'bg-blue-500/20 text-blue-400',
  note: 'bg-white/10 text-white/50',
  idea: 'bg-purple-500/20 text-purple-400',
  link: 'bg-cyan-500/20 text-cyan-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  contact: 'bg-emerald-500/20 text-emerald-400',
  list: 'bg-orange-500/20 text-orange-400',
  document: 'bg-rose-500/20 text-rose-400',
  image: 'bg-pink-500/20 text-pink-400',
  research: 'bg-cyan-500/20 text-cyan-400',
  save: 'bg-emerald-500/20 text-emerald-400',
  search: 'bg-blue-500/20 text-blue-400',
  general: 'bg-white/10 text-white/50',
  reflection: 'bg-violet-500/20 text-violet-400',
};

const CONTENT_TYPES = ['reminder', 'event', 'note', 'idea', 'link', 'code', 'contact', 'list', 'document', 'image'];
const SOURCE_OPTIONS = [
  { value: 'all' as const, label: 'All' },
  { value: 'entries' as const, label: 'Entries' },
  { value: 'reflections' as const, label: 'Reflections' },
];

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM d, yyyy');
  } catch {
    return dateStr;
  }
}

function similarityPercent(sim: number | undefined): string | null {
  if (sim == null) return null;
  return `${Math.round(sim * 100)}%`;
}

// --- Single result row ---
function ResultItem({ result }: { result: SearchPageResult }) {
  const typeStyle = TYPE_COLORS[result.content_type] ?? 'bg-white/10 text-white/50';
  const simPct = similarityPercent(result.similarity);
  const snippet = result.content.slice(0, 200);

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors border-b border-white/5">
      {/* Relevance score */}
      <div className="shrink-0 w-12 text-right pt-0.5">
        {simPct ? (
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-xs font-mono text-emerald-400">{simPct}</span>
            <div className="w-8 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-emerald-400 rounded-full"
                style={{ width: simPct }}
              />
            </div>
          </div>
        ) : (
          <span className="text-[10px] text-white/20">--</span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-white/90 truncate">
            {result.title || snippet.slice(0, 60) || 'Untitled'}
          </span>
        </div>
        <p className="text-xs text-white/40 line-clamp-2">{snippet}</p>
        {result.tags.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {result.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-white/30">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Meta column */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        <div className="flex items-center gap-1.5">
          {result.source === 'reflection' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 font-medium flex items-center gap-0.5">
              <Brain className="w-2.5 h-2.5" />
              reflection
            </span>
          )}
          <span
            className={cn(
              'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
              typeStyle
            )}
          >
            {result.content_type}
          </span>
        </div>
        <span className="text-[10px] text-white/30">{formatDate(result.created_at)}</span>
      </div>
    </div>
  );
}

// --- Main page ---
const Search = () => {
  const { results, isSearching, error, hasSearched, search } = useSearchPage();
  const [query, setQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<SearchPageFilters>({});

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (query.trim()) {
        search(query, filters);
      }
    },
    [query, filters, search]
  );

  const clearQuery = useCallback(() => {
    setQuery('');
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-black">
      {/* Search header */}
      <div className="px-6 py-6 border-b border-white/10">
        <div className="max-w-3xl mx-auto">
          <form onSubmit={handleSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your brain..."
                className="pl-10 pr-8 h-12 bg-white/5 border-white/10 text-white placeholder:text-white/30 text-base"
                autoFocus
              />
              {query && (
                <button
                  type="button"
                  onClick={clearQuery}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <Button
              type="submit"
              disabled={isSearching || !query.trim()}
              className="h-12 px-6"
            >
              {isSearching ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  Search
                </span>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-12 border-white/10 text-white/50 hover:text-white/80"
              onClick={() => setShowFilters(!showFilters)}
            >
              <SlidersHorizontal className="w-4 h-4" />
            </Button>
          </form>

          {/* Filters panel */}
          {showFilters && (
            <div className="mt-3 p-3 rounded-lg border border-white/10 bg-white/[0.03] flex flex-wrap gap-3 items-center">
              {/* Source filter */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-white/40 uppercase tracking-wider mr-1">Source</span>
                {SOURCE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        sourceType: opt.value === 'all' ? undefined : opt.value,
                      }))
                    }
                    className={cn(
                      'text-[10px] px-2 py-1 rounded transition-colors',
                      (!filters.sourceType && opt.value === 'all') || filters.sourceType === opt.value
                        ? 'bg-white/10 text-white/80'
                        : 'text-white/30 hover:text-white/50'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* Type filter */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[10px] text-white/40 uppercase tracking-wider mr-1">Type</span>
                <button
                  onClick={() => setFilters((f) => ({ ...f, contentType: undefined }))}
                  className={cn(
                    'text-[10px] px-2 py-1 rounded transition-colors',
                    !filters.contentType ? 'bg-white/10 text-white/80' : 'text-white/30 hover:text-white/50'
                  )}
                >
                  All
                </button>
                {CONTENT_TYPES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setFilters((f) => ({ ...f, contentType: t }))}
                    className={cn(
                      'text-[10px] px-2 py-1 rounded transition-colors',
                      filters.contentType === t ? 'bg-white/10 text-white/80' : 'text-white/30 hover:text-white/50'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Results area */}
      <div className="max-w-3xl mx-auto">
        {isSearching ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <span className="text-sm text-red-400">{error}</span>
          </div>
        ) : hasSearched && results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-white/30">
            <FileText className="w-8 h-8" />
            <span className="text-sm">No results found</span>
          </div>
        ) : hasSearched ? (
          <>
            {/* Results header */}
            <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
              <span className="text-xs text-white/40">
                {results.length} result{results.length !== 1 ? 's' : ''}
              </span>
              <span className="text-[10px] text-white/20">
                {results.filter((r) => r.similarity != null).length} semantic matches
              </span>
            </div>

            {/* Results list */}
            <div>
              {results.map((result) => (
                <ResultItem key={`${result.source}-${result.id}`} result={result} />
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 gap-2 text-white/20">
            <SearchIcon className="w-8 h-8" />
            <span className="text-sm">Search across all your entries and reflections</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default Search;
