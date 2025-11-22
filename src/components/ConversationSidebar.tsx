import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Edit2, Trash2, Check, X, Pin, Archive, Tag, MoreVertical, ChevronLeft, Download } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  archived: boolean;
  tags: string[];
}

interface ConversationSidebarProps {
  userId: string;
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const ConversationSidebar = ({ 
  userId, 
  currentConversationId, 
  onSelectConversation, 
  onNewConversation,
  collapsed = false,
  onToggleCollapse
}: ConversationSidebarProps) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [addingTagToId, setAddingTagToId] = useState<string | null>(null);

  // Batch operations
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchConversations();
  }, [userId]);

  const fetchConversations = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("*")
        .eq("user_id", userId)
        .order("pinned", { ascending: false })
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

  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      const { error } = await supabase
        .from("conversations")
        .update({ pinned: !pinned })
        .eq("id", id);

      if (error) throw error;
      fetchConversations();
      toast.success(pinned ? "Unpinned" : "Pinned");
    } catch (error) {
      toast.error("Failed to update");
    }
  };

  const handleToggleArchive = async (id: string, archived: boolean) => {
    try {
      const { error } = await supabase
        .from("conversations")
        .update({ archived: !archived })
        .eq("id", id);

      if (error) throw error;
      fetchConversations();
      toast.success(archived ? "Unarchived" : "Archived");
    } catch (error) {
      toast.error("Failed to archive");
    }
  };

  const handleAddTag = async (id: string, tag: string) => {
    if (!tag.trim()) return;
    
    try {
      const conversation = conversations.find(c => c.id === id);
      if (!conversation) return;

      const updatedTags = [...new Set([...conversation.tags, tag.trim()])];
      
      const { error } = await supabase
        .from("conversations")
        .update({ tags: updatedTags })
        .eq("id", id);

      if (error) throw error;
      fetchConversations();
      setNewTag("");
      setAddingTagToId(null);
      toast.success("Tag added");
    } catch (error) {
      toast.error("Failed to add tag");
    }
  };

  const handleRemoveTag = async (id: string, tagToRemove: string) => {
    try {
      const conversation = conversations.find(c => c.id === id);
      if (!conversation) return;

      const updatedTags = conversation.tags.filter(t => t !== tagToRemove);
      
      const { error } = await supabase
        .from("conversations")
        .update({ tags: updatedTags })
        .eq("id", id);

      if (error) throw error;
      fetchConversations();
      toast.success("Tag removed");
    } catch (error) {
      toast.error("Failed to remove tag");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", id);

      if (error) throw error;

      if (currentConversationId === id) {
        onNewConversation();
      }
      fetchConversations();
      toast.success("Deleted");
    } catch (error: any) {
      toast.error("Failed to delete");
    }
  };

  const startEdit = (id: string, title: string) => {
    setEditingId(id);
    setEditTitle(title || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditTitle("");
  };

  const saveEdit = async (id: string) => {
    if (!editTitle.trim()) {
      cancelEdit();
      return;
    }

    try {
      const { error } = await supabase
        .from("conversations")
        .update({ title: editTitle.trim() })
        .eq("id", id);

      if (error) throw error;
      fetchConversations();
      toast.success("Renamed");
    } catch (error: any) {
      toast.error("Failed to rename");
    } finally {
      cancelEdit();
    }
  };

  // Batch operations
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
    const filteredConvs = conversations.filter(c => showArchived || !c.archived);
    setSelectedIds(new Set(filteredConvs.map(c => c.id)));
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
      
      if (currentConversationId && selectedIds.has(currentConversationId)) {
        onNewConversation();
      }
      
      fetchConversations();
      clearSelection();
      toast.success(`Deleted ${selectedIds.size}`);
    } catch (error) {
      toast.error("Failed to delete");
    }
  };

  const bulkArchive = async () => {
    if (selectedIds.size === 0) return;
    
    try {
      const { error} = await supabase
        .from("conversations")
        .update({ archived: true })
        .in("id", Array.from(selectedIds));

      if (error) throw error;
      
      fetchConversations();
      clearSelection();
      toast.success(`Archived ${selectedIds.size}`);
    } catch (error) {
      toast.error("Failed to archive");
    }
  };

  const bulkExport = async () => {
    if (selectedIds.size === 0) return;

    try {
      const exportData = await Promise.all(
        Array.from(selectedIds).map(async (convId) => {
          const { data: messages } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", convId)
            .order("created_at", { ascending: true });

          const conv = conversations.find(c => c.id === convId);
          return {
            conversation: conv,
            messages: messages || [],
          };
        })
      );

      const dataStr = JSON.stringify(exportData, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `conversations-${new Date().toISOString()}.json`;
      link.click();
      URL.revokeObjectURL(url);
      
      clearSelection();
      toast.success("Exported");
    } catch (error) {
      toast.error("Export failed");
    }
  };

  const filteredConversations = conversations.filter(c => 
    showArchived ? c.archived : !c.archived
  );

  if (loading) {
    return (
      <div className="w-full md:w-80 border-r border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="w-14 border-r border-border bg-card flex flex-col items-center py-4 gap-2">
        <Button
          onClick={onToggleCollapse}
          size="icon"
          variant="ghost"
          className="h-12 w-12 touch-target"
        >
          <ChevronLeft className="h-5 w-5 rotate-180" />
        </Button>
        <Button
          onClick={onNewConversation}
          size="icon"
          className="h-12 w-12 bg-primary hover:bg-primary/90 text-primary-foreground touch-target"
        >
          <Plus className="h-5 w-5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full md:w-80 border-r border-border bg-card flex flex-col">
      <div className="p-4 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          {onToggleCollapse && (
            <Button
              onClick={onToggleCollapse}
              size="icon"
              variant="ghost"
              className="h-10 w-10 md:hidden"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}
          <Button
            onClick={onNewConversation}
            className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground h-12 touch-target"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Chat
          </Button>
        </div>

        {selectionMode ? (
          <div className="flex gap-2">
            <Button onClick={selectAll} size="sm" variant="outline" className="flex-1 touch-target">
              Select All
            </Button>
            <Button onClick={clearSelection} size="sm" variant="outline" className="flex-1 touch-target">
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button 
              onClick={() => setSelectionMode(true)} 
              size="sm" 
              variant="outline"
              className="flex-1 touch-target"
            >
              Select
            </Button>
            <Button
              onClick={() => setShowArchived(!showArchived)}
              size="sm"
              variant="outline"
              className="flex-1 touch-target"
            >
              <Archive className="w-4 h-4 mr-1" />
              {showArchived ? "Active" : "Archived"}
            </Button>
          </div>
        )}

        {selectionMode && selectedIds.size > 0 && (
          <div className="flex gap-2">
            <Button onClick={bulkArchive} size="sm" variant="secondary" className="flex-1 touch-target">
              <Archive className="w-3 h-3 mr-1" />
              Archive
            </Button>
            <Button onClick={bulkExport} size="sm" variant="secondary" className="flex-1 touch-target">
              <Download className="w-3 h-3 mr-1" />
              Export
            </Button>
            <Button onClick={bulkDelete} size="sm" variant="destructive" className="flex-1 touch-target">
              <Trash2 className="w-3 h-3 mr-1" />
              Delete
            </Button>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {filteredConversations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {showArchived ? "No archived conversations" : "No conversations yet"}
            </p>
          ) : (
            filteredConversations.map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  "group relative p-3 rounded-lg border transition-all touch-target min-h-[48px]",
                  currentConversationId === conv.id
                    ? "bg-primary/10 border-primary"
                    : "bg-card border-border hover:border-primary/50",
                  selectionMode && "cursor-pointer"
                )}
                onClick={() => {
                  if (selectionMode) {
                    toggleSelection(conv.id);
                  } else if (!editingId) {
                    onSelectConversation(conv.id);
                  }
                }}
              >
                <div className="flex items-start gap-2">
                  {selectionMode && (
                    <Checkbox
                      checked={selectedIds.has(conv.id)}
                      onCheckedChange={() => toggleSelection(conv.id)}
                      className="mt-1"
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    {editingId === conv.id ? (
                      <div className="flex gap-1">
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(conv.id);
                            if (e.key === "Escape") cancelEdit();
                          }}
                          className="h-8 text-sm"
                          autoFocus
                        />
                        <Button size="icon" variant="ghost" onClick={() => saveEdit(conv.id)} className="h-8 w-8">
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={cancelEdit} className="h-8 w-8">
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mb-1">
                          {conv.pinned && <Pin className="h-3 w-3 text-primary" />}
                          <p
                            className="text-sm font-medium text-foreground truncate cursor-pointer hover:text-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              startEdit(conv.id, conv.title);
                            }}
                          >
                            {conv.title || "New Conversation"}
                          </p>
                        </div>
                        
                        {conv.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1">
                            {conv.tags.map((tag) => (
                              <Badge
                                key={tag}
                                variant="secondary"
                                className="text-xs cursor-pointer hover:bg-destructive hover:text-destructive-foreground"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveTag(conv.id, tag);
                                }}
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground">
                          {new Date(conv.updated_at).toLocaleDateString()}
                        </p>
                      </>
                    )}
                  </div>

                  {!selectionMode && !editingId && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity touch-target"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48 bg-popover z-50">
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          handleTogglePin(conv.id, conv.pinned);
                        }}>
                          <Pin className="h-4 w-4 mr-2" />
                          {conv.pinned ? "Unpin" : "Pin"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          setAddingTagToId(conv.id);
                        }}>
                          <Tag className="h-4 w-4 mr-2" />
                          Add Tag
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          startEdit(conv.id, conv.title);
                        }}>
                          <Edit2 className="h-4 w-4 mr-2" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={(e) => {
                          e.stopPropagation();
                          handleToggleArchive(conv.id, conv.archived);
                        }}>
                          <Archive className="h-4 w-4 mr-2" />
                          {conv.archived ? "Unarchive" : "Archive"}
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(conv.id);
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>

                {addingTagToId === conv.id && (
                  <div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddTag(conv.id, newTag);
                        if (e.key === "Escape") {
                          setAddingTagToId(null);
                          setNewTag("");
                        }
                      }}
                      placeholder="Tag name"
                      className="h-8 text-xs"
                      autoFocus
                    />
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => handleAddTag(conv.id, newTag)}
                      className="h-8 w-8"
                    >
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => {
                        setAddingTagToId(null);
                        setNewTag("");
                      }}
                      className="h-8 w-8"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
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
