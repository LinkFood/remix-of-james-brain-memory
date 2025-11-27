import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { getImportanceLabel, getImportanceColor } from "./ImportanceFilter";

interface Memory {
  id: string;
  role: string;
  content: string;
  topic: string | null;
  created_at: string;
  importance_score: number | null;
}

interface MemoryVaultProps {
  userId: string;
}

const ITEMS_PER_PAGE = 50;

const MemoryVault = ({ userId }: MemoryVaultProps) => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchMemories(true);
  }, []);

  const fetchMemories = async (reset: boolean = false) => {
    if (reset) {
      setLoading(true);
      setPage(0);
      setMemories([]);
      setHasMore(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const currentPage = reset ? 0 : page;
      const from = currentPage * ITEMS_PER_PAGE;
      const to = from + ITEMS_PER_PAGE - 1;

      const { data, error, count } = await supabase
        .from("messages")
        .select("*", { count: 'exact' })
        .eq("user_id", userId)
        .range(from, to)
        .order("created_at", { ascending: false });

      if (error) throw error;

      setMemories(reset ? (data || []) : [...memories, ...(data || [])]);
      setHasMore((data?.length || 0) === ITEMS_PER_PAGE);
      setPage(currentPage + 1);
    } catch (error: any) {
      toast.error("Failed to load memories");
      console.error(error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleLoadMore = () => {
    fetchMemories(false);
  };

  const filteredMemories = memories.filter(
    (m) =>
      m.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (m.topic && m.topic.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleExport = () => {
    const dataStr = JSON.stringify(memories, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `memory-vault-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success("Memory vault exported successfully");
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto text-center text-muted-foreground">
        <p>Loading your memories...</p>
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
            placeholder="Search your memories..."
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
        {filteredMemories.length === 0 ? (
          <Card className="col-span-full p-8 text-center bg-card border-border">
            <p className="text-muted-foreground">
              {searchQuery ? "No memories found matching your search" : "No memories yet. Start chatting to build your vault!"}
            </p>
          </Card>
        ) : (
          <>
            {filteredMemories.map((memory) => (
              <Card
                key={memory.id}
                className="p-4 bg-card border-border hover:border-primary/50 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded ${
                      memory.role === "user"
                        ? "bg-primary/20 text-primary"
                        : "bg-accent/20 text-accent"
                    }`}
                  >
                    {memory.role}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(memory.created_at).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm text-foreground leading-relaxed line-clamp-2 mb-3">
                  {memory.content}
                </p>
                {memory.importance_score !== null && (
                  <Badge variant="outline" className={getImportanceColor(memory.importance_score)}>
                    {memory.importance_score}
                  </Badge>
                )}
              </Card>
            ))}
          </>
        )}
      </div>

      {hasMore && filteredMemories.length > 0 && (
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
