import { useSwipeable } from "react-swipeable";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Star, Copy, Trash2, Edit2, Check, X, MoreVertical } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MemoryInjectionBanner } from "@/components/MemoryInjectionBanner";
import { getImportanceLabel, getImportanceColor } from "./ImportanceFilter";

interface Memory {
  content: string;
  snippet?: string;
  similarity?: number;
  importance?: number | null;
  importance_score?: number | null;
  created_at?: string | null;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  importance_score?: number | null;
  starred?: boolean;
  edited?: boolean;
  edit_history?: any[];
  memoriesUsed?: number;
  memories?: Memory[];
}

interface SwipeableMessageProps {
  message: Message;
  editingMessageId: string | null;
  editContent: string;
  setEditContent: (content: string) => void;
  onDelete: (id: string) => void;
  onStar: (id: string, starred: boolean) => void;
  onCopy: (content: string) => void;
  onStartEdit: (id: string, content: string) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
}

export const SwipeableMessage = ({
  message: msg,
  editingMessageId,
  editContent,
  setEditContent,
  onDelete,
  onStar,
  onCopy,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
}: SwipeableMessageProps) => {
  const swipeHandlers = useSwipeable({
    onSwipedLeft: () => {
      if (msg.role === "user" || msg.role === "assistant") {
        onDelete(msg.id);
      }
    },
    onSwipedRight: () => {
      if (msg.role === "user" || msg.role === "assistant") {
        onStar(msg.id, msg.starred || false);
      }
    },
    trackMouse: false,
    delta: 50,
  });

  return (
    <div {...swipeHandlers}>
      {msg.role === "assistant" && msg.memories && msg.memories.length > 0 && (
        <MemoryInjectionBanner memories={msg.memories} />
      )}
      <div
        className={cn(
          "flex group animate-fade-in",
          msg.role === "user" ? "justify-end" : "justify-start"
        )}
      >
        <div
          className={cn(
            "max-w-[80%] rounded-2xl px-4 py-3 relative",
            msg.role === "user"
              ? "bg-primary text-primary-foreground shadow-glow"
              : "bg-secondary text-secondary-foreground"
          )}
        >
          {msg.starred && (
            <Star className="absolute -top-2 -right-2 h-4 w-4 text-primary fill-primary" />
          )}
          
          {editingMessageId === msg.id ? (
            <div className="space-y-2">
              <Input
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="min-h-[60px]"
                autoFocus
              />
              <div className="flex gap-1">
                <Button size="sm" onClick={() => onSaveEdit(msg.id)}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="outline" onClick={onCancelEdit}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-sm leading-relaxed mb-2 whitespace-pre-wrap">{msg.content}</p>
              {msg.edited && (
                <Badge variant="outline" className="text-xs mr-2">
                  Edited
                </Badge>
              )}
              {msg.importance_score !== null && msg.importance_score !== undefined && (
                <Badge 
                  variant="outline" 
                  className={`text-xs ${getImportanceColor(msg.importance_score)} mt-2`}
                >
                  {msg.importance_score} - {getImportanceLabel(msg.importance_score)}
                </Badge>
              )}
            </>
          )}

          <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6 touch-target">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover z-50">
                <DropdownMenuItem onClick={() => onCopy(msg.content)}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onStar(msg.id, msg.starred || false)}>
                  <Star className="h-4 w-4 mr-2" />
                  {msg.starred ? "Unstar" : "Star"}
                </DropdownMenuItem>
                {(msg.role === "user" || msg.role === "assistant") && (
                  <>
                    <DropdownMenuItem onClick={() => onStartEdit(msg.id, msg.content)}>
                      <Edit2 className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem 
                      onClick={() => onDelete(msg.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
};
