import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Star } from "lucide-react";

interface ImportanceFilterProps {
  minImportance: number;
  maxImportance: number;
  onMinChange: (value: number) => void;
  onMaxChange: (value: number) => void;
  onReset: () => void;
}

const getImportanceLabel = (score: number): string => {
  if (score <= 2) return "Trivial";
  if (score <= 4) return "Low";
  if (score <= 6) return "Medium";
  if (score <= 8) return "High";
  return "Critical";
};

const getImportanceColor = (score: number): string => {
  if (score <= 2) return "bg-muted text-muted-foreground";
  if (score <= 4) return "bg-blue-500/10 text-blue-500 border-blue-500/20";
  if (score <= 6) return "bg-yellow-500/10 text-yellow-500 border-yellow-500/20";
  if (score <= 8) return "bg-orange-500/10 text-orange-500 border-orange-500/20";
  return "bg-red-500/10 text-red-500 border-red-500/20";
};

export default function ImportanceFilter({
  minImportance,
  maxImportance,
  onMinChange,
  onMaxChange,
  onReset,
}: ImportanceFilterProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          <Star className="w-4 h-4" />
          Importance Score
        </Label>
        {(minImportance > 0 || maxImportance < 10) && (
          <Button onClick={onReset} variant="ghost" size="sm">
            Reset
          </Button>
        )}
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm text-muted-foreground">Minimum</Label>
            <Badge variant="outline" className={getImportanceColor(minImportance)}>
              {minImportance} - {getImportanceLabel(minImportance)}
            </Badge>
          </div>
          <Slider
            value={[minImportance]}
            onValueChange={(values) => onMinChange(values[0])}
            min={0}
            max={10}
            step={1}
            className="w-full"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm text-muted-foreground">Maximum</Label>
            <Badge variant="outline" className={getImportanceColor(maxImportance)}>
              {maxImportance} - {getImportanceLabel(maxImportance)}
            </Badge>
          </div>
          <Slider
            value={[maxImportance]}
            onValueChange={(values) => onMaxChange(values[0])}
            min={0}
            max={10}
            step={1}
            className="w-full"
          />
        </div>
      </div>

      <div className="pt-2 border-t border-border">
        <div className="text-xs text-muted-foreground space-y-1">
          <div className="flex justify-between">
            <span>0-2: Trivial</span>
            <span>3-4: Low</span>
          </div>
          <div className="flex justify-between">
            <span>5-6: Medium</span>
            <span>7-8: High</span>
          </div>
          <div className="text-center">9-10: Critical</div>
        </div>
      </div>
    </div>
  );
}

export { getImportanceLabel, getImportanceColor };
