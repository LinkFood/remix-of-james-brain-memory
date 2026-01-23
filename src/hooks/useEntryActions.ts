/**
 * useEntryActions - Entry CRUD operations hook
 * 
 * Provides standardized star, archive, delete, and list item toggle operations.
 */

import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { Entry } from "@/components/EntryCard";
import type { ListItem } from "@/types";

interface UseEntryActionsOptions {
  onEntryUpdate?: (entryId: string, updates: Partial<Entry>) => void;
  onEntryRemove?: (entryId: string) => void;
  onStatsUpdate?: (entryId: string, action: 'delete') => void;
}

interface UseEntryActionsReturn {
  toggleStar: (entryId: string, starred: boolean) => Promise<void>;
  toggleArchive: (entryId: string) => Promise<void>;
  deleteEntry: (entryId: string) => Promise<void>;
  toggleListItem: (entryId: string, listItems: ListItem[], itemIndex: number, checked: boolean) => Promise<void>;
}

export function useEntryActions({
  onEntryUpdate,
  onEntryRemove,
  onStatsUpdate,
}: UseEntryActionsOptions = {}): UseEntryActionsReturn {

  const toggleStar = useCallback(async (entryId: string, starred: boolean) => {
    try {
      const { error } = await supabase
        .from("entries")
        .update({ starred })
        .eq("id", entryId);

      if (error) throw error;

      onEntryUpdate?.(entryId, { starred });
      toast.success(starred ? "Starred" : "Unstarred");
    } catch (error) {
      console.error("Failed to toggle star:", error);
      toast.error("Failed to update");
    }
  }, [onEntryUpdate]);

  const toggleArchive = useCallback(async (entryId: string) => {
    try {
      const { error } = await supabase
        .from("entries")
        .update({ archived: true })
        .eq("id", entryId);

      if (error) throw error;

      onEntryRemove?.(entryId);
      toast.success("Archived");
    } catch (error) {
      console.error("Failed to archive:", error);
      toast.error("Failed to archive");
    }
  }, [onEntryRemove]);

  const deleteEntry = useCallback(async (entryId: string) => {
    try {
      const { error } = await supabase
        .from("entries")
        .delete()
        .eq("id", entryId);

      if (error) throw error;

      onEntryRemove?.(entryId);
      onStatsUpdate?.(entryId, 'delete');
      toast.success("Deleted");
    } catch (error) {
      console.error("Failed to delete:", error);
      toast.error("Failed to delete");
    }
  }, [onEntryRemove, onStatsUpdate]);

  const toggleListItem = useCallback(async (
    entryId: string, 
    listItems: ListItem[], 
    itemIndex: number, 
    checked: boolean
  ) => {
    try {
      const updatedItems = [...listItems];
      updatedItems[itemIndex] = { ...updatedItems[itemIndex], checked };

      const { error } = await supabase
        .from("entries")
        .update({ list_items: JSON.parse(JSON.stringify(updatedItems)) })
        .eq("id", entryId);

      if (error) throw error;

      onEntryUpdate?.(entryId, { list_items: updatedItems });
    } catch (error) {
      console.error("Failed to update list item:", error);
      toast.error("Failed to update item");
    }
  }, [onEntryUpdate]);

  return {
    toggleStar,
    toggleArchive,
    deleteEntry,
    toggleListItem,
  };
}
