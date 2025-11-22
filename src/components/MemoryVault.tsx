import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Download } from "lucide-react";
import { toast } from "sonner";

interface Memory {
  id: string;
  role: string;
  content: string;
  topic: string | null;
  created_at: string;
}

interface MemoryVaultProps {
  userId: string;
}

const MemoryVault = ({ userId }: MemoryVaultProps) => {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMemories();
  }, []);

  const fetchMemories = async () => {
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setMemories(data || []);
    } catch (error: any) {
      toast.error("Failed to load memories");
      console.error(error);
    } finally {
      setLoading(false);
    }
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
      <div className="max-w-4xl mx-auto text-center text-muted-foreground">
        <p>Loading your memories...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
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

      <div className="space-y-3">
        {filteredMemories.length === 0 ? (
          <Card className="p-8 text-center bg-card border-border">
            <p className="text-muted-foreground">
              {searchQuery ? "No memories found matching your search" : "No memories yet. Start chatting to build your vault!"}
            </p>
          </Card>
        ) : (
          filteredMemories.map((memory) => (
            <Card
              key={memory.id}
              className="p-4 bg-card border-border hover:border-primary/50 transition-all"
            >
              <div className="flex items-start justify-between mb-2">
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
                  {new Date(memory.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-sm text-foreground leading-relaxed">{memory.content}</p>
              {memory.topic && (
                <div className="mt-2 text-xs text-muted-foreground">
                  Topic: <span className="text-primary">{memory.topic}</span>
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
};

export default MemoryVault;
