import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { parseListItems } from "@/lib/parseListItems";

interface Entry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  tags: string[];
  importance_score: number | null;
  created_at: string;
}

interface MemoryVaultProps {
  userId: string;
}

const ITEMS_PER_PAGE = 50;

const getImportanceColor = (score: number): string => {
  if (score >= 8) return "text-red-500 border-red-500/30";
  if (score >= 6) return "text-orange-500 border-orange-500/30";
  if (score >= 4) return "text-yellow-500 border-yellow-500/30";
  return "text-muted-foreground";
};

const MemoryVault = ({ userId }: MemoryVaultProps) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchEntries(true);
  }, []);

  const fetchEntries = async (reset: boolean = false) => {
    if (reset) {
      setLoading(true);
      setPage(0);
      setEntries([]);
      setHasMore(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const currentPage = reset ? 0 : page;
      const from = currentPage * ITEMS_PER_PAGE;
      const to = from + ITEMS_PER_PAGE - 1;

      const { data, error } = await supabase
        .from("entries")
        .select("id, title, content, content_type, tags, importance_score, created_at")
        .eq("user_id", userId)
        .eq("archived", false)
        .range(from, to)
        .order("created_at", { ascending: false });

      if (error) throw error;

      setEntries(reset ? (data || []) : [...entries, ...(data || [])]);
      setHasMore((data?.length || 0) === ITEMS_PER_PAGE);
      setPage(currentPage + 1);
    } catch (error: any) {
      toast.error("Failed to load entries");
      console.error(error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleLoadMore = () => {
    fetchEntries(false);
  };

  const filteredEntries = entries.filter(
    (e) =>
      e.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (e.title && e.title.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleExport = () => {
    const dataStr = JSON.stringify(entries, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `brain-dump-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success("Brain dump exported successfully");
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto text-center text-muted-foreground">
        <p>Loading your brain...</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto space-y-6">
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search your brain..."
            className="pl-10 bg-input border-border focus:ring-primary"
          />
        </div>
        <Button
          onClick={handleExport}
          className="bg-secondary hover:bg-secondary/80 text-secondary-foreground"
        >
          <Download className="w-4 h-4 mr-2" />
          Export
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filteredEntries.length === 0 ? (
          <Card className="col-span-full p-8 text-center bg-card border-border">
            <p className="text-muted-foreground">
              {searchQuery ? "No entries found matching your search" : "No entries yet. Start dumping to build your brain!"}
            </p>
          </Card>
        ) : (
          <>
            {filteredEntries.map((entry) => (
              <Card
                key={entry.id}
                className="p-4 bg-card border-border hover:border-primary/50 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-medium text-foreground line-clamp-1">
                      {entry.title || "Untitled"}
                    </h3>
                    <span className="text-xs text-muted-foreground capitalize">
                      {entry.content_type}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(entry.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm text-foreground leading-relaxed line-clamp-2 mb-3">
                  {entry.content}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {entry.importance_score !== null && (
                    <Badge variant="outline" className={getImportanceColor(entry.importance_score)}>
                      {entry.importance_score}/10
                    </Badge>
                  )}
                  {entry.tags?.slice(0, 2).map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </Card>
            ))}
          </>
        )}
      </div>

      {hasMore && filteredEntries.length > 0 && (
        <div className="flex justify-center pt-4">
          <Button
            onClick={handleLoadMore}
            disabled={loadingMore}
            variant="outline"
            className="w-full max-w-md"
          >
            {loadingMore ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Loading more...
              </>
            ) : (
              <>Load More</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
};

export default MemoryVault;
