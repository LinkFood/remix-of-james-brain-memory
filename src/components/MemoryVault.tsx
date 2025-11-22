import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Download, BarChart3, Database, Clock } from "lucide-react";
import { toast } from "sonner";
import MemoryStats from "./MemoryStats";
import DateFilter from "./DateFilter";
import AdvancedFilters, { AdvancedFilterOptions } from "./AdvancedFilters";

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
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined } | null>(null);
  const [showingOnThisDay, setShowingOnThisDay] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedFilterOptions>({});

  useEffect(() => {
    fetchMemories();
  }, []);

  const fetchMemories = async (dateFilter?: { from: Date | undefined; to: Date | undefined } | null, onThisDay?: boolean, filters?: AdvancedFilterOptions) => {
    setLoading(true);
    try {
      let query = supabase
        .from("messages")
        .select("*")
        .eq("user_id", userId);

      // Apply advanced filters
      if (filters?.provider) {
        query = query.eq("provider", filters.provider);
      }
      if (filters?.model) {
        query = query.eq("model_used", filters.model);
      }

      if (onThisDay) {
        const now = new Date();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const day = now.getDate().toString().padStart(2, '0');
        
        // Filter by month and day across all years
        const { data, error } = await query;
        if (error) throw error;
        
        let filtered = data?.filter(msg => {
          const msgDate = new Date(msg.created_at);
          return msgDate.getMonth() + 1 === parseInt(month) && msgDate.getDate() === parseInt(day);
        }) || [];

        // Apply length filters
        if (filters?.minLength || filters?.maxLength) {
          filtered = filtered.filter(msg => {
            if (filters.minLength && msg.content.length < filters.minLength) return false;
            if (filters.maxLength && msg.content.length > filters.maxLength) return false;
            return true;
          });
        }
        
        setMemories(filtered);
        return;
      }

      if (dateFilter?.from) {
        query = query.gte("created_at", dateFilter.from.toISOString());
      }
      if (dateFilter?.to) {
        query = query.lte("created_at", dateFilter.to.toISOString());
      }

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;

      // Apply length filters
      let filteredData = data || [];
      if (filters?.minLength || filters?.maxLength) {
        filteredData = filteredData.filter(msg => {
          if (filters.minLength && msg.content.length < filters.minLength) return false;
          if (filters.maxLength && msg.content.length > filters.maxLength) return false;
          return true;
        });
      }

      setMemories(filteredData);
    } catch (error: any) {
      toast.error("Failed to load memories");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleOnThisDay = () => {
    setShowingOnThisDay(true);
    setDateRange(null);
    fetchMemories(null, true, advancedFilters);
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    toast.success(`Showing memories from ${dateStr} across all years`);
  };

  const handleDateChange = (range: { from: Date | undefined; to: Date | undefined } | null) => {
    setDateRange(range);
    setShowingOnThisDay(false);
    fetchMemories(range, false, advancedFilters);
  };

  const handleAdvancedFiltersChange = (filters: AdvancedFilterOptions) => {
    setAdvancedFilters(filters);
    fetchMemories(dateRange, showingOnThisDay, filters);
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
    <Tabs defaultValue="memories" className="w-full max-w-6xl mx-auto">
      <TabsList className="grid w-full max-w-md mx-auto grid-cols-2 bg-card border border-border mb-6">
        <TabsTrigger value="memories" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
          <Database className="w-4 h-4 mr-2" />
          Memories
        </TabsTrigger>
        <TabsTrigger value="analytics" className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
          <BarChart3 className="w-4 h-4 mr-2" />
          Analytics
        </TabsTrigger>
      </TabsList>

      <TabsContent value="memories" className="space-y-6 animate-fade-in">
        <div className="space-y-4">
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
            <div className="flex gap-2 flex-wrap">
              <DateFilter 
                onDateChange={handleDateChange}
                onThisDay={handleOnThisDay}
                showOnThisDay={true}
              />

              <AdvancedFilters
                onFilterChange={handleAdvancedFiltersChange}
                currentFilters={advancedFilters}
              />
            </div>

            {showingOnThisDay && (
              <p className="text-sm text-muted-foreground">
                Showing memories from {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} across all years
              </p>
            )}

            {dateRange?.from && !showingOnThisDay && (
              <p className="text-sm text-muted-foreground">
                Filtering from {dateRange.from.toLocaleDateString()} 
                {dateRange.to ? ` to ${dateRange.to.toLocaleDateString()}` : ''}
              </p>
            )}

            {Object.keys(advancedFilters).length > 0 && (
              <p className="text-sm text-muted-foreground">
                Active advanced filters: {Object.keys(advancedFilters).length}
              </p>
            )}
          </div>
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
      </TabsContent>

      <TabsContent value="analytics" className="animate-fade-in">
        <MemoryStats userId={userId} />
      </TabsContent>
    </Tabs>
  );
};

export default MemoryVault;
