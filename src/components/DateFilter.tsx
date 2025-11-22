import { useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarIcon, X, Clock } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

interface DateFilterProps {
  onDateChange: (range: DateRange | null) => void;
  onThisDay?: () => void;
  showOnThisDay?: boolean;
}

const DateFilter = ({ onDateChange, onThisDay, showOnThisDay = false }: DateFilterProps) => {
  const [dateRange, setDateRange] = useState<DateRange>({ from: undefined, to: undefined });
  const [open, setOpen] = useState(false);

  const handleDateSelect = (range: DateRange | undefined) => {
    if (!range) {
      setDateRange({ from: undefined, to: undefined });
      onDateChange(null);
      return;
    }
    setDateRange(range);
    onDateChange(range);
  };

  const clearDates = () => {
    setDateRange({ from: undefined, to: undefined });
    onDateChange(null);
    setOpen(false);
  };

  const setPreset = (preset: string) => {
    const today = new Date();
    let from: Date;
    let to = today;

    switch (preset) {
      case "today":
        from = today;
        break;
      case "week":
        from = new Date(today);
        from.setDate(today.getDate() - 7);
        break;
      case "month":
        from = new Date(today);
        from.setMonth(today.getMonth() - 1);
        break;
      case "year":
        from = new Date(today);
        from.setFullYear(today.getFullYear() - 1);
        break;
      default:
        from = today;
    }

    const range = { from, to };
    setDateRange(range);
    onDateChange(range);
    setOpen(false);
  };

  const formatDateRange = () => {
    if (!dateRange.from) return "Pick date range";
    if (!dateRange.to) return format(dateRange.from, "PPP");
    return `${format(dateRange.from, "PPP")} - ${format(dateRange.to, "PPP")}`;
  };

  return (
    <div className="flex gap-2">
      {showOnThisDay && onThisDay && (
        <Button
          variant="outline"
          onClick={onThisDay}
          className="border-border hover:bg-secondary"
        >
          <Clock className="w-4 h-4 mr-2" />
          On This Day
        </Button>
      )}
      
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal border-border hover:bg-secondary",
              !dateRange.from && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {formatDateRange()}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 bg-card border-border" align="start">
          <div className="p-3 border-b border-border">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreset("today")}
                className="text-xs"
              >
                Today
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreset("week")}
                className="text-xs"
              >
                Last 7 Days
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreset("month")}
                className="text-xs"
              >
                Last Month
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPreset("year")}
                className="text-xs"
              >
                Last Year
              </Button>
              {(dateRange.from || dateRange.to) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearDates}
                  className="text-xs"
                >
                  <X className="w-3 h-3 mr-1" />
                  Clear
                </Button>
              )}
            </div>
          </div>
          <Calendar
            mode="range"
            selected={dateRange}
            onSelect={handleDateSelect}
            numberOfMonths={2}
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default DateFilter;
