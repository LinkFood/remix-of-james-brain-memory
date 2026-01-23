/**
 * GlobalSearch - Brain search dialog with semantic/keyword toggle
 * 
 * Uses the centralized useSearch hook for debounced searching.
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Search, Loader2, FileText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSearch, type SearchResult } from "@/hooks/useSearch";

interface GlobalSearchProps {
  userId: string;
  onSelectEntry: (entry: SearchResult) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const getImportanceColor = (score: number): string => {
  if (score >= 8) return "text-red-500 border-red-500/30";
  if (score >= 6) return "text-orange-500 border-orange-500/30";
  if (score >= 4) return "text-yellow-500 border-yellow-500/30";
  return "text-muted-foreground";
};

const GlobalSearch = ({ userId, onSelectEntry, open, onOpenChange }: GlobalSearchProps) => {
  const {
    query,
    setQuery,
    results,
    loading,
    useSemanticSearch,
    setUseSemanticSearch,
    search,
    clearResults,
  } = useSearch({ 
    userId, 
    debounceMs: 300,
    autoSearch: false, // Manual search on Enter/button click
  });

  // Clear results when dialog closes
  useEffect(() => {
    if (!open) {
      clearResults();
    }
  }, [open, clearResults]);

  const handleSelectResult = (result: SearchResult) => {
    onSelectEntry(result);
    onOpenChange?.(false);
    clearResults();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      search();
    }
  };

  // Search content component (shared between controlled and uncontrolled modes)
  const SearchContent = ({ autoFocus = false }: { autoFocus?: boolean }) => (
    <>
      <DialogHeader>
        <DialogTitle>Search Your Brain</DialogTitle>
        <DialogDescription>
          Search across all your entries using AI-powered semantic search
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-4 pb-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Switch 
            id="semantic-search" 
            checked={useSemanticSearch}
            onCheckedChange={setUseSemanticSearch}
          />
          <Label htmlFor="semantic-search" className="flex items-center gap-2 cursor-pointer">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm">Semantic Search</span>
          </Label>
        </div>
        <span className="text-xs text-muted-foreground">
          {useSemanticSearch 
            ? "AI understands meaning and context" 
            : "Exact keyword matching"}
        </span>
      </div>

      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={useSemanticSearch 
              ? "e.g., 'What did I save about groceries?'" 
              : "e.g., 'milk' or 'project ideas'"}
            className="bg-input border-border flex-1"
            autoFocus={autoFocus}
          />
          <Button
            onClick={search}
            disabled={loading || !query.trim()}
            className="bg-primary hover:bg-primary-glow text-primary-foreground"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 mt-4">
        {results.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            {query ? "No results found" : "Enter a search query to find your memories"}
          </div>
        ) : (
          results.map((result) => (
            <Card
              key={result.id}
              className="p-4 bg-card border-border hover:border-primary/50 transition-all cursor-pointer"
              onClick={() => handleSelectResult(result)}
            >
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-4 h-4 text-primary" />
                <h3 className="font-semibold text-foreground">{result.title || "Untitled"}</h3>
                <Badge variant="outline" className="ml-auto text-xs capitalize">
                  {result.content_type}
                </Badge>
                {result.similarity && (
                  <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                    {Math.round(result.similarity * 100)}% match
                  </span>
                )}
              </div>
              <p className="text-sm text-foreground line-clamp-2 mb-2">{result.content}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs text-muted-foreground">
                  {new Date(result.created_at).toLocaleDateString()}
                </p>
                {result.importance_score !== null && result.importance_score !== undefined && (
                  <Badge variant="outline" className={`text-xs ${getImportanceColor(result.importance_score)}`}>
                    {result.importance_score}/10
                  </Badge>
                )}
                {result.tags?.slice(0, 3).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </Card>
          ))
        )}
      </div>
    </>
  );

  // Controlled mode (open/onOpenChange provided externally)
  if (open !== undefined && onOpenChange) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col bg-card border-border">
          <SearchContent autoFocus />
        </DialogContent>
      </Dialog>
    );
  }

  // Uncontrolled mode with trigger button
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-border hover:bg-secondary">
          <Search className="w-4 h-4 mr-2" />
          Search Brain
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col bg-card border-border">
        <SearchContent />
      </DialogContent>
    </Dialog>
  );
};

export default GlobalSearch;
