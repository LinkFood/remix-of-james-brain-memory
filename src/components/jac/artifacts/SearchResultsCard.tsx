/**
 * SearchResultsCard — Inline artifact for search results
 *
 * Shows top 3 brain search results with title, snippet, and relevance.
 * Each result is clickable — navigates to Brain Inspector with entry pre-selected.
 */

import { Search, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface SearchResult {
  id?: string;
  title?: string;
  content?: string;
  snippet?: string;
  content_type?: string;
  similarity?: number;
}

interface SearchResultsCardProps {
  output: Record<string, unknown>;
}

export function SearchResultsCard({ output }: SearchResultsCardProps) {
  const navigate = useNavigate();
  const results = Array.isArray(output.results) ? (output.results as SearchResult[]) : [];
  const query = output.query ? String(output.query) : null;

  if (results.length === 0) return null;

  const topResults = results.slice(0, 3);

  const handleResultClick = (result: SearchResult) => {
    if (result.id) {
      navigate(`/brain?entryId=${result.id}`);
    }
  };

  return (
    <div className="mt-2 p-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.03] max-w-[85%]">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
          <Search className="w-3.5 h-3.5 text-amber-500" />
        </div>
        <p className="text-xs font-medium text-foreground/80">
          {results.length} result{results.length !== 1 ? 's' : ''} found
          {query && <span className="text-muted-foreground ml-1">for "{query}"</span>}
        </p>
      </div>
      <div className="space-y-1.5">
        {topResults.map((result, i) => {
          const displayText = result.snippet || result.content;
          const isClickable = !!result.id;
          return (
            <button
              key={result.id || i}
              onClick={() => handleResultClick(result)}
              disabled={!isClickable}
              className={`flex items-start gap-2 p-2 rounded bg-muted/30 w-full text-left transition-colors ${
                isClickable ? 'cursor-pointer hover:bg-muted/50' : ''
              }`}
            >
              <span className="text-[10px] text-muted-foreground/50 mt-0.5 shrink-0">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">
                  {result.title || (displayText ? displayText.slice(0, 50) : 'Untitled')}
                </p>
                {displayText && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                    {displayText.slice(0, 120)}
                  </p>
                )}
              </div>
              {result.similarity != null && (
                <span className="text-[9px] text-amber-400/70 shrink-0">
                  {Math.round(result.similarity * 100)}%
                </span>
              )}
              {isClickable && (
                <ChevronRight className="w-3.5 h-3.5 text-amber-400/40 shrink-0 mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
      {results.length > 3 && (
        <p className="text-[10px] text-muted-foreground/50 mt-2">+{results.length - 3} more results</p>
      )}
    </div>
  );
}
