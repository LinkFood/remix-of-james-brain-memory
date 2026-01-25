import { useState, useMemo, useCallback } from "react";
import { Tag, Edit2, Trash2, Merge, X, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import type { Entry } from "@/components/EntryCard";

interface TagManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: Entry[];
  userId: string;
  onTagsUpdated: () => void;
}

interface TagInfo {
  name: string;
  count: number;
}

export function TagManager({
  open,
  onOpenChange,
  entries,
  userId,
  onTagsUpdated,
}: TagManagerProps) {
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Calculate tag counts
  const tags = useMemo<TagInfo[]>(() => {
    const counts: Record<string, number> = {};
    entries.forEach((entry) => {
      (entry.tags || []).forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [entries]);

  const handleRenameStart = (tagName: string) => {
    setEditingTag(tagName);
    setNewTagName(tagName);
  };

  const handleRenameCancel = () => {
    setEditingTag(null);
    setNewTagName("");
  };

  const handleRenameSave = useCallback(async () => {
    if (!editingTag || !newTagName.trim() || editingTag === newTagName.trim()) {
      handleRenameCancel();
      return;
    }

    setLoading(true);
    try {
      // Get all entries with the old tag
      const { data: entriesToUpdate, error: fetchError } = await supabase
        .from("entries")
        .select("id, tags")
        .eq("user_id", userId)
        .contains("tags", [editingTag]);

      if (fetchError) throw fetchError;

      // Update each entry
      for (const entry of entriesToUpdate || []) {
        const newTags = (entry.tags || []).map((t: string) =>
          t === editingTag ? newTagName.trim() : t
        );
        // Remove duplicates
        const uniqueTags = [...new Set(newTags)];
        await supabase
          .from("entries")
          .update({ tags: uniqueTags })
          .eq("id", entry.id);
      }

      toast.success(`Renamed "${editingTag}" to "${newTagName.trim()}"`);
      onTagsUpdated();
      handleRenameCancel();
    } catch (error) {
      console.error("Failed to rename tag:", error);
      toast.error("Failed to rename tag");
    } finally {
      setLoading(false);
    }
  }, [editingTag, newTagName, userId, onTagsUpdated]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTag) return;

    setLoading(true);
    try {
      // Get all entries with the tag
      const { data: entriesToUpdate, error: fetchError } = await supabase
        .from("entries")
        .select("id, tags")
        .eq("user_id", userId)
        .contains("tags", [deleteTag]);

      if (fetchError) throw fetchError;

      // Remove tag from each entry
      for (const entry of entriesToUpdate || []) {
        const newTags = (entry.tags || []).filter((t: string) => t !== deleteTag);
        await supabase
          .from("entries")
          .update({ tags: newTags })
          .eq("id", entry.id);
      }

      toast.success(`Deleted tag "${deleteTag}"`);
      onTagsUpdated();
      setDeleteTag(null);
    } catch (error) {
      console.error("Failed to delete tag:", error);
      toast.error("Failed to delete tag");
    } finally {
      setLoading(false);
    }
  }, [deleteTag, userId, onTagsUpdated]);

  const handleMergeStart = (tag: string) => {
    if (!mergeSource) {
      setMergeSource(tag);
    } else if (tag !== mergeSource) {
      setMergeTarget(tag);
    }
  };

  const handleMergeCancel = () => {
    setMergeSource(null);
    setMergeTarget(null);
  };

  const handleMergeConfirm = useCallback(async () => {
    if (!mergeSource || !mergeTarget) return;

    setLoading(true);
    try {
      // Get all entries with the source tag
      const { data: entriesToUpdate, error: fetchError } = await supabase
        .from("entries")
        .select("id, tags")
        .eq("user_id", userId)
        .contains("tags", [mergeSource]);

      if (fetchError) throw fetchError;

      // Replace source tag with target tag
      for (const entry of entriesToUpdate || []) {
        const newTags = (entry.tags || []).map((t: string) =>
          t === mergeSource ? mergeTarget : t
        );
        // Remove duplicates
        const uniqueTags = [...new Set(newTags)];
        await supabase
          .from("entries")
          .update({ tags: uniqueTags })
          .eq("id", entry.id);
      }

      toast.success(`Merged "${mergeSource}" into "${mergeTarget}"`);
      onTagsUpdated();
      handleMergeCancel();
    } catch (error) {
      console.error("Failed to merge tags:", error);
      toast.error("Failed to merge tags");
    } finally {
      setLoading(false);
    }
  }, [mergeSource, mergeTarget, userId, onTagsUpdated]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="w-5 h-5" />
              Manage Tags
            </DialogTitle>
            <DialogDescription>
              Rename, merge, or delete tags across all your entries.
            </DialogDescription>
          </DialogHeader>

          {mergeSource && !mergeTarget && (
            <div className="p-3 bg-muted rounded-lg text-sm">
              <p>
                Select another tag to merge <strong>"{mergeSource}"</strong> into:
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleMergeCancel}
                className="mt-2"
              >
                Cancel merge
              </Button>
            </div>
          )}

          <ScrollArea className="h-[300px] pr-4">
            <div className="space-y-2">
              {tags.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No tags yet. Tags will appear here as you dump content.
                </p>
              ) : (
                tags.map((tag) => (
                  <div
                    key={tag.name}
                    className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${
                      mergeSource === tag.name
                        ? "bg-primary/10 border border-primary"
                        : "hover:bg-muted"
                    }`}
                  >
                    {editingTag === tag.name ? (
                      <>
                        <Input
                          value={newTagName}
                          onChange={(e) => setNewTagName(e.target.value)}
                          className="h-8 flex-1"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                          }}
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={handleRenameSave}
                          disabled={loading}
                        >
                          {loading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={handleRenameCancel}
                          disabled={loading}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Badge variant="secondary" className="flex-shrink-0">
                          {tag.name}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {tag.count} {tag.count === 1 ? "entry" : "entries"}
                        </span>
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => handleRenameStart(tag.name)}
                            title="Rename"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => handleMergeStart(tag.name)}
                            title="Merge"
                          >
                            <Merge className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => setDeleteTag(tag.name)}
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Merge Confirmation */}
      <AlertDialog
        open={!!mergeSource && !!mergeTarget}
        onOpenChange={(open) => !open && handleMergeCancel()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge Tags?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace all occurrences of <strong>"{mergeSource}"</strong>{" "}
              with <strong>"{mergeTarget}"</strong>. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleMergeConfirm} disabled={loading}>
              {loading ? "Merging..." : "Merge Tags"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTag}
        onOpenChange={(open) => !open && setDeleteTag(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tag?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the tag <strong>"{deleteTag}"</strong> from all
              entries. The entries themselves will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={loading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {loading ? "Deleting..." : "Delete Tag"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default TagManager;
