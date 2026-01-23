import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

interface SearchResult {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  tags: string[];
  importance_score: number | null;
  created_at: string;
  similarity?: number;
}

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

const GlobalSearch = ({ userId, onSelectEntry, open: externalOpen, onOpenChange }: GlobalSearchProps) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = externalOpen !== undefined ? externalOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [useSemanticSearch, setUseSemanticSearch] = useState(true);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("search-memory", {
        body: { 
          query: query.trim(), 
          userId,
          useSemanticSearch,
          limit: 50
        },
      });

      if (error) throw error;
      setResults(data.results || []);
      
      if (data.total === 0) {
        toast.info("No results found");
      } else {
        const searchType = useSemanticSearch ? "semantic" : "keyword";
        toast.success(`Found ${data.total} entries using ${searchType} search`);
      }
    } catch (error: any) {
      toast.error("Search failed");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectResult = (result: SearchResult) => {
    onSelectEntry(result);
    setOpen(false);
    setQuery("");
    setResults([]);
  };

  // If controlled externally, don't render trigger
  if (externalOpen !== undefined) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col bg-card border-border">
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
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder={useSemanticSearch 
                  ? "e.g., 'What did I save about groceries?'" 
                  : "e.g., 'milk' or 'project ideas'"}
                className="bg-input border-border flex-1"
                autoFocus
              />
              <Button
                onClick={handleSearch}
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
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-border hover:bg-secondary">
          <Search className="w-4 h-4 mr-2" />
          Search Brain
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col bg-card border-border">
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
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder={useSemanticSearch 
                ? "e.g., 'What did I save about groceries?'" 
                : "e.g., 'milk' or 'project ideas'"}
              className="bg-input border-border flex-1"
            />
            <Button
              onClick={handleSearch}
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
      </DialogContent>
    </Dialog>
  );
};

export default GlobalSearch;
