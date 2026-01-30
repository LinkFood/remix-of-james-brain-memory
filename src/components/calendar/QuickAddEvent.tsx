import { useState } from "react";
import { format } from "date-fns";
import { CalendarPlus, Clock, Bell, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface QuickAddEventProps {
  userId: string;
  selectedDate: Date;
  onClose: () => void;
  onEventAdded?: () => void;
}

const REMINDER_OPTIONS = [
  { value: "0", label: "No reminder" },
  { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
];

export function QuickAddEvent({ userId, selectedDate, onClose, onEventAdded }: QuickAddEventProps) {
  const [content, setContent] = useState("");
  const [time, setTime] = useState("");
  const [reminderMinutes, setReminderMinutes] = useState("0");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      toast.error("Please enter what's happening");
      return;
    }

    setSaving(true);
    try {
      const eventDate = format(selectedDate, "yyyy-MM-dd");
      const reminderValue = parseInt(reminderMinutes);

      const { error } = await supabase.from("entries").insert({
        user_id: userId,
        content: content.trim(),
        title: content.trim().slice(0, 60),
        content_type: "event",
        event_date: eventDate,
        event_time: time || null,
        reminder_minutes: reminderValue > 0 ? reminderValue : null,
        source: "calendar",
        tags: ["calendar"],
      });

      if (error) throw error;

      toast.success("Event added");
      onEventAdded?.();
      onClose();
    } catch (error: any) {
      toast.error(error.message || "Failed to add event");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border bg-muted/30 p-4">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarPlus className="h-4 w-4 text-primary" />
            <span>Add to {format(selectedDate, "MMM d")}</span>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} className="h-6 w-6">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Input
          placeholder="What's happening?"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          autoFocus
          className="bg-background"
        />

        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[120px]">
            <Label htmlFor="time" className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
              <Clock className="h-3 w-3" />
              Time
            </Label>
            <Input
              id="time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="bg-background h-9"
            />
          </div>

          <div className="flex-1 min-w-[160px]">
            <Label className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
              <Bell className="h-3 w-3" />
              Reminder
            </Label>
            <Select value={reminderMinutes} onValueChange={setReminderMinutes}>
              <SelectTrigger className="bg-background h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REMINDER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || !content.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}
