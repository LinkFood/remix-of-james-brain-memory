import { Brain } from "lucide-react";
import { Card } from "@/components/ui/card";

interface MemoryInjectionBannerProps {
  memories: Array<{
    content: string;
    importance_score?: number;
  }>;
}

export const MemoryInjectionBanner = ({ memories }: MemoryInjectionBannerProps) => {
  if (!memories || memories.length === 0) return null;

  return (
    <Card className="mb-3 p-4 bg-primary/5 border-primary/20">
      <div className="flex items-start gap-3">
        <Brain className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground mb-2">
            🔮 James Brain recalled {memories.length} {memories.length === 1 ? 'memory' : 'memories'}:
          </p>
          <ul className="space-y-1.5">
            {memories.map((memory, idx) => (
              <li key={idx} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-primary">•</span>
                <span className="flex-1">{memory.content.substring(0, 150)}{memory.content.length > 150 ? '...' : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
};
