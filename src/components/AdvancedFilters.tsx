import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Filter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import ImportanceFilter from "./ImportanceFilter";

export interface AdvancedFilterOptions {
  provider?: string;
  model?: string;
  minLength?: number;
  maxLength?: number;
  minDuration?: number;
  maxDuration?: number;
  minImportance?: number;
  maxImportance?: number;
}

interface AdvancedFiltersProps {
  onFilterChange: (filters: AdvancedFilterOptions) => void;
  currentFilters: AdvancedFilterOptions;
}

const AdvancedFilters = ({ onFilterChange, currentFilters }: AdvancedFiltersProps) => {
  const [open, setOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState<AdvancedFilterOptions>(currentFilters);

  const providers = [
    { value: "all", label: "All Providers" },
    { value: "openai", label: "OpenAI" },
    { value: "google", label: "Google" },
  ];

  const models = [
    { value: "all", label: "All Models" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { value: "gemini-pro", label: "Gemini Pro" },
    { value: "gemini-flash", label: "Gemini Flash" },
  ];

  const handleApply = () => {
    const cleanedFilters: AdvancedFilterOptions = {};
    
    if (localFilters.provider && localFilters.provider !== "all") {
      cleanedFilters.provider = localFilters.provider;
    }
    if (localFilters.model && localFilters.model !== "all") {
      cleanedFilters.model = localFilters.model;
    }
    if (localFilters.minLength !== undefined && localFilters.minLength > 0) {
      cleanedFilters.minLength = localFilters.minLength;
    }
    if (localFilters.maxLength !== undefined && localFilters.maxLength > 0) {
      cleanedFilters.maxLength = localFilters.maxLength;
    }
    if (localFilters.minDuration !== undefined && localFilters.minDuration > 0) {
      cleanedFilters.minDuration = localFilters.minDuration;
    }
    if (localFilters.maxDuration !== undefined && localFilters.maxDuration > 0) {
      cleanedFilters.maxDuration = localFilters.maxDuration;
    }
    if (localFilters.minImportance !== undefined && localFilters.minImportance > 0) {
      cleanedFilters.minImportance = localFilters.minImportance;
    }
    if (localFilters.maxImportance !== undefined && localFilters.maxImportance < 10) {
      cleanedFilters.maxImportance = localFilters.maxImportance;
    }

    onFilterChange(cleanedFilters);
    setOpen(false);
  };

  const handleReset = () => {
    const resetFilters: AdvancedFilterOptions = {};
    setLocalFilters(resetFilters);
    onFilterChange(resetFilters);
    setOpen(false);
  };

  const activeFilterCount = Object.keys(currentFilters).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="border-border hover:bg-secondary relative">
          <Filter className="w-4 h-4 mr-2" />
          Advanced Filters
          {activeFilterCount > 0 && (
            <Badge variant="default" className="ml-2 bg-primary text-primary-foreground">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 bg-card border-border" align="start">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-foreground">Advanced Filters</h4>
            {activeFilterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                className="text-xs h-7"
              >
                <X className="w-3 h-3 mr-1" />
                Reset
              </Button>
            )}
          </div>

          {/* Provider Filter */}
          <div className="space-y-2">
            <Label className="text-sm text-foreground">AI Provider</Label>
            <Select
              value={localFilters.provider || "all"}
              onValueChange={(value) => setLocalFilters({ ...localFilters, provider: value })}
            >
              <SelectTrigger className="bg-input border-border">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.value} value={provider.value}>
                    {provider.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model Filter */}
          <div className="space-y-2">
            <Label className="text-sm text-foreground">Model</Label>
            <Select
              value={localFilters.model || "all"}
              onValueChange={(value) => setLocalFilters({ ...localFilters, model: value })}
            >
              <SelectTrigger className="bg-input border-border">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model.value} value={model.value}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Message Length Filter */}
          <div className="space-y-2">
            <Label className="text-sm text-foreground">Message Length (characters)</Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Min</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={localFilters.minLength || ""}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      minLength: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="bg-input border-border"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Max</Label>
                <Input
                  type="number"
                  placeholder="∞"
                  value={localFilters.maxLength || ""}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      maxLength: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="bg-input border-border"
                />
              </div>
            </div>
          </div>

          {/* Conversation Duration Filter */}
          <div className="space-y-2">
            <Label className="text-sm text-foreground">Conversation Duration (minutes)</Label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Min</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={localFilters.minDuration || ""}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      minDuration: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="bg-input border-border"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Max</Label>
                <Input
                  type="number"
                  placeholder="∞"
                  value={localFilters.maxDuration || ""}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      maxDuration: e.target.value ? parseInt(e.target.value) : undefined,
                    })
                  }
                  className="bg-input border-border"
                />
              </div>
            </div>
          </div>

          {/* Importance Score Filter */}
          <div className="space-y-2 pt-2 border-t border-border">
            <ImportanceFilter
              minImportance={localFilters.minImportance ?? 0}
              maxImportance={localFilters.maxImportance ?? 10}
              onMinChange={(value) => setLocalFilters({ ...localFilters, minImportance: value })}
              onMaxChange={(value) => setLocalFilters({ ...localFilters, maxImportance: value })}
              onReset={() => setLocalFilters({ ...localFilters, minImportance: undefined, maxImportance: undefined })}
            />
          </div>

          {/* Apply Button */}
          <Button
            onClick={handleApply}
            className="w-full bg-primary hover:bg-primary-glow text-primary-foreground"
          >
            Apply Filters
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default AdvancedFilters;
