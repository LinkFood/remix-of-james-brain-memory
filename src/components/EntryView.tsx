import { useState } from "react";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Code,
  List,
  Lightbulb,
  Link,
  User,
  Calendar,
  Bell,
  FileText,
  Star,
  Archive,
  Pencil,
  Trash2,
  X,
  Check,
  Clock,
  Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { parseListItems } from "@/lib/parseListItems";
import { useSignedUrl } from "@/hooks/use-signed-url";
import type { Entry } from "./EntryCard";

interface EntryViewProps {
  entry: Entry | null;
  open: boolean;
  onClose: () => void;
  onUpdate?: (entry: Entry) => void;
  onDelete?: (entryId: string) => void;
}

const typeIcons: Record<string, React.ReactNode> = {
  code: <Code className="w-5 h-5" />,
  list: <List className="w-5 h-5" />,
  idea: <Lightbulb className="w-5 h-5" />,
  link: <Link className="w-5 h-5" />,
  contact: <User className="w-5 h-5" />,
  event: <Calendar className="w-5 h-5" />,
  reminder: <Bell className="w-5 h-5" />,
  note: <FileText className="w-5 h-5" />,
  image: <ImageIcon className="w-5 h-5" />,
};

const typeColors: Record<string, string> = {
  code: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  list: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  idea: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  link: "bg-green-500/10 text-green-500 border-green-500/20",
  contact: "bg-pink-500/10 text-pink-500 border-pink-500/20",
  event: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  reminder: "bg-red-500/10 text-red-500 border-red-500/20",
  note: "bg-gray-500/10 text-gray-500 border-gray-500/20",
  image: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20",
};

// Helper to transform Supabase response to Entry type
const toEntry = (data: any): Entry => ({
  ...data,
  tags: data.tags || [],
  extracted_data: (data.extracted_data as Record<string, unknown>) || {},
  list_items: parseListItems(data.list_items),
});

