import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  section: string;
  expanded: boolean;
  onToggle: (section: string) => void;
  color?: string;
}

const SectionHeader = ({
  title,
  icon,
  count,
  section,
  expanded,
  onToggle,
  color,
}: SectionHeaderProps) => (
  <button
    onClick={() => onToggle(section)}
    className="flex items-center justify-between w-full p-3 hover:bg-muted/50 rounded-lg transition-colors"
  >
    <div className="flex items-center gap-2">
      <div className={cn("p-1.5 rounded-md", color || "bg-muted")}>{icon}</div>
      <span className="font-medium">{title}</span>
      <Badge variant="secondary" className="text-xs">
        {count}
      </Badge>
    </div>
    {expanded ? (
      <ChevronDown className="w-4 h-4 text-muted-foreground" />
    ) : (
      <ChevronRight className="w-4 h-4 text-muted-foreground" />
    )}
  </button>
);

export default SectionHeader;
