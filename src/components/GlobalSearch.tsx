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
import { Search, Loader2, MessageSquare, Sparkles } from "lucide-react";
import { toast } from "sonner";
import DateFilter from "./DateFilter";
import AdvancedFilters, { AdvancedFilterOptions } from "./AdvancedFilters";
import { Badge } from "@/components/ui/badge";
import { getImportanceLabel, getImportanceColor } from "./ImportanceFilter";

interface SearchResult {
  conversation_id: string;
  conversation_title: string;
  similarity?: number;
  messages: {
    id: string;
    role: string;
    content: string;
    topic: string | null;
    created_at: string;
    similarity?: number;
    importance_score?: number | null;
  }[];
}

interface GlobalSearchProps {
  userId: string;
  onSelectConversation: (id: string) => void;
}

const GlobalSearch = ({ userId, onSelectConversation }: GlobalSearchProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [useSemanticSearch, setUseSemanticSearch] = useState(true);
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined } | null>(null);
  const [isOnThisDay, setIsOnThisDay] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterOptions>({});

  const handleSearch = async () => {
    if (!query.trim()) return;

    setLoading(true);
    setIsOnThisDay(false);
    try {
      const body: any = { 
        query: query.trim(), 
        userId,
        useSemanticSearch,
        ...advancedFilters
      };

      if (dateRange?.from) {
        body.startDate = dateRange.from.toISOString();
      }
      if (dateRange?.to) {
        body.endDate = dateRange.to.toISOString();
      }

      const { data, error } = await supabase.functions.invoke("search-memory", {
        body,
      });

      if (error) throw error;
      setResults(data.results || []);
      
      if (data.total === 0) {
        toast.info("No results found");
      } else {
        const searchType = useSemanticSearch ? "semantic" : "keyword";
        const dateInfo = dateRange?.from ? " in selected date range" : "";
        toast.success(`Found ${data.total} matching messages using ${searchType} search${dateInfo}`);
      }
    } catch (error: any) {
      toast.error("Search failed");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleOnThisDay = async () => {
    if (!query.trim()) {
      toast.error("Please enter a search query first");
      return;
    }

    setLoading(true);
    setIsOnThisDay(true);
    try {
      const { data, error } = await supabase.functions.invoke("search-memory", {
        body: { 
          query: query.trim(), 
          userId,
          useSemanticSearch,
          onThisDay: true,
          ...advancedFilters
        },
      });

      if (error) throw error;
      setResults(data.results || []);
      
      const today = new Date();
      const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
      
      if (data.total === 0) {
        toast.info(`No memories found from ${dateStr} in past years`);
      } else {
        toast.success(`Found ${data.total} memories from ${dateStr} across all years`);
      }
    } catch (error: any) {
      toast.error("Search failed");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectResult = (conversationId: string) => {
    onSelectConversation(conversationId);
    setOpen(false);
    setQuery("");
    setResults([]);
    setDateRange(null);
    setIsOnThisDay(false);
    setAdvancedFilters({});
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-border hover:bg-secondary">
          <Search className="w-4 h-4 mr-2" />
          Search All Memories
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col bg-card border-border">
        <DialogHeader>
          <DialogTitle>Search Your Memory Vault</DialogTitle>
          <DialogDescription>
            Search across all your conversations using AI-powered semantic search or keyword matching
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
                ? "e.g., 'What did I say about crypto last month?'" 
                : "e.g., 'bitcoin' or 'investment'"}
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

          <div className="flex gap-2 flex-wrap">
            <DateFilter 
              onDateChange={setDateRange}
              onThisDay={handleOnThisDay}
              showOnThisDay={true}
            />
            
            <AdvancedFilters
              onFilterChange={setAdvancedFilters}
              currentFilters={advancedFilters}
            />
          </div>

          {isOnThisDay && (
            <p className="text-xs text-muted-foreground">
              Showing memories from {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} across all years
            </p>
          )}

          {dateRange?.from && !isOnThisDay && (
            <p className="text-xs text-muted-foreground">
              Filtering from {dateRange.from.toLocaleDateString()} 
              {dateRange.to ? ` to ${dateRange.to.toLocaleDateString()}` : ''}
            </p>
          )}

          {Object.keys(advancedFilters).length > 0 && (
            <p className="text-xs text-muted-foreground">
              Active filters: {Object.keys(advancedFilters).length}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 mt-4">
          {results.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              {query ? "No results found" : "Enter a search query to find your memories"}
            </div>
          ) : (
            results.map((result) => (
              <Card
                key={result.conversation_id}
                className="p-4 bg-card border-border hover:border-primary/50 transition-all cursor-pointer"
                onClick={() => handleSelectResult(result.conversation_id)}
              >
                <div className="flex items-center gap-2 mb-3">
                  <MessageSquare className="w-4 h-4 text-primary" />
                  <h3 className="font-semibold text-foreground">{result.conversation_title}</h3>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {result.messages.length} message{result.messages.length !== 1 ? "s" : ""}
                  </span>
                  {result.messages[0]?.similarity && (
                    <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                      {Math.round(result.messages[0].similarity * 100)}% match
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {result.messages.slice(0, 3).map((msg) => (
                    <div key={msg.id} className="text-sm border-l-2 border-primary/30 pl-3">
                      <p className="text-foreground line-clamp-2">{msg.content}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <p className="text-xs text-muted-foreground">
                          {new Date(msg.created_at).toLocaleDateString()}
                        </p>
                        {msg.similarity && (
                          <span className="text-xs text-primary">
                            {Math.round(msg.similarity * 100)}% relevant
                          </span>
                        )}
                        {msg.importance_score !== null && msg.importance_score !== undefined && (
                          <Badge variant="outline" className={`text-xs ${getImportanceColor(msg.importance_score)}`}>
                            {msg.importance_score} - {getImportanceLabel(msg.importance_score)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                  {result.messages.length > 3 && (
                    <p className="text-xs text-muted-foreground pl-3">
                      +{result.messages.length - 3} more messages
                    </p>
                  )}
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