const EntryView = ({ entry, open, onClose, onUpdate, onDelete }: EntryViewProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [listItems, setListItems] = useState<Array<{ text: string; checked: boolean }>>([]);
  const [saving, setSaving] = useState(false);
  
  // Get signed URL for private storage images
  const { signedUrl: imageUrl } = useSignedUrl(entry?.image_url);

  if (!entry) return null;

  const icon = typeIcons[entry.content_type] || typeIcons.note;
  const colorClass = typeColors[entry.content_type] || typeColors.note;

  const startEditing = () => {
    setEditTitle(entry.title || "");
    setEditContent(entry.content);
    setListItems([...entry.list_items]);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditTitle("");
    setEditContent("");
    setListItems([]);
  };

  const handleSave = async () => {
    if (!editContent.trim()) {
      toast.error("Content cannot be empty");
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("entries")
        .update({
          title: editTitle.trim() || null,
          content: editContent.trim(),
          list_items: JSON.parse(JSON.stringify(listItems)),
          updated_at: new Date().toISOString(),
        })
        .eq("id", entry.id)
        .select()
        .single();

      if (error) throw error;

      toast.success("Entry updated");
      setIsEditing(false);
      if (onUpdate && data) {
        onUpdate(toEntry(data));
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleListItem = async (index: number, checked: boolean) => {
    const newItems = [...entry.list_items];
    newItems[index] = { ...newItems[index], checked };

    try {
      const { data, error } = await supabase
        .from("entries")
        .update({ list_items: JSON.parse(JSON.stringify(newItems)) })
        .eq("id", entry.id)
        .select()
        .single();

      if (error) throw error;

      if (onUpdate && data) {
        onUpdate(toEntry(data));
      }
    } catch (error) {
      toast.error("Failed to update item");
    }
  };

  const handleStar = async () => {
    try {
      const { data, error } = await supabase
        .from("entries")
        .update({ starred: !entry.starred })
        .eq("id", entry.id)
        .select()
        .single();

      if (error) throw error;

      toast.success(entry.starred ? "Unstarred" : "Starred");
      if (onUpdate && data) {
        onUpdate(toEntry(data));
      }
    } catch (error) {
      toast.error("Failed to update");
    }
  };

  const handleArchive = async () => {
    try {
      const { error } = await supabase
        .from("entries")
        .update({ archived: true })
        .eq("id", entry.id);

      if (error) throw error;

      toast.success("Archived");
      onClose();
      if (onDelete) {
        onDelete(entry.id);
      }
    } catch (error) {
      toast.error("Failed to archive");
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this entry? This cannot be undone.")) {
      return;
    }

    try {
      const { error } = await supabase.from("entries").delete().eq("id", entry.id);

      if (error) throw error;

      toast.success("Deleted");
      onClose();
      if (onDelete) {
        onDelete(entry.id);
      }
    } catch (error) {
      toast.error("Failed to delete");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()} modal={false}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" allowOverlayPassthrough>
        <DialogHeader className="shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className={cn("p-2 rounded-lg border", colorClass)}>{icon}</div>
              <div>
                {isEditing ? (
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title (optional)"
                    className="text-lg font-semibold h-8"
                  />
                ) : (
                  <DialogTitle className="text-lg">
                    {entry.title || "Untitled"}
                  </DialogTitle>
                )}
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                  <Clock className="w-3 h-3" />
                  <span>{format(new Date(entry.created_at), "MMM d, yyyy 'at' h:mm a")}</span>
                  {entry.content_subtype && (
                    <>
                      <span>·</span>
                      <span className="capitalize">{entry.content_subtype}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1">
              {isEditing ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="default"
                    size="icon"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    <Check className="w-4 h-4" />
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="icon" onClick={startEditing}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleStar}
                    className={cn(entry.starred && "text-yellow-500")}
                  >
                    <Star
                      className={cn("w-4 h-4", entry.starred && "fill-yellow-500")}
                    />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={handleArchive}>
                    <Archive className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleDelete}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto py-4">
          {/* Importance Score */}
          {entry.importance_score !== null && (
            <div className="flex items-center gap-2 mb-4">
              <Badge
                variant="outline"
                className={cn(
                  entry.importance_score >= 7
                    ? "bg-orange-500/10 text-orange-500 border-orange-500/20"
                    : "bg-muted"
                )}
              >
                Importance: {entry.importance_score}/10
              </Badge>
            </div>
          )}

          {/* Image Display */}
          {imageUrl && (
            <div className="mb-4 rounded-lg overflow-hidden border border-border">
              <img 
                src={imageUrl} 
                alt={entry.title || 'Uploaded image'}
                className="w-full max-h-96 object-contain bg-muted/30"
              />
            </div>
          )}

          {/* Main Content */}
          {isEditing ? (
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[200px] font-mono text-sm"
            />
          ) : entry.content_type === "list" && entry.list_items?.length > 0 ? (
            <div className="space-y-2">
              {entry.list_items.map((item, index) => (
                <div key={index} className="flex items-center gap-3 p-2 hover:bg-muted/50 rounded-md">
                  <Checkbox
                    checked={item.checked}
                    onCheckedChange={(checked) =>
                      handleToggleListItem(index, checked as boolean)
                    }
                  />
                  <span
                    className={cn(
                      "flex-1",
                      item.checked && "line-through text-muted-foreground"
                    )}
                  >
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
          ) : entry.content_type === "code" ? (
            <pre className="bg-muted/50 p-4 rounded-lg overflow-x-auto">
              <code className="text-sm font-mono whitespace-pre-wrap">
                {entry.content}
              </code>
            </pre>
          ) : entry.content ? (
            <div className="whitespace-pre-wrap text-sm">{entry.content}</div>
          ) : null}

          {/* Edit list items */}
          {isEditing && entry.content_type === "list" && (
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium">List Items</p>
              {listItems.map((item, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Checkbox
                    checked={item.checked}
                    onCheckedChange={(checked) => {
                      const newItems = [...listItems];
                      newItems[index] = { ...item, checked: checked as boolean };
                      setListItems(newItems);
                    }}
                  />
                  <Input
                    value={item.text}
                    onChange={(e) => {
                      const newItems = [...listItems];
                      newItems[index] = { ...item, text: e.target.value };
                      setListItems(newItems);
                    }}
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setListItems(listItems.filter((_, i) => i !== index));
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setListItems([...listItems, { text: "", checked: false }])
                }
              >
                Add Item
              </Button>
            </div>
          )}

          {/* Tags */}
          {entry.tags && entry.tags.length > 0 && (
            <div className="mt-6 pt-4 border-t">
              <p className="text-sm text-muted-foreground mb-2">Tags</p>
              <div className="flex flex-wrap gap-2">
                {entry.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="mt-6 pt-4 border-t text-xs text-muted-foreground space-y-1">
            <p>Created: {format(new Date(entry.created_at), "PPpp")}</p>
            <p>Updated: {format(new Date(entry.updated_at), "PPpp")}</p>
            <p>Source: {entry.source}</p>
            <p>ID: {entry.id}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default EntryView;
