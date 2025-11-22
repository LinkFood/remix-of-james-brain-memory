import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, MessageSquare, Trash2, Edit2, Check, X, Download } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ConversationSidebarProps {
  userId: string;
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
}

const ConversationSidebar = ({
  userId,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
}: ConversationSidebarProps) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

  useEffect(() => {
    fetchConversations();
  }, [userId]);

  const fetchConversations = async () => {
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      if (error) throw error;
      setConversations(data || []);
    } catch (error: any) {
      toast.error("Failed to load conversations");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const { error } = await supabase.from("conversations").delete().eq("id", id);
      if (error) throw error;
      
      setConversations((prev) => prev.filter((c) => c.id !== id));
      toast.success("Conversation deleted");
      
      if (id === currentConversationId) {
        onNewConversation();
      }
    } catch (error: any) {
      toast.error("Failed to delete conversation");
      console.error(error);
    }
  };

  const startEdit = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditTitle(conv.title || "");
  };

  const cancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
    setEditTitle("");
  };

  const saveEdit = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!editTitle.trim()) {
      toast.error("Title cannot be empty");
      return;
    }

    try {
      const { error } = await supabase
        .from("conversations")
        .update({ title: editTitle.trim() })
        .eq("id", id);

      if (error) throw error;

      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: editTitle.trim() } : c))
      );
      setEditingId(null);
      setEditTitle("");
      toast.success("Conversation renamed");
    } catch (error: any) {
      toast.error("Failed to rename conversation");
      console.error(error);
    }
  };

  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const selectAll = () => {
    setSelectedIds(new Set(conversations.map(c => c.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const { error } = await supabase
        .from("conversations")
        .delete()
        .in("id", Array.from(selectedIds));

      if (error) throw error;

      setConversations(prev => prev.filter(c => !selectedIds.has(c.id)));
      toast.success(`Deleted ${selectedIds.size} conversation${selectedIds.size > 1 ? 's' : ''}`);
      
      if (currentConversationId && selectedIds.has(currentConversationId)) {
        onNewConversation();
      }
      
      clearSelection();
    } catch (error: any) {
      toast.error("Failed to delete conversations");
      console.error(error);
    }
  };

  const bulkExport = async () => {
    if (selectedIds.size === 0) return;

    try {
      const { data: messages, error } = await supabase
        .from("messages")
        .select("*")
        .in("conversation_id", Array.from(selectedIds))
        .order("created_at", { ascending: true });

      if (error) throw error;

      const selectedConvs = conversations.filter(c => selectedIds.has(c.id));
      
      const exportData = {
        conversations: selectedConvs,
        messages: messages || [],
        exported_at: new Date().toISOString(),
        count: {
          conversations: selectedConvs.length,
          messages: messages?.length || 0,
        }
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `conversations-export-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${selectedIds.size} conversation${selectedIds.size > 1 ? 's' : ''}`);
      clearSelection();
    } catch (error: any) {
      toast.error("Export failed");
      console.error(error);
    }
  };

  return (
    <div className="w-64 border-r border-border bg-card/30 flex flex-col">
      <div className="p-4 border-b border-border space-y-2">
        <Button
          onClick={onNewConversation}
          className="w-full bg-primary hover:bg-primary-glow text-primary-foreground shadow-glow"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
        
        {!selectionMode ? (
          <Button
            onClick={() => setSelectionMode(true)}
            variant="outline"
            className="w-full"
            disabled={conversations.length === 0}
          >
            Select Multiple
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button
                onClick={selectAll}
                variant="outline"
                size="sm"
                className="flex-1"
              >
                Select All
              </Button>
              <Button
                onClick={clearSelection}
                variant="outline"
                size="sm"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
            {selectedIds.size > 0 && (
              <div className="flex gap-2">
                <Button
                  onClick={bulkExport}
                  variant="outline"
                  size="sm"
                  className="flex-1"
                >
                  <Download className="w-3 h-3 mr-1" />
                  Export ({selectedIds.size})
                </Button>
                <Button
                  onClick={bulkDelete}
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Delete ({selectedIds.size})
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {loading ? (
            <div className="text-center text-muted-foreground p-4">Loading...</div>
          ) : conversations.length === 0 ? (
            <div className="text-center text-muted-foreground p-4 text-sm">
              No conversations yet
            </div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => {
                  if (selectionMode) {
                    toggleSelection(conv.id);
                  } else if (editingId !== conv.id) {
                    onSelectConversation(conv.id);
                  }
                }}
                className={cn(
                  "group flex items-center gap-2 p-3 rounded-lg cursor-pointer transition-all hover:bg-secondary/80",
                  currentConversationId === conv.id && "bg-secondary border border-primary/30",
                  selectedIds.has(conv.id) && "bg-primary/10 border border-primary"
                )}
              >
                {selectionMode && (
                  <Checkbox
                    checked={selectedIds.has(conv.id)}
                    onCheckedChange={() => toggleSelection(conv.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                {editingId === conv.id ? (
                  <div className="flex items-center gap-2 flex-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="h-8 text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit(e as any, conv.id);
                        if (e.key === "Escape") cancelEdit(e as any);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => saveEdit(e, conv.id)}
                    >
                      <Check className="w-4 h-4 text-green-600" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={cancelEdit}
                    >
                      <X className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <MessageSquare className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {conv.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(conv.updated_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => startEdit(e, conv)}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => handleDelete(e, conv.id)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default ConversationSidebar;
