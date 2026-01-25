import { useState } from "react";
import { Archive, Trash2, Tag, CheckSquare, Square, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface BulkToolbarProps {
  selectedCount: number;
  allIds: string[];
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onExitSelectionMode: () => void;
  onBulkComplete: () => void;
}

export function BulkToolbar({
  selectedCount,
  allIds,
  onSelectAll,
  onClearSelection,
  onExitSelectionMode,
  onBulkComplete,
}: BulkToolbarProps) {
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Sync selectedIds from parent when needed
  const handleAction = async (
    action: "archive" | "delete" | "addTag",
    ids: string[],
    tag?: string
  ) => {
    if (ids.length === 0) return;

    setLoading(true);
    try {
      if (action === "archive") {
        const { error } = await supabase
          .from("entries")
          .update({ archived: true })
          .in("id", ids);
        if (error) throw error;
        toast.success(`Archived ${ids.length} entries`);
      } else if (action === "delete") {
        const { error } = await supabase
          .from("entries")
          .delete()
          .in("id", ids);
        if (error) throw error;
        toast.success(`Deleted ${ids.length} entries`);
      } else if (action === "addTag" && tag) {
        // Get current tags for each entry
        const { data: entries, error: fetchError } = await supabase
          .from("entries")
          .select("id, tags")
          .in("id", ids);
        if (fetchError) throw fetchError;

        // Update each entry with the new tag
        for (const entry of entries || []) {
          const currentTags = (entry.tags || []) as string[];
          if (!currentTags.includes(tag)) {
            await supabase
              .from("entries")
              .update({ tags: [...currentTags, tag] })
              .eq("id", entry.id);
          }
        }
        toast.success(`Added tag "${tag}" to ${ids.length} entries`);
      }

      onBulkComplete();
      onClearSelection();
    } catch (error) {
      console.error("Bulk action failed:", error);
      toast.error("Failed to complete action");
    } finally {
      setLoading(false);
      setDeleteConfirmOpen(false);
      setTagPopoverOpen(false);
      setNewTag("");
    }
  };

  const handleArchive = () => {
    const ids = Array.from(document.querySelectorAll('[data-selected="true"]')).map(
      (el) => el.getAttribute("data-entry-id") || ""
    ).filter(Boolean);
    handleAction("archive", ids);
  };

  const handleDeleteClick = () => {
    const ids = Array.from(document.querySelectorAll('[data-selected="true"]')).map(
      (el) => el.getAttribute("data-entry-id") || ""
    ).filter(Boolean);
    setSelectedIds(ids);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = () => {
    handleAction("delete", selectedIds);
  };

  const handleAddTag = () => {
    if (!newTag.trim()) return;
    const ids = Array.from(document.querySelectorAll('[data-selected="true"]')).map(
      (el) => el.getAttribute("data-entry-id") || ""
    ).filter(Boolean);
    handleAction("addTag", ids, newTag.trim());
  };

  if (selectedCount === 0) return null;

  return (
    <>
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-card border border-border rounded-xl shadow-lg p-3 flex items-center gap-3 animate-fade-in">
        {/* Selection info */}
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{selectedCount} selected</span>
        </div>

        {/* Divider */}
        <div className="h-6 w-px bg-border" />

        {/* Select All */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSelectAll(allIds)}
          disabled={loading}
        >
          <CheckSquare className="w-4 h-4 mr-1" />
          All
        </Button>

        {/* Clear */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          disabled={loading}
        >
          <Square className="w-4 h-4 mr-1" />
          None
        </Button>

        {/* Divider */}
        <div className="h-6 w-px bg-border" />

        {/* Archive */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleArchive}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Archive className="w-4 h-4 mr-1" />
          )}
          Archive
        </Button>

        {/* Add Tag */}
        <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" disabled={loading}>
              <Tag className="w-4 h-4 mr-1" />
              Tag
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="center">
            <div className="flex gap-2">
              <Input
                placeholder="Tag name"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddTag();
                }}
              />
              <Button size="sm" onClick={handleAddTag} disabled={!newTag.trim()}>
                Add
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Delete */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDeleteClick}
          disabled={loading}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="w-4 h-4 mr-1" />
          Delete
        </Button>

        {/* Divider */}
        <div className="h-6 w-px bg-border" />

        {/* Exit */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onExitSelectionMode}
          disabled={loading}
          className="h-8 w-8"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.length} entries?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected entries. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={loading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {loading ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default BulkToolbar;
