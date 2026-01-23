import { format } from "date-fns";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  MoreVertical,
  ExternalLink,
  Image as ImageIcon,
  Trash2
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useSignedUrl } from "@/hooks/use-signed-url";

export interface Entry {
  id: string;
  user_id: string;
  content: string;
  title: string | null;
  content_type: string;
  content_subtype: string | null;
  tags: string[];
  extracted_data: Record<string, unknown>;
  importance_score: number | null;
  list_items: Array<{ text: string; checked: boolean }>;
  source: string;
  starred: boolean;
  archived: boolean;
  image_url?: string | null;
  created_at: string;
  updated_at: string;
  _pending?: boolean; // For optimistic updates
}

interface EntryCardProps {
  entry: Entry;
  compact?: boolean;
  showContent?: boolean;
  onToggleListItem?: (entryId: string, itemIndex: number, checked: boolean) => void;
  onStar?: (entryId: string, starred: boolean) => void;
  onArchive?: (entryId: string) => void;
  onDelete?: (entryId: string) => void;
  onClick?: (entry: Entry) => void;
}

const typeIcons: Record<string, React.ReactNode> = {
  code: <Code className="w-4 h-4" />,
  list: <List className="w-4 h-4" />,
  idea: <Lightbulb className="w-4 h-4" />,
  link: <Link className="w-4 h-4" />,
  contact: <User className="w-4 h-4" />,
  event: <Calendar className="w-4 h-4" />,
  reminder: <Bell className="w-4 h-4" />,
  note: <FileText className="w-4 h-4" />,
  image: <ImageIcon className="w-4 h-4" />,
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

const EntryCard = ({
  entry,
  compact = false,
  showContent = true,
  onToggleListItem,
  onStar,
  onArchive,
  onDelete,
  onClick,
}: EntryCardProps) => {
  const icon = typeIcons[entry.content_type] || typeIcons.note;
  const colorClass = typeColors[entry.content_type] || typeColors.note;
  
  // Get signed URL for private storage images
  const { signedUrl: imageUrl } = useSignedUrl(entry.image_url);

  const truncatedContent =
    entry.content.length > 150
      ? entry.content.slice(0, 150) + "..."
      : entry.content;

  const handleCardClick = () => {
    if (onClick) {
      onClick(entry);
    }
  };

  const handleListItemToggle = (index: number, checked: boolean) => {
    if (onToggleListItem) {
      onToggleListItem(entry.id, index, checked);
    }
  };

  return (
    <Card
      className={cn(
        "group transition-all duration-200 hover:shadow-md",
        onClick && "cursor-pointer hover:border-primary/30",
        entry.starred && "border-yellow-500/30 bg-yellow-500/5",
        entry._pending && "opacity-60 animate-pulse pointer-events-none"
      )}
      onClick={handleCardClick}
    >
      <div className={cn("p-4", compact && "p-3")}>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className={cn("p-1.5 rounded-md border", colorClass)}>
              {icon}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm truncate">
                {entry.title || "Untitled"}
              </h3>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{format(new Date(entry.created_at), "MMM d, h:mm a")}</span>
                {entry.content_subtype && (
                  <>
                    <span>·</span>
                    <span className="capitalize">{entry.content_subtype}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {entry.importance_score !== null && entry.importance_score >= 7 && (
              <Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-500 border-orange-500/20">
                {entry.importance_score}/10
              </Badge>
            )}

            {entry.starred && (
              <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem
                  onClick={() => onStar?.(entry.id, !entry.starred)}
                >
                  <Star className="w-4 h-4 mr-2" />
                  {entry.starred ? "Unstar" : "Star"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onClick?.(entry)}>
                  <ExternalLink className="w-4 h-4 mr-2" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onArchive?.(entry.id)}
                  className="text-muted-foreground"
                >
                  <Archive className="w-4 h-4 mr-2" />
                  Archive
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onDelete?.(entry.id)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Content */}
        {showContent && (
          <div className="mt-2">
            {/* Image thumbnail */}
            {imageUrl && (
              <div className="mb-2 rounded-md overflow-hidden border border-border">
                <img 
                  src={imageUrl} 
                  alt={entry.title || 'Uploaded image'}
                  className="w-full h-32 object-cover"
                  loading="lazy"
                />
              </div>
            )}
            
            {entry.content_type === "list" && entry.list_items?.length > 0 ? (
              <div className="space-y-1.5">
                {entry.list_items.slice(0, compact ? 3 : 5).map((item, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={item.checked}
                      onCheckedChange={(checked) =>
                        handleListItemToggle(index, checked as boolean)
                      }
                      disabled={!onToggleListItem}
                    />
                    <span
                      className={cn(
                        "text-sm",
                        item.checked && "line-through text-muted-foreground"
                      )}
                    >
                      {item.text}
                    </span>
                  </div>
                ))}
                {entry.list_items.length > (compact ? 3 : 5) && (
                  <span className="text-xs text-muted-foreground">
                    +{entry.list_items.length - (compact ? 3 : 5)} more items
                  </span>
                )}
              </div>
            ) : entry.content_type === "code" ? (
              <pre className="text-xs bg-muted/50 p-2 rounded-md overflow-hidden font-mono">
                <code className="text-muted-foreground">
                  {compact ? truncatedContent : entry.content.slice(0, 300)}
                  {entry.content.length > 300 && !compact && "..."}
                </code>
              </pre>
            ) : entry.content_type === "image" && !entry.content ? (
              // Image-only entry with no text content
              null
            ) : (
              <p className="text-sm text-muted-foreground">
                {compact ? truncatedContent : entry.content.slice(0, 300)}
                {entry.content.length > 300 && !compact && "..."}
              </p>
            )}
          </div>
        )}

        {/* Tags */}
        {entry.tags && entry.tags.length > 0 && !compact && (
          <div className="flex flex-wrap gap-1 mt-3">
            {entry.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
            {entry.tags.length > 4 && (
              <Badge variant="secondary" className="text-xs">
                +{entry.tags.length - 4}
              </Badge>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

export default EntryCard;
